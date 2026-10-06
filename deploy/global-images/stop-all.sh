#!/usr/bin/env bash
# Stop and remove stack containers.
#
# Usage:
# ./stop-all.sh              # Stop containers and keep data volumes.
# ./stop-all.sh --purge      # Remove containers, volumes, and network.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PURGE=0
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
fi

# Allow operation without .env by falling back to default volume names.
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
MEMORY_CORE_VOLUME="${MEMORY_CORE_VOLUME:-tdai-memory-core-data}"
PANEL_VOLUME="${PANEL_VOLUME:-tdai-panel-data}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-tdai-mongo-local}"

for c in tdai-mcp tdai-proxy tdai-memory-hub tdai-memory-core "$MONGO_LOCAL_CONTAINER"; do
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    info "Stopping and removing $c"
    $DOCKER rm -f "$c" >/dev/null
  else
    info "$c is not running; skipping."
  fi
done

if (( PURGE == 1 )); then
  warn "--purge enabled: remove volumes, network, and admin key file."
  for v in "$MEMORY_CORE_VOLUME" "$PANEL_VOLUME" mongo-local-db mongo-local-configdb mongo-local-mongot; do
    if $DOCKER volume inspect "$v" >/dev/null 2>&1; then
      $DOCKER volume rm "$v" >/dev/null && ok "Removed volume $v" || warn "Failed to remove volume $v"
    fi
  done
  if $DOCKER network inspect tdai-memory-stack >/dev/null 2>&1; then
    $DOCKER network rm tdai-memory-stack >/dev/null && ok "Removed network tdai-memory-stack" || true
  fi
  # The admin key is tied to the data volume. Purging volumes must also remove the key file;
  # otherwise the next startup would use an old key with a new volume and authentication would fail.
  ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
  if [[ -f "$ADMIN_KEY_FILE" ]]; then
    rm -f "$ADMIN_KEY_FILE" && ok "Removed admin key file $ADMIN_KEY_FILE"
  fi
  # Also remove generated proxy / memory-core configuration.
  PROXY_CFG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
  if [[ -d "$PROXY_CFG_DIR" ]]; then
    rm -rf "$PROXY_CFG_DIR" && ok "Removed proxy config directory $PROXY_CFG_DIR"
  fi
  CORE_CFG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
  if [[ -d "$CORE_CFG_DIR" ]]; then
    rm -rf "$CORE_CFG_DIR" && ok "Removed memory-core config directory $CORE_CFG_DIR"
  fi
fi

ok "Done."
