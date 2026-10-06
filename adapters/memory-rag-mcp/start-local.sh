#!/usr/bin/env bash
# Configure this executable as the MCP stdio command in your agent.
set -euo pipefail
ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMBER_ENV_FILE="${MEMBER_RAG_ENV_FILE:-$ADAPTER_DIR/.env}"
if [[ -f "$MEMBER_ENV_FILE" ]]; then
  set -a
  source "$MEMBER_ENV_FILE"
  set +a
fi
exec node "$ADAPTER_DIR/server.mjs"
