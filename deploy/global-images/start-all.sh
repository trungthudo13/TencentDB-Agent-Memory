#!/usr/bin/env bash
# Start the Memory stack interactively: Core, Hub, and optional Proxy.
#
# Start Core and wait for health, then Hub (Panel + Knowledge) and wait for health.
# Start the enabled adapters last. Abort and print container logs if a step fails.
#
# Usage:
# ./start-all.sh            # Configure LLM settings (Enter keeps defaults), verify connectivity, and start services.
# PULL=1 ./start-all.sh     # Pull updated images before starting.
#
# Interactive setup:
# - Copy .env.example when .env does not exist.
# - Confirm memory and enabled proxy LLM settings on each run; Enter keeps existing values.
# - Check LLM connectivity immediately; retry until successful or the user cancels.
# - Save settings to .env and reuse them as defaults on the next run.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Copy the template when .env is missing; interactive setup fills in LLM settings.
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist; copying .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

load_env

# Confirm LLM settings, check connectivity, and save to .env.
interactive_llm_setup

# Validate all required settings before starting any service.
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL

if [[ "${PROXY_ENABLED:-1}" == "1" ]]; then
  require_vars PROXY_PORT PROXY_IMAGE PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL
fi

# Check all enabled service ports before startup; reject conflicts with external processes.
# Exclude existing stack containers so Core is not started before discovering a Hub/Proxy port conflict.
check_ports

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

# Enable the full proxy pipeline by default: auth, sessionInit, and TDAI injection.
# Set PROXY_FULL_STACK=0 to disable this default, or override individual switches in .env.
if [[ "${PROXY_ENABLED:-1}" == "1" ]]; then
  info "Starting proxy"
  PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"
fi

ok "═══ All services are ready ═════════════════════════════════════════"
print_endpoints

# Print Claude Code / proxy usage commands.
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ "${PROXY_ENABLED:-1}" == "1" && -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ Use Claude Code through Proxy ─────────────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  Admin user_key saved in: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  View logs:  docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  Stop services:  ./stop-all.sh"
echo ""
