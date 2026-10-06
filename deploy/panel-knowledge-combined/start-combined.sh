#!/usr/bin/env bash
set -euo pipefail

# Create the config directory first so a missing bind-mount parent is not mistaken for a directory mount.
mkdir -p /app/panel/config "${KNOWLEDGE_DATA_DIR:-/data/knowledge}" "$(dirname "${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}")"

# Mount /app/panel/config/metadata-instances.json to provide multiple instances.
# In that case REMOTE_INSTANCE_* settings are optional and the supplied file is not overwritten.
INSTANCES_FILE="/app/panel/config/metadata-instances.json"
USER_PROVIDED_INSTANCES=0
if [[ -f "$INSTANCES_FILE" ]]; then
  USER_PROVIDED_INSTANCES=1
  echo "[start-combined] detected user-provided $INSTANCES_FILE; skipping env-based generation"
fi

if [[ "$USER_PROVIDED_INSTANCES" -ne 1 ]]; then
  : "${REMOTE_INSTANCE_URL:?REMOTE_INSTANCE_URL is required, e.g. http://host.docker.internal:8420 (or mount metadata-instances.json)}"
  : "${REMOTE_INSTANCE_KEY:?REMOTE_INSTANCE_KEY is required, e.g. local or admin gateway key (or mount metadata-instances.json)}"
fi

PANEL_PORT="${PANEL_PORT:-8125}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"
INSTANCE_ID="${REMOTE_INSTANCE_ID:-default}"
INSTANCE_NAME="${REMOTE_INSTANCE_NAME:-$INSTANCE_ID}"
KS_INTERNAL_URL="http://127.0.0.1:${KNOWLEDGE_PORT}"
# service_url must include /v3; context_proxy appends /tools/list to it.
KS_PUBLIC_URL="${KNOWLEDGE_PUBLIC_BASE_URL:-${KS_INTERNAL_URL}/v3}"
PROXY_BASE_URL="${KNOWLEDGE_LLM_PROXY_BASE_URL:-}"

# Generate a single-instance config from REMOTE_INSTANCE_* only when no instances file was supplied.
# REMOTE_INSTANCE_PROXY_URL is optional:
# - Unset: omit proxy_endpoint and preserve the Panel "Client connection address" fallback
# to gateway_endpoint. No change is needed when a deployed gateway already fronts Proxy.
# - Set: include proxy_endpoint so the UI displays the Proxy address.
# Panel-to-Core forwarding still uses gateway_endpoint and is unaffected.
if [[ "$USER_PROVIDED_INSTANCES" -ne 1 ]]; then
# Add proxy_endpoint to the dictionary only when nonempty; otherwise omit it to preserve existing behavior.
PROXY_ENDPOINT_LINE=""
if [[ -n "${REMOTE_INSTANCE_PROXY_URL:-}" ]]; then
  PROXY_ENDPOINT_LINE="    'proxy_endpoint': '${REMOTE_INSTANCE_PROXY_URL}',"
fi
python3 - <<PY
import json
from pathlib import Path
p=Path('$INSTANCES_FILE')
p.write_text(json.dumps({
  'instances': [{
    'id': '${INSTANCE_ID}',
    'name': '${INSTANCE_NAME}',
    'gateway_endpoint': '${REMOTE_INSTANCE_URL}',
${PROXY_ENDPOINT_LINE}
    'api_key': '${REMOTE_INSTANCE_KEY}',
  }]
}, ensure_ascii=False, indent=2) + '\n')
PY
fi

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup INT TERM EXIT

export API_PREFIX="${API_PREFIX:-/v3}"
export KNOWLEDGE_DATA_DIR="${KNOWLEDGE_DATA_DIR:-/data/knowledge}"
export KNOWLEDGE_DB_PATH="${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}"
export TDAI_AGENT_TEMPLATE_DIR="${TDAI_AGENT_TEMPLATE_DIR:-/data/knowledge/agent-templates}"
export KNOWLEDGE_PUBLIC_BASE_URL="${KS_PUBLIC_URL}"
export TMC_CALLBACK_URL="${TMC_CALLBACK_URL:-http://127.0.0.1:${PANEL_PORT}}"

