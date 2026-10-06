#!/usr/bin/env bash
# Shared helpers: load .env, validate required settings, wait for health, and remove old containers.
# Sourced by start-*.sh through `source _lib.sh`; do not execute directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Colors
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

# Load .env, or explain how to create it.
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die ".env does not exist. Run cp .env.example .env and configure the LLM settings first."
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# Validate all required variables before startup; report all missing settings together.
require_vars() {
  local missing=()
  for var in "$@"; do
    local val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      missing+=("$var")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "${C_RED}[error]${C_RST} The following required .env settings are missing or still REPLACE_ME:" >&2
    for v in "${missing[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    echo "  Edit $ENV_FILE and retry." >&2
    exit 1
  fi
}

# Find Docker, including standalone Homebrew installations and Colima.
# Search order: Docker on PATH, Homebrew Apple Silicon, Homebrew Intel, then /usr/local.
# Select the latest Homebrew Cellar version with sort -V instead of hardcoding a patch version.
find_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi
  local candidate
  for prefix in /opt/homebrew/Cellar/docker /usr/local/Cellar/docker; do
    if [[ -d "$prefix" ]]; then
      candidate=$(ls -1 "$prefix" 2>/dev/null | sort -V | tail -n1)
      if [[ -n "$candidate" && -x "$prefix/$candidate/bin/docker" ]]; then
        echo "$prefix/$candidate/bin/docker"
        return
      fi
    fi
  done
  for path in /opt/homebrew/bin/docker /usr/local/bin/docker; do
    if [[ -x "$path" ]]; then
      echo "$path"
      return
    fi
  done
  die "Docker was not found. Install Docker Desktop, OrbStack, or Colima with the Docker CLI first."
}

DOCKER="$(find_docker)"

# Pull the latest image when PULL=1.
# Disabled by default: docker run pulls missing images but reuses an existing local :latest.
# Local tags do not detect remote updates; use PULL=1 to upgrade.
pull_image() {
  local image="$1"
  [[ "${PULL:-0}" == "1" ]] || return 0
  info "Pulling image $image"
  $DOCKER pull "$image" || die "Failed to pull $image."
}

# Idempotently remove a container with the same name.
rm_container_if_exists() {
  local name="$1"
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    info "Removing existing container $name"
    $DOCKER rm -f "$name" >/dev/null
  fi
}

# Wait for healthy, or running when the image has no healthcheck.
wait_healthy() {
  local name="$1"
  local timeout="${2:-90}"    # seconds
  local waited=0
  info "Waiting for $name to become ready (up to ${timeout}s)..."
  while (( waited < timeout )); do
    local status health
    status="$($DOCKER inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")"
    health="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo "unknown")"

    if [[ "$status" != "running" ]]; then
      warn "${name} status is ${status}; recent logs:"
      $DOCKER logs --tail 30 "$name" 2>&1 || true
      die "${name} is not running."
    fi

    case "$health" in
      healthy) ok "$name healthy"; return 0 ;;
      unhealthy)
        warn "${name} is unhealthy; logs:"
        $DOCKER logs --tail 30 "$name" 2>&1 || true
        die "${name} healthcheck failed."
        ;;
      none)
        # Without an image healthcheck, consider a running container ready.
        ok "${name} is running (no healthcheck)."
        return 0
        ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  warn "Timed out waiting for ${name}; latest logs:"
  $DOCKER logs --tail 30 "$name" 2>&1 || true
  die "${name} did not become ready within ${timeout}s."
}

# Print the service endpoint table.
print_endpoints() {
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │ Service endpoints                                       │"
  echo "  ├─────────────────────────────────────────────────────────┤"
  printf "  │ Panel UI       http://localhost:%-24s│\n" "${PANEL_PORT}/"
  printf "  │ Panel API      http://localhost:%-24s│\n" "${PANEL_PORT}/api/v1/"
  printf "  │ Knowledge API  http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/v3/"
  printf "  │ Knowledge Docs http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/docs"
  printf "  │ Memory Core     http://localhost:%-24s│\n" "${MEMORY_CORE_PORT}/"
  if [[ "${PROXY_ENABLED:-1}" == "1" ]]; then
    printf "  │ Proxy          http://localhost:%-24s│\n" "${PROXY_PORT}/"
  fi
  echo "  └─────────────────────────────────────────────────────────┘"
}

