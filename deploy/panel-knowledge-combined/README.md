# Memory Hub

**Memory Hub** is a combined image running two services in one container: Team Memory Control (Panel) and Knowledge Service (KS).

- **Panel**: the console for managing teams, agents, and knowledge resources.
- **KS**: Wiki and Code Graph knowledge services accessible through agent tools.

The image is published on Docker Hub as [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub); pulling `latest` is recommended.

---

## Prerequisites

### 1. Instance configuration file

After purchasing a cloud Memory instance, you receive an **instance ID**, **Gateway address**, and **API key**. Put them in a JSON file such as `metadata-instances.json`:

```json
{
  "instances": [
    {
      "id": "mem-xxxxxxxx",
      "name": "My Memory instance",
      "gateway_endpoint": "<your-gateway>.ap-shanghai",
      "api_key": "your-gateway-api-key"
    }
  ]
}
```

Set `gateway_endpoint` to the Gateway address from the console. The example uses the Shanghai region; use your actual address. Add more objects to `instances` for multiple instances.

### 2. Externally reachable KS address

Expose KS at an address that agents and the cloud Gateway can reach for tool calls. It **must be externally reachable** (not `127.0.0.1` / `localhost`) and **must include** `/v3`.

For example, if the host's public or private IP is `10.2.3.4` and the mapped port is `8424`, use:

`http://10.2.3.4:8424/v3`

### 3. LLM Proxy address

KS calls an LLM for Wiki ingestion and summarization. By default, it uses Memory's LLM forwarding service.

`KNOWLEDGE_LLM_PROXY_BASE_URL` is **the same address** as `gateway_endpoint`: the Gateway address from the Memory console. For example, in the Shanghai region:

`<your-gateway>.ap-shanghai`

For other regions, use the actual address shown in the console.

