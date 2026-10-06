#!/usr/bin/env bash
# Dry-run validation: check readiness without starting containers.
#
# Usage:
# ./verify.sh               # Full validation, including LLM connectivity.
# ./verify.sh --skip-llm     # Skip external LLM requests for offline checks.
#
# Checks:
# 1. Docker is available.
# 2. .env exists.
# 3. Required settings are nonempty and not REPLACE_ME.
# 4. Images exist locally (missing images are warnings, not failures).
# 5. Target ports are available.
# 6. Independently check the memory and proxy upstream LLM connections.
# - OpenAI: GET {base}/models without token consumption.
# - Anthropic: POST {base}/v1/messages with max_tokens=1; consumes at most 10 tokens.
# - If containers are running, repeat the request inside them to verify container-to-LLM connectivity.
#
# All checks pass: exit 0. Errors: exit 1. Warnings only: exit 0.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SKIP_LLM=0
for arg in "$@"; do
  case "$arg" in
    --skip-llm) SKIP_LLM=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) warn "Unknown argument: ${arg} (ignored)" ;;
  esac
done

ERRORS=0
WARNS=0
CURL=/usr/bin/curl

# LLM connectivity check helpers
# check_llm_openai <label> <base_url> <api_key> <model>
# OpenAI-compatible: GET {base}/models validates auth and URL without consuming tokens.
# Normalize base_url, which may include /v1 or omit it.
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  # Normalize by stripping trailing /, /messages, or /chat/completions.
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" \
    "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    # Check whether the model appears in the list; a missing match only produces a warning.
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI connectivity OK ($model is listed in /models)"
    else
      ok "$label OpenAI connectivity OK (${model} is not listed in /models but may still be usable)"
    fi
    rm -f "$body_file"
    return 0
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "${C_RED}[error]${C_RST} $label Invalid API key (HTTP ${code}):$url" >&2
    head -c 200 "$body_file" >&2; echo >&2
    rm -f "$body_file"
    return 1
  elif [[ "$code" == "404" ]]; then
    # Some providers lack /models; try Anthropic-style checking or warn instead of failing.
    warn "$label GET /models returned 404; the provider may not expose it. Trying an Anthropic protocol check."
    check_llm_anthropic "$label" "$base" "$key" "$model"
    rm -f "$body_file"
    return $?
  else
    warn "$label Cannot reach ${url} (HTTP=${code})$(head -c 100 "$body_file" 2>/dev/null)"
    rm -f "$body_file"
    return 1
  fi
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
# Anthropic: POST {base}/v1/messages with max_tokens=1 consumes at most 10 tokens and checks URL, auth, and model.
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  # Use a URL ending in /messages directly; otherwise append /v1/messages.
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
    -H "x-api-key: $key" \
    -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  case "$code" in
    200)
      ok "$label Anthropic connectivity OK (model $model responded)"
      rm -f "$body_file"; return 0 ;;
    401|403)
      echo "${C_RED}[error]${C_RST} $label Invalid API key (HTTP ${code}):$url" >&2
      head -c 200 "$body_file" >&2; echo >&2
      rm -f "$body_file"; return 1 ;;
    404)
      echo "${C_RED}[error]${C_RST} $label URL not found (HTTP 404): $url; check BASE_URL" >&2
      rm -f "$body_file"; return 1 ;;
    400)
      # HTTP 400 often means an unknown model or request-body validation failure.
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        echo "${C_RED}[error]${C_RST} $label Invalid model '$model' (HTTP 400)" >&2
        rm -f "$body_file"; return 1
      fi
      warn "$label HTTP 400 (possibly request formatting rather than connectivity):$(head -c 150 "$body_file")"
      rm -f "$body_file"; return 0 ;;
    *)
      warn "$label Cannot reach ${url} (HTTP=${code})$(head -c 100 "$body_file" 2>/dev/null)"
      rm -f "$body_file"; return 1 ;;
  esac
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "Checking $label connectivity (protocol=${proto}, base=${base}, model=${model})..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# Optional container-side curl validation when the container is running.
check_llm_from_container() {
  local container="$1" label="$2" base="$3" key="$4" model="$5" proto="${6:-openai}"
  if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$container"; then
    return 0  # Skip stopped containers; this is not an error.
  fi
  info "  ↳ Repeating the $label check inside container $container..."
  # Check network reachability: any HTTP status indicates a connection; 000 means unreachable.
  # Authentication errors were already reported on the host; do not count them twice.
  local url code
  case "$proto" in
    anthropic)
      base="${base%/}"; [[ "$base" == */messages ]] || base="${base}/v1/messages"
      url="$base"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 15 \
         -w "%{http_code}" -X POST -H "Content-Type: application/json" \
         -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" \
         -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
         "$url" 2>/dev/null || echo "000")
      ;;
    *)
      base="${base%/}"; base="${base%/v1}"
      url="${base}/v1/models"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 10 \
         -w "%{http_code}" -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
      ;;
  esac
  if [[ "$code" == "000" ]]; then
    warn "  Container ${container} cannot reach ${url} (network isolation / DNS failure)."
    WARNS=$((WARNS+1))
  else
    ok "  Container ${container} can reach $label (HTTP ${code})."
  fi
}