# ═══════════════════════════════════════════════════════════════
# LLM connectivity checks shared with verify.sh and the interactive start-all.sh flow.
# ═══════════════════════════════════════════════════════════════

CURL="${CURL:-/usr/bin/curl}"
if [[ ! -x "$CURL" ]]; then
  if command -v curl >/dev/null 2>&1; then
    CURL="$(command -v curl)"
  else
    CURL="curl"
  fi
fi

# check_llm_openai <label> <base_url> <api_key> <model>
# OpenAI-compatible: GET {base}/models validates auth and URL without consuming tokens. Return 0 on success, 1 on failure.
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
  local rc=0
  if [[ "$code" == "200" ]]; then
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI connectivity OK ($model is listed in /models)"
    else
      ok "$label OpenAI connectivity OK ($model is not listed in /models but may still be usable)"
    fi
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    warn "$label Invalid API key (HTTP ${code}):$url"
    head -c 200 "$body_file" >&2; echo >&2
    rc=1
  elif [[ "$code" == "404" ]]; then
    warn "$label GET /models returned 404; the provider may not expose it. Trying an Anthropic protocol check."
    rm -f "$body_file"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    return $?
  else
    warn "$label Cannot reach ${url} (HTTP=${code})$(head -c 100 "$body_file" 2>/dev/null)"
    rc=1
  fi
  rm -f "$body_file"
  return $rc
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
# Anthropic: POST {base}/v1/messages with max_tokens=1 consumes at most 10 tokens. Return 0 or 1.
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  local url
  if [[ "$base" == */messages ]]; then
    url="$base"
  elif [[ "$base" == */v1 ]]; then
    url="${base}/messages"
  else
    url="${base}/v1/messages"
  fi
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 15 -o "$body_file" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-api-key: $key" -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  local rc=0
  case "$code" in
    200) ok "$label Anthropic connectivity OK (model $model responded)" ;;
    401|403)
      warn "$label Invalid API key (HTTP ${code}):$url"
      head -c 200 "$body_file" >&2; echo >&2
      rc=1 ;;
    404)
      warn "$label URL not found (HTTP 404): $url; check BASE_URL"
      rc=1 ;;
    400)
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        warn "$label Invalid model '$model' (HTTP 400)"
        rc=1
      else
        warn "$label HTTP 400 (possibly request formatting rather than connectivity):$(head -c 150 "$body_file")"
        rc=0
      fi ;;
    *)
      warn "$label Cannot reach ${url} (HTTP=${code})$(head -c 100 "$body_file" 2>/dev/null)"
      rc=1 ;;
  esac
  rm -f "$body_file"
  return $rc
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "Checking $label connectivity (protocol=${proto})..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# ═══════════════════════════════════════════════════════════════
# Interactive input helpers
# ═══════════════════════════════════════════════════════════════

# prompt_with_default <label> <default>
# Print "label [default]: " and read one line; empty input returns the default. Write the result to stdout.
prompt_with_default() {
  local label="$1" default="${2:-}"
  # Send prompts to stderr and results to stdout so command substitution captures only the result.
  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$label" "$default" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  local input
  IFS= read -r input || { printf '\n' >&2; printf '%s' "$default"; return 0; }
  if [[ -z "$input" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$input"
  fi
}

# prompt_protocol <default>
# Ask for the LLM protocol (openai/anthropic); invalid input falls back to openai.
prompt_protocol() {
  local default="${1:-openai}"
  printf 'Memory LLM protocol (openai/anthropic)[%s]: ' "$default" >&2
  local input
  IFS= read -r input || { printf '\n' >&2; printf '%s' "$default"; return 0; }
  input="${input:-$default}"
  case "$input" in
    openai|anthropic) printf '%s' "$input" ;;
    *) warn "Unknown protocol '$input'; falling back to openai"; printf 'openai' ;;
  esac
}

# prompt_confirm <question> <default_yes:0|1>
# Return 0 for yes, 1 for no.
prompt_confirm() {
  local question="$1" default_yes="${2:-0}"
  local hint
  if [[ "$default_yes" == "1" ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s: ' "$question" "$hint" >&2
  local input
  IFS= read -r input || return 1
  case "$input" in
    [yY]|[yY][eE][sS]) return 0 ;;
    [nN]|[nN][oO])     return 1 ;;
    "")                [[ "$default_yes" == "1" ]] && return 0 || return 1 ;;
    *)                 return 1 ;;
  esac
}

