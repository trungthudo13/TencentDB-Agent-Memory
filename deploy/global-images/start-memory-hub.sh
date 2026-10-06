#!/usr/bin/env bash
# Start memory-hub independently (combined Panel + Knowledge image, ports 8125 + 8424).
#
# Dependency: start Core first; Knowledge uses it for embedding/RAG.
# Warn but continue when Core is missing: memory-hub itself can start in LLM_MODE=proxy,
# but Knowledge's first request to Core will fail.
#
# Usage:
#   ./start-memory-hub.sh
#
# Required LLM settings in .env:
#   MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  MEMORY_HUB_IMAGE PANEL_PORT KNOWLEDGE_PORT PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL

# Use the same internal gateway credential as memory-core (default local, for local testing only).
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-local}"

# Ensure a shared Panel/Knowledge authentication key exists; generate and save it on first startup.
ensure_knowledge_service_key

# Base URL displayed in Panel's "Client connection address" card for CodeBuddy / Claude Code.
# In local deployments Core and Proxy run separately; LLM clients connect to Proxy, not the Core gateway.
#
# Detect the host's externally reachable address in this order:
# 1) Linux: first non-loopback IPv4 from hostname -I (LAN IP).
# 2) macOS: IPv4 of common interfaces en0 / en1.
# 3) Fall back to localhost; remote clients require an explicit MEMORY_HUB_PROXY_PUBLIC_URL.
#
# An explicitly set MEMORY_HUB_PROXY_PUBLIC_URL takes precedence over autodetection.
# An explicitly empty value preserves the UI fallback to gateway_endpoint.
# Panel-to-Core forwarding always uses REMOTE_INSTANCE_URL, independently of this setting.
detect_host_ip() {
  local ip=""
  # Linux
  if command -v hostname >/dev/null 2>&1; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $0 !~ /^127\./ && $0 !~ /^169\.254\./' | head -n1)
    [[ -n "$ip" ]] && { echo "$ip"; return; }
  fi
  # macOS
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2; do
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null)
      [[ -n "$ip" ]] && { echo "$ip"; return; }
    done
  fi
  # Fallback: ip route on Linux when hostname -I is unavailable.
  if command -v ip >/dev/null 2>&1; then
    ip=$(ip -4 route get 1 2>/dev/null | awk '/src/ {for (i=1;i<=NF;i++) if ($i=="src") print $(i+1); exit}')
    [[ -n "$ip" ]] && { echo "$ip"; return; }
  fi
  echo "localhost"
}

if [[ -z "${MEMORY_HUB_PROXY_PUBLIC_URL+x}" ]]; then
  # When unset, combine the detected IP with PROXY_PORT.
  _host_ip=$(detect_host_ip)
  MEMORY_HUB_PROXY_PUBLIC_URL="http://${_host_ip}:${PROXY_PORT:-8096}"
  info "Detected host address: MEMORY_HUB_PROXY_PUBLIC_URL=$MEMORY_HUB_PROXY_PUBLIC_URL"
  info "  (To override, set this explicitly in .env: MEMORY_HUB_PROXY_PUBLIC_URL=http://<your-ip>:${PROXY_PORT:-8096})"
fi

CONTAINER=tdai-memory-hub
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "Creating Docker network $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# Warn without blocking when Core is not running.
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core is not running. Hub can start, but Knowledge requests to Core will fail."
  warn "Run ./start-memory-core.sh first, or use ./start-all.sh."
fi

pull_image "$MEMORY_HUB_IMAGE"
rm_container_if_exists "$CONTAINER"

# Use custom mode for Knowledge's internal LLM calls, with the MEMORY_LLM_* settings.
# LLM_MODE=custom bypasses the Memory LLM proxy and calls the user-provided endpoint directly.
info "Starting memory-hub (image=$MEMORY_HUB_IMAGE, panel=$PANEL_PORT knowledge=$KNOWLEDGE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p "${PANEL_PORT}:8125" \
  -p "${KNOWLEDGE_PORT}:8424" \
  -v "${PANEL_VOLUME}:/data/knowledge" \
  -e PANEL_PORT=8125 \
  -e KNOWLEDGE_PORT=8424 \
  -e KNOWLEDGE_PUBLIC_BASE_URL="$KNOWLEDGE_PUBLIC_BASE_URL" \
  -e KNOWLEDGE_SERVICE_KEY="$KNOWLEDGE_SERVICE_KEY" \
  -e KNOWLEDGE_AUTH_TOKEN="$KNOWLEDGE_SERVICE_KEY" \
  -e REMOTE_INSTANCE_ID=default \
  -e REMOTE_INSTANCE_NAME=default \
  -e REMOTE_INSTANCE_URL="http://memory-core:8420" \
  -e REMOTE_INSTANCE_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e REMOTE_INSTANCE_PROXY_URL="$MEMORY_HUB_PROXY_PUBLIC_URL" \
  -e LLM_MODE=custom \
  -e LLM_PROTOCOL="${MEMORY_LLM_PROTOCOL:-openai}" \
  -e LLM_API_KEY="$MEMORY_LLM_API_KEY" \
  -e LLM_BASE_URL="$MEMORY_LLM_BASE_URL" \
  -e LLM_MODEL="$MEMORY_LLM_MODEL" \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  "$MEMORY_HUB_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 120
ok "memory-hub started"
ok "  Panel UI  → http://localhost:${PANEL_PORT}/"
ok "  KS Health → http://localhost:${KNOWLEDGE_PORT}/health"
