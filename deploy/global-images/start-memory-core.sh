#!/usr/bin/env bash
# Start memory-core independently (Core gateway, port 8420). Initialize the admin on first startup and
# persist its generated user_key in .admin-key for Proxy / Claude Code.
#
# Usage:
#   ./start-memory-core.sh
#
# Persist data in a named volume (default tdai-memory-core-data; override MEMORY_CORE_VOLUME in .env).
# Repeated runs replace the container but preserve volume data and the admin user_key.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars MEMORY_CORE_IMAGE MEMORY_CORE_PORT MEMORY_CORE_VOLUME

# Internal gateway administrative credential
# Use ${VAR-default}, not :-default, so an explicitly empty .env value disables the Bearer gate.
#
# Known incompatibility between Core's Bearer gate and Proxy authentication: Proxy calls
# /v3/meta/auth/verify without a Bearer header (see MemoryProxy/src/auth.ts).
# When Proxy authentication is enabled, leave MEMORY_CORE_GATEWAY_API_KEY empty; this is the default.
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"
MEMORY_CORE_ADMIN_USERNAME="${MEMORY_CORE_ADMIN_USERNAME:-admin}"

# Host-side admin key location; delete this file when purging its data volume.
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"

if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  warn "MEMORY_CORE_GATEWAY_API_KEY is nonempty; Proxy sessionInit/auth currently fail without a Bearer header."
  warn "For local testing, leave MEMORY_CORE_GATEWAY_API_KEY empty in .env."
fi

CONTAINER=tdai-memory-core
NETWORK=tdai-memory-stack

# Create the shared network idempotently.
if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "Creating Docker network $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# Storage backend: sqlite (default) or mongodb.
# MEMORY_CORE_STORE_MODE=mongodb stores L0/L1/profile/skill data in MongoDB with
# native mongot BM25. Requires MongoDB 7.0+ with mongot; Core probes it on first connection.
# Initialization fails without mongot because full-text search is required; no silent fallback.
# MONGODB_ENDPOINT set: use external MongoDB (Atlas or a replica set with mongot).
# MONGODB_ENDPOINT unset: start a mongodb-atlas-local container on the shared network.
# It bundles mongod + mongot and persists data in mongo-local-* volumes.
#
# Metadata backend (meta_* teams/users/agents/tasks/ACLs):
# MEMORY_CORE_METADATA_BACKEND=auto follows STORE_MODE by default; sqlite and mongodb are explicit overrides.
# MongoDB metadata reuses the same deployment unless TDAI_METADATA_MONGO_URI overrides it.
# Metadata uses multi-document transactions and requires a replica set; atlas-local's single-node set qualifies.
MEMORY_CORE_STORE_MODE="${MEMORY_CORE_STORE_MODE:-sqlite}"
MEMORY_CORE_METADATA_BACKEND="${MEMORY_CORE_METADATA_BACKEND:-auto}"
MONGODB_DATABASE="${MONGODB_DATABASE:-tdai_memory}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-tdai-mongo-local}"
MONGO_LOCAL_IMAGE="${MONGO_LOCAL_IMAGE:-mongodb/mongodb-atlas-local:8.3}"
MONGO_ENV_ARGS=()

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "auto" ]]; then
  if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
    MEMORY_CORE_METADATA_BACKEND="mongodb"
  else
    MEMORY_CORE_METADATA_BACKEND="sqlite"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" || "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  if [[ -z "${MONGODB_ENDPOINT:-}" ]]; then
    info "MONGODB_ENDPOINT is unset; starting local atlas-local ($MONGO_LOCAL_IMAGE)."
    if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MONGO_LOCAL_CONTAINER"; then
      rm_container_if_exists "$MONGO_LOCAL_CONTAINER"
      # Keep --hostname fixed: atlas-local uses the container hostname for its single-node replica-set member.
      # If recreated with a new hostname, the old replica-set member address no longer matches and no primary is elected
      # (not primary / ReplicaSetNoPrimary); recovery would require recreating the volume.
      $DOCKER run -d --name "$MONGO_LOCAL_CONTAINER" \
        --hostname mongo-search \
        --network "$NETWORK" \
        --network-alias mongo-search \
        -v mongo-local-db:/data/db \
        -v mongo-local-configdb:/data/configdb \
        -v mongo-local-mongot:/data/mongot \
        "$MONGO_LOCAL_IMAGE" >/dev/null
    fi
    info "Waiting for MongoDB to become ready..."
    mongo_ready=0
    for _ in $(seq 1 30); do
      # A ping can succeed without a replica-set primary; wait for isWritablePrimary instead.
      # Otherwise Core starts before the election completes and startup index creation / transactions fail.
      if $DOCKER exec "$MONGO_LOCAL_CONTAINER" mongosh --quiet --eval \
          'if (db.adminCommand("hello").isWritablePrimary === true) quit(0); else quit(1)' >/dev/null 2>&1; then
        mongo_ready=1; break
      fi
      sleep 2
    done
    [[ "$mongo_ready" == "1" ]] || die "MongoDB did not become ready within 60s; inspect docker logs $MONGO_LOCAL_CONTAINER."
    ok "MongoDB ready (container $MONGO_LOCAL_CONTAINER, network alias mongo-search)."
    MONGODB_ENDPOINT="mongodb://mongo-search:27017/?directConnection=true"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
  MONGO_ENV_ARGS+=( -e "MONGODB_ENDPOINT=$MONGODB_ENDPOINT" -e "MONGODB_DATABASE=$MONGODB_DATABASE" )
  info "memory-core data backend = mongodb (endpoint=$MONGODB_ENDPOINT, db=$MONGODB_DATABASE)"