# set_env_value <key> <value> <file>
# Update or append KEY=VALUE in .env. Use awk to preserve literal values and avoid sed/perl escaping issues.
set_env_value() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^[[:space:]]*${key}=" "$file"; then
    local tmp="$file.tmp.$$"
    awk -v k="$key" -v v="$value" '
      $0 ~ ("^[[:space:]]*" k "=") { print k "=" v; next }
      { print }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ensure_knowledge_service_key
# Shared Panel/Knowledge service authentication key.
# Generate and save a random key when empty or a placeholder; reuse existing keys across restarts.
# The caller injects the same value into memory-hub under two variable names:
# KNOWLEDGE_SERVICE_KEY: verified by Knowledge.
# KNOWLEDGE_AUTH_TOKEN: used by Panel when calling Knowledge.
ensure_knowledge_service_key() {
  if [[ -z "${KNOWLEDGE_SERVICE_KEY:-}" || "${KNOWLEDGE_SERVICE_KEY}" == "REPLACE_ME" ]]; then
    local rand
    if command -v openssl >/dev/null 2>&1; then
      rand="$(openssl rand -hex 24)"
    else
      rand="$(head -c 24 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
    fi
    KNOWLEDGE_SERVICE_KEY="ks-svc-${rand}"
    set_env_value KNOWLEDGE_SERVICE_KEY "$KNOWLEDGE_SERVICE_KEY" "$ENV_FILE"
    info "Generated KNOWLEDGE_SERVICE_KEY and saved it in $ENV_FILE (shared by Panel and Knowledge)"
  fi
}

# interactive_llm_setup
# Configure memory and proxy LLM settings interactively, check connectivity with retries, then save to .env.
# Update the exported MEMORY_LLM_* / PROXY_UPSTREAM_* variables and persist them in .env.
interactive_llm_setup() {
  local base key model proto reuse_same

  echo ""
  info "═══ Interactive LLM setup (Enter keeps the current value) ═══════════════════"

  # Memory LLM settings
  while true; do
    base=$(prompt_with_default "Memory group LLM BASE_URL" "${MEMORY_LLM_BASE_URL:-}")
    key=$(prompt_with_default "Memory group LLM API_KEY" "${MEMORY_LLM_API_KEY:-}")
    model=$(prompt_with_default "Memory group LLM MODEL" "${MEMORY_LLM_MODEL:-}")
    proto=$(prompt_protocol "${MEMORY_LLM_PROTOCOL:-openai}")

    if check_llm_group "Memory group" "$base" "$key" "$model" "$proto"; then
      MEMORY_LLM_BASE_URL="$base"
      MEMORY_LLM_API_KEY="$key"
      MEMORY_LLM_MODEL="$model"
      MEMORY_LLM_PROTOCOL="$proto"
      break
    fi
    warn "Memory LLM connectivity check failed."
    prompt_confirm "Enter the settings again?" 1 || die "Setup canceled; exiting."
  done

  if [[ "${PROXY_ENABLED:-1}" == "1" ]]; then
    # Proxy LLM settings
    # Reuse the memory settings by default (press Enter) when:
    # 1) The proxy settings in .env exactly match the newly entered memory settings; or
    # 2) The proxy settings are empty / REPLACE_ME (convenient for initial setup).
    reuse_same=0
    if [[ "${PROXY_UPSTREAM_URL:-}" == "$MEMORY_LLM_BASE_URL" && \
          "${PROXY_UPSTREAM_API_KEY:-}" == "$MEMORY_LLM_API_KEY" && \
          "${PROXY_UPSTREAM_MODEL:-}" == "$MEMORY_LLM_MODEL" ]]; then
      reuse_same=1
    elif [[ -z "${PROXY_UPSTREAM_URL:-}" || "${PROXY_UPSTREAM_URL:-}" == "REPLACE_ME" ]] && \
         [[ -z "${PROXY_UPSTREAM_API_KEY:-}" || "${PROXY_UPSTREAM_API_KEY:-}" == "REPLACE_ME" ]] && \
         [[ -z "${PROXY_UPSTREAM_MODEL:-}" || "${PROXY_UPSTREAM_MODEL:-}" == "REPLACE_ME" ]]; then
      reuse_same=1
    fi

    if prompt_confirm "Reuse the memory LLM settings for Proxy?" "$reuse_same"; then
      PROXY_UPSTREAM_URL="$MEMORY_LLM_BASE_URL"
      PROXY_UPSTREAM_API_KEY="$MEMORY_LLM_API_KEY"
      PROXY_UPSTREAM_MODEL="$MEMORY_LLM_MODEL"
      ok "Proxy reuses the memory LLM settings; skipping duplicate checks."
    else
      while true; do
        base=$(prompt_with_default "Proxy group UPSTREAM_URL" "${PROXY_UPSTREAM_URL:-}")
        key=$(prompt_with_default "Proxy group UPSTREAM_API_KEY" "${PROXY_UPSTREAM_API_KEY:-}")
        model=$(prompt_with_default "Proxy group UPSTREAM_MODEL" "${PROXY_UPSTREAM_MODEL:-}")

        if check_llm_group "Proxy group" "$base" "$key" "$model" openai; then
          PROXY_UPSTREAM_URL="$base"
          PROXY_UPSTREAM_API_KEY="$key"
          PROXY_UPSTREAM_MODEL="$model"
          break
        fi
        warn "Proxy LLM connectivity check failed."
        prompt_confirm "Enter the settings again?" 1 || die "Setup canceled; exiting."
      done
    fi
  fi

  # Save to .env
  info "Saving LLM settings to $ENV_FILE"
  set_env_value MEMORY_LLM_BASE_URL "$MEMORY_LLM_BASE_URL" "$ENV_FILE"
  set_env_value MEMORY_LLM_API_KEY "$MEMORY_LLM_API_KEY" "$ENV_FILE"
  set_env_value MEMORY_LLM_MODEL "$MEMORY_LLM_MODEL" "$ENV_FILE"
  set_env_value MEMORY_LLM_PROTOCOL "$MEMORY_LLM_PROTOCOL" "$ENV_FILE"
  if [[ "${PROXY_ENABLED:-1}" == "1" ]]; then
    set_env_value PROXY_UPSTREAM_URL "$PROXY_UPSTREAM_URL" "$ENV_FILE"
    set_env_value PROXY_UPSTREAM_API_KEY "$PROXY_UPSTREAM_API_KEY" "$ENV_FILE"
    set_env_value PROXY_UPSTREAM_MODEL "$PROXY_UPSTREAM_MODEL" "$ENV_FILE"
  fi
  ok "LLM settings saved in $ENV_FILE"
}