# 1. docker
if command -v "$DOCKER" >/dev/null 2>&1 || [[ -x "$DOCKER" ]]; then
  ok "Docker available: $DOCKER"
else
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} Docker unavailable" >&2
fi

# 2. .env
if [[ ! -f "$ENV_FILE" ]]; then
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} $ENV_FILE does not exist. Run: cp .env.example .env" >&2
else
  ok ".env exists"
  set -a; source "$ENV_FILE"; set +a

  # 3. Required settings
  MISSING=()
  for var in \
    MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
    MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
    MEMORY_CORE_VOLUME PANEL_VOLUME \
    MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
    KNOWLEDGE_PUBLIC_BASE_URL \
    PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL; do
    val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      MISSING+=("$var")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    ERRORS=$((ERRORS+1))
    echo "${C_RED}[error]${C_RST} The following required settings are missing:${MISSING[*]}" >&2
  else
    ok "All required settings are configured."
  fi

  # 4. Local image availability
  for img_var in MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE; do
    img="${!img_var:-}"
    if [[ -z "$img" ]]; then continue; fi
    if $DOCKER image inspect "$img" >/dev/null 2>&1; then
      ok "Image exists locally: $img"
    else
      WARNS=$((WARNS+1))
      warn "Image is not local; startup will pull it: $img"
    fi
  done

  # 5. Port availability (warnings only)
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      WARNS=$((WARNS+1))
      warn "Port $port ($port_var) is occupied; free it or change the port in .env before startup."
    else
      ok "Port $port ($port_var) is available."
    fi
  done

  # 6. LLM connectivity (enabled unless --skip-llm is passed)
  if (( SKIP_LLM == 1 )); then
    info "Skipping LLM connectivity checks (--skip-llm)."
  elif (( ${#MISSING[@]} > 0 )); then
    warn "Skipping LLM connectivity checks (required settings are missing)."
  else
    echo ""
    info "═══ LLM connectivity checks ═══════════════════════════════════════"

    # Memory settings
    if ! check_llm_group "Memory group" "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" \
         "$MEMORY_LLM_MODEL" "${MEMORY_LLM_PROTOCOL:-openai}"; then
      ERRORS=$((ERRORS+1))
    fi
    # Repeat inside a running container.
    check_llm_from_container tdai-memory-hub "Memory group (from container)" \
      "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" "$MEMORY_LLM_MODEL" \
      "${MEMORY_LLM_PROTOCOL:-openai}"

    # Proxy settings: skip a duplicate check if identical to the memory settings.
    if [[ "$PROXY_UPSTREAM_URL" == "$MEMORY_LLM_BASE_URL" && \
          "$PROXY_UPSTREAM_API_KEY" == "$MEMORY_LLM_API_KEY" && \
          "$PROXY_UPSTREAM_MODEL" == "$MEMORY_LLM_MODEL" ]]; then
      ok "Proxy and memory settings are identical; skipping duplicate checks."
    else
      # The proxy uses OpenAI by default, matching config.yaml.
      if ! check_llm_group "Proxy group" "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" \
           "$PROXY_UPSTREAM_MODEL" openai; then
        ERRORS=$((ERRORS+1))
      fi
      check_llm_from_container tdai-proxy "Proxy group (from container)" \
        "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" "$PROXY_UPSTREAM_MODEL" openai
    fi
  fi
fi

echo ""
if (( ERRORS > 0 )); then
  echo "${C_RED}✗ ${ERRORS} errors, ${WARNS} warnings; cannot start.${C_RST}" >&2
  exit 1
elif (( WARNS > 0 )); then
  echo "${C_YLW}⚠ ${WARNS} warnings; startup is possible, but review the messages above.${C_RST}"
  exit 0
else
  echo "${C_GRN}✓ All checks passed; run ./start-all.sh.${C_RST}"
  exit 0
fi