fi

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  # Metadata shares the data plane's MongoDB deployment by default, in a separate {prefix}_{instance_id} database (prefix tdai_metadata).
  # The metadata client is independent of the shared connection pool and does not inherit w:1; transactions use the server's majority default.
  TDAI_METADATA_MONGO_URI="${TDAI_METADATA_MONGO_URI:-$MONGODB_ENDPOINT}"
  MONGO_ENV_ARGS+=( -e "TDAI_METADATA_MONGO_URI=$TDAI_METADATA_MONGO_URI" )
  info "memory-core metadata backend = mongodb (uri=$TDAI_METADATA_MONGO_URI, database tdai_metadata_<instance>)"
else
  info "memory-core metadata backend = sqlite (in the container volume)"
fi

pull_image "$MEMORY_CORE_IMAGE"
rm_container_if_exists "$CONTAINER"

# Generate gateway config.yaml and mount it at /data/config/tdai-gateway.yaml.
# The default image has no config and falls back to compiled defaults with Skill / Knowledge modules disabled.
# Generate a minimal standalone + Skill configuration from MEMORY_LLM_* in .env.
CORE_CONFIG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
mkdir -p "$CORE_CONFIG_DIR"
CORE_CONFIG_FILE="$CORE_CONFIG_DIR/tdai-gateway.yaml"
info "Generating gateway config → $CORE_CONFIG_FILE"
cat > "$CORE_CONFIG_FILE" <<YAML
# Generated by start-memory-core.sh. Overwritten on every startup; do not edit manually.
deployMode: standalone
stateBackend: local

server:
  port: 8420
  host: 0.0.0.0

data:
  baseDir: /data/tdai-memory

llm:
  baseUrl: "${MEMORY_LLM_BASE_URL:-}"
  apiKey: "${MEMORY_LLM_API_KEY:-}"
  model: "${MEMORY_LLM_MODEL:-}"
  maxTokens: 32000
  timeoutMs: 300000

memory:
  # promptMode: code (default, engineering: extract shared project facts/tasks/decisions/SOPs/constraints)
  # | chat (general conversation/teaching: extract personal persona/episodic/instruction memories)
  # Override with MEMORY_PROMPT_MODE in .env.
  # In code mode, casual chat may produce no memories if the LLM finds no reusable engineering content.
  promptMode: ${MEMORY_PROMPT_MODE:-code}
  capture: { enabled: true }
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutSeconds: 600
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: hybrid
    timeoutMs: 5000
  # In gateway mode, STORE_MODE selects the actual backend (see docker run -e STORE_MODE).
  # Keep this field consistent for readability; only plugin/SDK mode reads it directly.
  storeBackend: ${MEMORY_CORE_STORE_MODE}
  embedding:
    provider: none