# Persist logs in /data/knowledge/logs/ and also send them to stdout for docker logs.
# Use separate Panel and Knowledge log files for easier troubleshooting.
LOG_DIR="${LOG_DIR:-/data/knowledge/logs}"
mkdir -p "$LOG_DIR"
PANEL_LOG="$LOG_DIR/panel.log"
KNOWLEDGE_LOG="$LOG_DIR/knowledge.log"
# Rotate logs on every startup, retaining one .prev file to avoid unlimited growth.
[[ -f "$PANEL_LOG" ]] && mv "$PANEL_LOG" "$PANEL_LOG.prev"
[[ -f "$KNOWLEDGE_LOG" ]] && mv "$KNOWLEDGE_LOG" "$KNOWLEDGE_LOG.prev"
echo "[start-combined] panel log → $PANEL_LOG" ; echo "[start-combined] knowledge log → $KNOWLEDGE_LOG"

# Knowledge LLM routing uses the variable names read by MemoryKnowledge/src/config.ts.
# LLM_MODE=proxy (default): Wiki ingestion uses context_proxy and requires Panel-provided llm_binding.
# LLM_MODE=custom: connect directly to an OpenAI-compatible endpoint; requires LLM_API_KEY / LLM_BASE_URL.
export LLM_MODE="${LLM_MODE:-proxy}"
export LLM_PROVIDER="${LLM_PROVIDER:-custom}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_BASE_URL="${LLM_BASE_URL:-}"
export LLM_MODEL="${LLM_MODEL:-Memory-Model}"
export LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-32768}"
export LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-1200000}"

# On startup, Panel sends a mode=proxy llm_binding to Knowledge for each instance.
# Force synchronization in proxy mode, which requires a binding.
# In custom mode, the user controls KNOWLEDGE_LLM_BINDING_SYNC (still defaults to 1).
SYNC_ENV="${KNOWLEDGE_LLM_BINDING_SYNC:-1}"
if [[ "${LLM_MODE}" == "proxy" ]]; then
  SYNC_ENV=1
fi

cd /app/knowledge
PORT="${KNOWLEDGE_PORT}" LOG_LEVEL="${LOG_LEVEL:-info}" \
  KNOWLEDGE_SERVICE_KEY="${KNOWLEDGE_SERVICE_KEY:-}" \
  node "$(test -f dist/server.js && echo dist/server.js || echo dist/server.mjs)" 2>&1 \
  | tee -a "$KNOWLEDGE_LOG" &
KNOWLEDGE_PID=$!

# Wait for Knowledge before starting Panel, which calls /v3/internal/llm-binding/status
# through ensureKnowledgeLlmBindings; starting Panel first would cause a failed fetch.
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${KNOWLEDGE_PORT}/health" >/dev/null 2>&1; then
    echo "knowledge service ready on :${KNOWLEDGE_PORT}"
    break
  fi
  sleep 0.5
  if ! kill -0 "$KNOWLEDGE_PID" 2>/dev/null; then
    echo "knowledge service exited before ready" >&2
    wait "$KNOWLEDGE_PID"
  fi
done

cd /app/panel
HOST=0.0.0.0 \
PORT="${PANEL_PORT}" \
UI_DIST_DIR=/app/panel/web/dist \
METADATA_INSTANCES_CONFIG=/app/panel/config/metadata-instances.json \
METADATA_REMOTE_TIMEOUT_MS="${METADATA_REMOTE_TIMEOUT_MS:-15000}" \
KNOWLEDGE_SERVICE_URL="${KS_INTERNAL_URL}" \
KNOWLEDGE_AUTH_TOKEN="${KNOWLEDGE_AUTH_TOKEN:-}" \
KNOWLEDGE_TIMEOUT_MS="${KNOWLEDGE_TIMEOUT_MS:-15000}" \
KNOWLEDGE_LLM_BINDING_SYNC="${SYNC_ENV}" \
KNOWLEDGE_LLM_PROXY_BASE_URL="${PROXY_BASE_URL}" \
LOG_LEVEL="${LOG_LEVEL:-info}" \
LOG_FORMAT="${LOG_FORMAT:-json}" \
node dist/index.js 2>&1 \
  | tee -a "$PANEL_LOG" &
PANEL_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/health" >/dev/null 2>&1; then
    echo "combined service ready: panel=:${PANEL_PORT}, knowledge=:${KNOWLEDGE_PORT}, instance=${INSTANCE_ID}"
    break
  fi
  sleep 0.5
  if ! kill -0 "$PANEL_PID" 2>/dev/null; then
    echo "panel service exited" >&2
    wait "$PANEL_PID"
  fi
done

wait -n "$KNOWLEDGE_PID" "$PANEL_PID"