To use your own LLM endpoint, see [Custom mode](#custom-mode-direct-llm-connection-without-proxy) below.

---

## Quick start

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=<your-gateway>.ap-shanghai \
  agentmemory/memory-hub:latest
```

> Replace `/path/to/metadata-instances.json`, `10.2.3.4` (the external KS address), and `KNOWLEDGE_LLM_PROXY_BASE_URL` (the same actual Gateway address as `gateway_endpoint`) with your own values.

### Required settings (only these three)

| Setting | How to provide it | Description |
| --- | --- | --- |
| Instance configuration | Mount `metadata-instances.json` | Cloud Memory instance ID, Gateway address, and API key |
| External KS address | `KNOWLEDGE_PUBLIC_BASE_URL` | Externally reachable KS address; **must include** `/v3` |
| LLM Proxy address | `KNOWLEDGE_LLM_PROXY_BASE_URL` | Same as `gateway_endpoint`; use the Gateway address from the Memory console |

You must supply these three settings. All other settings have image defaults and can be adjusted as needed.

---

## Optional configuration

These settings have image defaults and work without explicit overrides. Change them as needed.

### LLM configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `LLM_PROTOCOL` | `openai` | `openai` uses `/chat/completions`; `anthropic` uses `/messages` |
| `LLM_MODEL` | `Memory-Model` | Model ID forwarded to Proxy / TokenHub |
| `LLM_MODE` | `proxy` | `proxy`: Memory Gateway LLM forwarding; `custom`: direct connection to your own endpoint |
| `LLM_MAX_TOKENS` | `32768` | Maximum output tokens per LLM call |
| `LLM_TIMEOUT_MS` | `1200000` | LLM timeout in milliseconds (20 minutes; reasoning models may need longer) |
| `LLM_API_KEY` | Empty | Required only for `LLM_MODE=custom` |
| `LLM_BASE_URL` | Empty | Required only for `LLM_MODE=custom`, for example `https://api.openai.com/v1` |

**Protocol and model compatibility**:

| Protocol | Compatible models | Endpoint |
| --- | --- | --- |
| `openai` (default) | `Memory-Model`, `deepseek-v4-pro` | `/chat/completions` |
| `anthropic` | `ep-pksklwtb`, `claude-sonnet-4-5`, etc. | `/messages` |

When changing models, select the matching protocol:

```bash
# Default: OpenAI protocol + Memory-Model.
# No additional configuration is needed; these are the image defaults.

# Switch to an Anthropic model.
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

### Network and storage

| Environment variable | Default | Description |
| --- | --- | --- |
| `PANEL_PORT` | `8125` | Panel service port |
| `KNOWLEDGE_PORT` | `8424` | KS service port |
| `KNOWLEDGE_DATA_DIR` | `/data/knowledge` | KS data directory: SQLite, cloned repositories, Wiki files, and logs |
| `KNOWLEDGE_DB_PATH` | `/data/knowledge/knowledge.db` | KS SQLite database path |
| `TMC_CALLBACK_URL` | `http://127.0.0.1:8125` | Panel root URL for KS ingestion callbacks; container loopback is configured automatically and usually needs no change |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Timeout for Panel requests to KS |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Timeout for Panel requests to the remote Gateway |
| `REMOTE_INSTANCE_PROXY_URL` | Empty | Base URL displayed in Panel's "Client connection address" card. For local deployments with separate Core and Proxy services, set the external Proxy URL (for example `http://host.docker.internal:8096`) so copied CodeBuddy / Claude Code addresses point to Proxy. Empty values preserve the fallback to `gateway_endpoint`. **Panel-to-Core forwarding always uses `REMOTE_INSTANCE_URL` independently of this setting.** Ignored when mounting `metadata-instances.json`; add `proxy_endpoint` to that JSON instead. |

### TLS certificates

Publicly trusted certificates normally need no extra configuration. If an HTTPS LLM Proxy or Gateway uses a certificate the container does not trust (such as a self-signed certificate or internal CA), use one of these methods:

**Method A: disable TLS verification (quick testing only; not recommended for production)**

```bash
-e NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Method B: mount a CA certificate (recommended)**

```bash
-v /path/to/your-ca.pem:/usr/local/share/ca-certificates/extra-ca.crt:ro \
-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
```

| Environment variable | Default | Description |
| --- | --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Unset | Set to `0` to skip TLS certificate verification (testing only) |
| `NODE_EXTRA_CA_CERTS` | Unset | Additional CA certificate path; supported by Node.js and the AI SDK's fetch calls |

### Logging

| Environment variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, or `error` |
| `LOG_FORMAT` | `json` | Log format: `json` or `text` |
| `LOG_DIR` | `/data/knowledge/logs` | Log directory |

Logs are written to `${LOG_DIR}/panel.log` and `${LOG_DIR}/knowledge.log`, rotated to one `.prev` file on each startup, and also sent to stdout for `docker logs`.

### Observability (Langfuse)

Configure all three variables to report KS LLM traces to Langfuse automatically.

| Environment variable | Default | Description |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | Empty | Langfuse service URL |
| `LANGFUSE_PUBLIC_KEY` | Empty | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | Empty | Langfuse secret key |

### LLM binding synchronization

| Environment variable | Default | Description |
| --- | --- | --- |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `1` | Synchronize instance KS llm_binding on Panel startup. Forced to `1` for `LLM_MODE=proxy`; set to `0` in custom mode to use global KS configuration |

---

## Service addresses

| Service | Address |
| --- | --- |
| Panel UI | `http://localhost:8125/` |
| Panel API | `http://localhost:8125/api/v1/` |
| KS Health | `http://localhost:8424/health` |
| KS API | `http://localhost:8424/v3/` |
| KS Swagger documentation | `http://localhost:8424/docs` |

---

## Custom mode: direct LLM connection without Proxy

Specify your own LLM endpoint to bypass Memory Gateway LLM forwarding. `KNOWLEDGE_LLM_PROXY_BASE_URL` is not needed in this mode.

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_API_KEY=sk-your-llm-key \
  -e LLM_BASE_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  agentmemory/memory-hub:latest
```

---

## Data persistence

| Mount point | Description |
| --- | --- |
| `/data/knowledge` | KS data: SQLite, cloned repositories, Wiki files, and logs |

Use a named volume such as `-v memory-hub:/data/knowledge`, matching the container name.

---

## Troubleshooting

### Q: How can the container access services on the host?

The cloud Gateway (`KNOWLEDGE_LLM_PROXY_BASE_URL`) is normally reachable directly; do not replace it with a host address. For other host-side services, such as Langfuse, use `172.17.0.1` (the docker0 bridge) instead of `localhost`:

```bash
-e LANGFUSE_BASE_URL=http://172.17.0.1:8400
```

Alternatively, add `--add-host=host.docker.internal:host-gateway` and use `host.docker.internal`.

### Q: Why does Wiki ingestion time out?

Reasoning models may need more than 20 minutes for large files:

```bash
-e LLM_TIMEOUT_MS=1800000  # 30 minutes
```

### Q: Why does tools/list return 404?

`KNOWLEDGE_PUBLIC_BASE_URL` must include `/v3`. Use the format `http://host:port/v3`.

### Q: Why do requests fail after changing the LLM protocol?

Ensure `LLM_PROTOCOL` matches `LLM_MODEL`:

```bash
# OpenAI model (default)
-e LLM_PROTOCOL=openai -e LLM_MODEL=Memory-Model

# Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

---

## Building

### Prerequisites

All source directories are under this repository's root:

```text
memory-tencentdb/
├── MemoryPanel/                         # Panel backend + web frontend
├── MemoryKnowledge/                     # Knowledge Service
└── deploy/panel-knowledge-combined/     # This build recipe
```

### Local single-platform build for debugging

```bash
cd deploy/panel-knowledge-combined
IMAGE_TAG=1.0.0-beta.1 ./build.sh          # Default linux/amd64 → team-memory-panel-knowledge:1.0.0-beta.1
PLATFORM=linux/arm64 IMAGE_TAG=arm64 ./build.sh   # Build directly on an arm64 machine.
```

### Publish to Docker Hub (amd64 + arm64)

Tag conventions:

| Tag | Meaning |
| --- | --- |
| `1.0.0-beta.N` | Pinned version for documentation and reproducibility |
| `beta` | Floating channel pointing to the newest beta; pushed by default with each release |
| `latest` | Reserved for stable releases; not pushed by default |

For the first release, publish `agentmemory/memory-hub:1.0.0-beta.1` and `agentmemory/memory-hub:beta`.

```bash
cd deploy/panel-knowledge-combined

# 1) Log in to Docker Hub with push access to the agentmemory organization.
docker login

# 2) Scan secrets and prepare the context without building.
DRY_RUN=1 VERSION=1.0.0-beta.1 ./publish.sh

# 3) Optional: load amd64 locally and inspect image layers for .env / metadata-instances.json.
PUSH=0 VERSION=1.0.0-beta.1 ./publish.sh

# 4) Build and push both platforms; also update :beta by default.
VERSION=1.0.0-beta.1 ./publish.sh

# Push only the version tag and leave :beta unchanged:
# ALSO_BETA=0 VERSION=1.0.0-beta.1 ./publish.sh

# Add latest for a stable release; do not enable this during beta:
# ALSO_LATEST=1 ALSO_BETA=0 VERSION=1.0.0 ./publish.sh
```

`publish.sh` performs these steps:

1. Run `scripts/secret-scan.sh` against `MemoryPanel` and `MemoryKnowledge`.
2. Generate the rsync context with `PREPARE_ONLY=1 ./build.sh`, excluding `.env*`, `metadata-instances.json`, and other sensitive files.
3. Scan the prepared context again.
4. Run `docker buildx build --platform linux/amd64,linux/arm64 --push` for `agentmemory/memory-hub:<VERSION>`, also tagging `:beta` by default. The local name `team-memory-panel-knowledge` is used only with `PUSH=0` and is never pushed.

Verify after pushing:

```bash
docker buildx imagetools inspect agentmemory/memory-hub:1.0.0-beta.1
docker buildx imagetools inspect agentmemory/memory-hub:beta
# Both tags should show linux/amd64 and linux/arm64 platforms with matching digests.
docker pull agentmemory/memory-hub:beta
```

Environment variable reference:

| Variable | Default | Description |
| --- | --- | --- |
| `VERSION` | `1.0.0-beta.1` | Version tag |
| `HUB_IMAGE` | `agentmemory/memory-hub` | Image repository |
| `PLATFORMS` | `linux/amd64,linux/arm64` | buildx targets |
| `BUILDER` | `multiarch` | buildx builder name; created automatically if missing |
| `DRY_RUN` | `0` | `1`: scan only |
| `PUSH` | `1` | `0`: local single-platform `--load` |
| `ALSO_BETA` | `1` | `1`: also push floating `:beta` |
| `ALSO_LATEST` | `0` | `1`: also push `:latest` |