# Skill module
skill:
  enabled: true
  routing:
    mode: bm25
    searchTopK: 20
  extraction:
    enabled: true
    maxIterations: 16
    queue:
      backend: local
      keyPrefix: tdai
      resultTtlSeconds: 86400
      lockTtlMs: 600000
      maxRetries: 2
      retryBackoffsMs: [5000, 15000]
  resources:
    maxResourceSizeBytes: 5000000
YAML

info "Starting memory-core (image=$MEMORY_CORE_IMAGE, port=$MEMORY_CORE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  -p "${MEMORY_CORE_PORT}:8420" \
  -v "${MEMORY_CORE_VOLUME}:/data/tdai-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \
  -e TDAI_GATEWAY_PORT=8420 \
  -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e TDAI_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e TDAI_DATA_DIR=/data/tdai-memory \
  -e STORE_MODE="$MEMORY_CORE_STORE_MODE" \
  ${MONGO_ENV_ARGS[@]+"${MONGO_ENV_ARGS[@]}"} \
  "$MEMORY_CORE_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "memory-core started → http://localhost:${MEMORY_CORE_PORT}/"

# Admin user lifecycle
# First startup: pass a generated random user_key to init-admin, then save the returned key to a file.
# On restart (409 Already Initialized), prefer .admin-key. A new volume paired with an old key
# cannot be recovered automatically; the volume and key must stay synchronized.
#
# init-admin respects the supplied user_key (see MemoryCore/src/metadata/store/sqlite-adapter.ts:
# defaultKeyValue = input.default_key_value ?? generateUserKey()). With an empty volume,
# supplying a chosen key yields that key. On first startup, generate a random 32-character
# URL-safe key; every machine / purge gets an independent key.

generate_user_key() {
  # sk-mem-<32 alphanumeric characters>, matching metadata/utils/user-key.ts.
  # Use portable openssl and filter base64 +/= characters to obtain 32 characters.
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    # Fallback: read enough urandom bytes to retain at least 32 characters after filtering.
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

verify_user_key() {
  local key="$1"
  local code
  code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" \
    -H "x-tdai-service-id: default" \
    ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
    "http://localhost:${MEMORY_CORE_PORT}/v3/meta/auth/verify" \
    -d "$(printf '{"user_key":"%s"}' "$key")" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]]
}

info "Initializing admin user (username=${MEMORY_CORE_ADMIN_USERNAME}, key saved to ${ADMIN_KEY_FILE})..."

# Generate a random key for first initialization, or reuse the existing key file.
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  info "  Reusing the saved admin key (.admin-key exists)."
else
  ADMIN_KEY=$(generate_user_key)
fi

init_body=$(printf '{"username":"%s","user_key":"%s"}' \
  "$MEMORY_CORE_ADMIN_USERNAME" "$ADMIN_KEY")
init_resp=$(/usr/bin/curl -sS -o /tmp/init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
  -H "x-tdai-service-id: default" \
  "http://localhost:${MEMORY_CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" 2>/dev/null || echo "000")

case "$init_resp" in
  200)
    ok "Admin user created."
    # Persist the key and restrict permissions on the host file.
    umask 077
    echo -n "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    ok "  Admin user_key saved in $ADMIN_KEY_FILE"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      ok "Admin user already exists (skip init-admin; use the key in $ADMIN_KEY_FILE)."
    else
      warn "Admin user exists, but $ADMIN_KEY_FILE is missing; the user_key cannot be recovered."
      warn "Option A: remove the volume and recreate it: ./stop-all.sh --purge && ./start-memory-core.sh"
      warn "Option B: manually create a new admin user_key (requires the old key or gateway apiKey)."
    fi
    ;;
  *)
    warn "init-admin returned HTTP=${init_resp}; manual troubleshooting may be needed:"
    cat /tmp/init-admin.$$ 2>/dev/null; echo
    ;;
esac
rm -f /tmp/init-admin.$$

# Verify that the admin key works.
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  if verify_user_key "$ADMIN_KEY"; then
    # Only print a masked value at the end so terminal history does not contain the complete key.
    masked="${ADMIN_KEY:0:11}****${ADMIN_KEY: -4}"
    ok "Admin user_key verified (auth/verify 200): $masked"
    ok "  key file: $ADMIN_KEY_FILE"
  else
    warn "Admin user_key verification failed (auth/verify was not 200). Check that $ADMIN_KEY_FILE matches the volume."
  fi
fi
