#!/usr/bin/env bash
# Start the Memory stack in MongoDB mode (memory-core + memory-hub + optional adapters).
# Experimental and disabled by default; ./start-all.sh still defaults to SQLite.
#
# Relationship to start-all.sh:
# - start-all.sh defaults to SQLite with data stored in container volumes.
# - This script reuses the same startup flow and writes MEMORY_CORE_STORE_MODE=mongodb to .env.
# - The data plane (L0/L1 memories, profiles, and Skills) uses MongoDB with native mongot BM25.
# - Metadata (meta_* teams/users/agents/tasks) follows the same MongoDB deployment by default,
#         （MEMORY_CORE_METADATA_BACKEND=auto）；
# - When MONGODB_ENDPOINT is absent from .env, start a local container on the same network:
# mongodb-atlas-local bundles mongod + mongot and persists data in mongo-local-* volumes.
#
# Usage (same as start-all.sh):
# ./start-all-mongo.sh            # Configure LLM settings interactively, then start services.
# PULL=1 ./start-all-mongo.sh     # Pull updated images first.
#
# To return to SQLite, comment out MEMORY_CORE_STORE_MODE in .env or set it to sqlite, then run ./start-all.sh.
# Switching storage backends does not migrate existing data.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Create .env from the template before saving STORE_MODE.
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist; copying .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

# Detect an explicitly configured non-MongoDB MEMORY_CORE_STORE_MODE in .env.
# Sourcing .env in start-all.sh would override the export below and silently select another mode; reject that conflict.
# The setting is commented out in .env.example, so a standard configuration does not trigger this check.
env_mode=$(grep -E '^[[:space:]]*MEMORY_CORE_STORE_MODE=' "$ENV_FILE" \
  | tail -n1 | cut -d= -f2- | tr -d '[:space:]"' || true)
if [[ -n "$env_mode" && "$env_mode" != "mongodb" ]]; then
  echo "[error] .env explicitly sets MEMORY_CORE_STORE_MODE=$env_mode, which conflicts with this script." >&2
  echo "        Choose one:" >&2
  echo "          ① To use MongoDB: comment out that .env line and rerun this script;" >&2
  echo "          ② To use $env_mode: run ./start-all.sh directly." >&2
  exit 1
fi

set_env_value MEMORY_CORE_STORE_MODE mongodb "$ENV_FILE"
export MEMORY_CORE_STORE_MODE=mongodb
echo "[start-all-mongo] Saved MEMORY_CORE_STORE_MODE=mongodb in .env (data plane and metadata use MongoDB by default)."

exec "$SCRIPT_DIR/start-all.sh" "$@"