# ═══════════════════════════════════════════════════════════════
# Port preflight checks
# ═══════════════════════════════════════════════════════════════

# port_in_use <port>
# Check whether a host port is listening. Return 0 if occupied, 1 if free.
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"
  else
    return 1  # Without a detection tool, assume the port is free and allow startup.
  fi
}

# tdai_self_ports
# Print the host ports published by running TDAI stack containers, separated by spaces.
# Existing stack containers will be recreated by rm_container_if_exists, so their ports are not conflicts.
tdai_self_ports() {
  local c p ports=""
  for c in tdai-proxy tdai-memory-hub tdai-memory-core; do
    if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      p="$($DOCKER port "$c" 2>/dev/null | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ' || true)"
      ports="$ports $p"
    fi
  done
  printf '%s' "$ports"
}

# check_ports
# Check all target ports before startup; fail if an external process occupies a port.
# Exclude ports occupied by existing TDAI containers that will be recreated.
check_ports() {
  local self_ports port_var port conflict=0
  self_ports=" $(tdai_self_ports) "
  info "═══ Port preflight checks ══════════════════════════════════════════"
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    [[ "$port_var" == PROXY_PORT && "${PROXY_ENABLED:-1}" != "1" ]] && continue
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if [[ "$self_ports" == *" $port "* ]]; then
      info "Port $port ($port_var) belongs to an existing TDAI container that will be recreated; skipping."
      continue
    fi
    if port_in_use "$port"; then
      echo "${C_RED}[error]${C_RST} Port $port ($port_var) is occupied. Free it or change the port in .env." >&2
      conflict=1
    else
      ok "Port $port ($port_var) is available."
    fi
  done
  (( conflict == 0 )) || die "Port conflicts detected. Free the ports and retry."
}
