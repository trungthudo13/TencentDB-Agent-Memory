# Local deployment with TDAI shared images

Local startup scripts for `memory-core`, `memory-hub`, and `proxy`. Run components independently or start the stack with one command.

## Components and ports

| Component | Container | Public Docker Hub image | Host ports | Purpose |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | Core gateway: memory reads/writes, authentication, and Skill/RAG data plane |
| **memory-hub** | `tdai-memory-hub` | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) | `8125` / `8424` | Combined management Panel and Knowledge Service |
| **proxy** | `tdai-proxy` | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM forwarding proxy and coding-agent API entry point |

> All three images are published in the [`agentmemory`](https://hub.docker.com/u/agentmemory) Docker Hub namespace
> for `linux/amd64` and `linux/arm64`; public pulls do not require login. To pin a version, replace
> `:latest` in `.env` with a version such as `:1.0.0-beta.1`.
>
> Tencent internal users can select the private registry at `mirrors.tencent.com/memory-team-control/`.
> See the commented alternative image settings in `.env.example`.

## Requirements

- macOS / Linux
- Docker: Docker Desktop, Colima, or OrbStack.
- `bash` 4+; macOS's bundled Bash 3.2 is also supported.

## Quick start

```bash
cd TencentDB-Agent-Memory/deploy/global-images

# Copy .env if needed, configure LLM settings interactively, verify connectivity, and start services.
./start-all.sh
```

`start-all.sh` is **interactive** and performs these steps:

1. Copy `.env.example` to `.env` automatically if it does not exist.
2. Ask for two groups of LLM settings; **Enter keeps the current default**:
   - Memory: `BASE_URL`, `API_KEY`, and `MODEL`, with `openai` as the default protocol.
   - Proxy: first ask whether to reuse the memory settings; skip separate input if you agree.
3. **Check LLM connectivity immediately** and offer retries until the check passes.
4. **Save the settings to `.env`** for reuse on subsequent starts.
5. Start the stack after validation succeeds.

> To use settings prepared in advance, run `cp .env.example .env` and fill in the LLM configuration,
> then run `./start-all.sh` and press Enter to confirm the values loaded from `.env`.

### MongoDB storage backend (optional, experimental)

**SQLite** remains the default: no external dependencies, with data in container volumes. The MongoDB data plane is **experimental**,
disabled by default, and not recommended as the production default. When enabled, L0/L1/profile/skill documents use MongoDB with mongot
native BM25 retrieval; metadata uses MongoDB by default as well:

```bash
./start-all-mongo.sh    # Reuse start-all.sh and save MEMORY_CORE_STORE_MODE=mongodb in .env.
```

- The script writes `MEMORY_CORE_STORE_MODE=mongodb` to `.env`, so later `./start-all.sh` runs
  keep MongoDB rather than silently reverting to SQLite. To switch back, comment out the setting or change it to
  `sqlite`, then run `./start-all.sh`.
- If `MONGODB_ENDPOINT` is unset, start a local `mongodb-atlas-local` container
  bundling mongod and mongot; this is **not** cloud Atlas. Data persists in `mongo-local-*` volumes,
  which `stop-all.sh --purge` also removes.
- To use external MongoDB (cloud Atlas or a replica set with mongot), configure
  `MONGODB_ENDPOINT` in `.env`.
- **Switching backends does not migrate existing data.** SQLite uses `MEMORY_CORE_VOLUME`; MongoDB uses
  `mongo-local-*` volumes or an external instance. Existing data remains in its original backend. This version requires
  manual backup and migration; an official migration tool is planned. In both modes, L2/L3 files remain in
  `MEMORY_CORE_VOLUME`.

### Dry-run validation (optional)

Run `verify.sh` independently to check the environment without starting containers:

```bash
./verify.sh              # Full validation, including LLM connectivity.
./verify.sh --skip-llm    # Skip LLM checks for an offline validation.
```

## LLM connectivity preflight

`verify.sh` checks both LLM groups by default; disable this with `--skip-llm`:

- **OpenAI-compatible protocol**: `GET {base}/models` checks the API key and URL **without consuming tokens**.
- **Anthropic protocol**: `POST {base}/v1/messages` with `max_tokens=1` sends a minimal message and consumes at most 10 tokens.
- **Memory and Proxy settings** are checked independently; identical configurations skip the duplicate check.
- **Running containers** repeat curl checks internally to verify container-to-LLM connectivity, which can differ from host connectivity under corporate proxies or DNS isolation.

Example failure:

```
[error] Memory group Invalid API key (HTTP 401): https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

Invalid API keys, URLs, and model names are checked before startup, rather than waiting for Wiki ingestion or chat requests to fail.

After startup:

- Panel UI：<http://localhost:8125/>
- Knowledge API：<http://localhost:8424/v3/>
- Knowledge Swagger：<http://localhost:8424/docs>
- Memory Gateway：<http://localhost:8420/>
- Proxy：<http://localhost:8096/>

## Two independent configuration groups

Memory and Proxy LLM settings are completely independent and can use different providers and models.

### Memory group: used by memory-core and memory-hub

These settings serve Core memory embedding/summarization and Knowledge Wiki ingestion/summarization.

| Variable | Description | Example |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI-compatible base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | API key for the endpoint | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | Model ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` or `anthropic`; default `openai` | `openai` |

### Proxy group: used by Proxy

Proxy forwards user requests to this upstream endpoint.

| Variable | Description | Example |
|---|---|---|
| `PROXY_UPSTREAM_URL` | Upstream base URL | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | Forwarding API key | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | User-facing model ID | `deepseek-chat` |

> Both groups can use the same LLM or different ones: for example, a cheaper model for internal memory work and a stronger model for primary conversations.

The scripts **report all missing settings together before startup** and exit with status `1`, avoiding partial startup failures.

## Memory prompt modes (chat / code)

Set `MEMORY_PROMPT_MODE` to select the L1/L2/L3 pipeline prompt family:

| Mode | `.env` setting | Extracted content | L3 output | Use cases |
|---|---|---|---|---|
| **code** (default) | `MEMORY_PROMPT_MODE=code` | Project facts, tasks, decisions, SOPs, and constraints | Team Operating Doctrine | Coding agents, team collaboration, engineering projects |
| chat | `MEMORY_PROMPT_MODE=chat` | persona / episodic / instruction | persona.md (personal profile) | Personal assistants, casual chat, teaching |

> **Note**: casual chat in `code` mode may yield no memories if the LLM finds no reusable engineering content. If L1 remains empty, check that `MEMORY_PROMPT_MODE` matches the conversation type.

## Internal credentials (review before production)

Services authenticate to Core using `MEMORY_CORE_GATEWAY_API_KEY`. On first startup,
`init-admin` creates a `system_admin` account. For **local setup without extra configuration**, the documented defaults are:

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | Bearer credential for memory-hub / Proxy requests to memory-core |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | Initial system_admin username |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | Login key for that admin user |
| `KNOWLEDGE_SERVICE_KEY` | **Generated random value** | Panel-to-Knowledge Bearer credential, required for write/admin endpoints |

> `KNOWLEDGE_SERVICE_KEY` has no fixed default: first startup generates a random `ks-svc-*` value
> and saves it to `.env` for reuse across restarts. The same value is injected into memory-hub as
> `KNOWLEDGE_SERVICE_KEY` (Knowledge verification) and `KNOWLEDGE_AUTH_TOKEN` (Panel requests).
> For multi-machine or externally orchestrated deployments, set your own value in `.env`; existing values are respected.

> These three fixed defaults are suitable only for local testing. **Replace them with long random values before production, integration environments, or public exposure**,
> or anyone who can access the ports could obtain system_admin privileges.
>
> Uncomment and override the corresponding settings in `.env`. `_lib.sh` uses `require_vars`
> for other mandatory settings; the fixed-default credentials trigger startup warnings reminding you to replace them.

## Run components independently

Run the component scripts separately for debugging or when only some features are needed:

```bash
./start-memory-core.sh   # Core gateway only (8420).
./start-memory-hub.sh    # Panel + Knowledge (8125 + 8424); requires MEMORY_LLM_*.
./start-proxy.sh         # Proxy only (8096); requires PROXY_UPSTREAM_*.
```

Dependencies:

- **memory-core**: starts independently without external service dependencies.
- **memory-hub**: can start independently with `LLM_MODE=custom`, but Knowledge RAG requests to Core fail if Core is unavailable; start Core first.
- **proxy**: can start independently, falling back to passthrough when cost-guard is unavailable; authentication, memory, and Skill injection require Core.

Missing dependencies produce warnings without blocking startup.

## Data persistence

- `tdai-memory-core-data` (named volume): Core SQLite and memory data.
- `tdai-panel-data` (named volume): Knowledge SQLite, cloned repositories, and Wiki files inside memory-hub.

Data remains until `docker volume rm`. Override volume names with `MEMORY_CORE_VOLUME` / `PANEL_VOLUME` in `.env`.

## Stop and clean up

```bash
./stop-all.sh            # Stop containers and keep volumes for the next startup.
./stop-all.sh --purge    # Remove containers, volumes, and network.
```

## View logs

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub runs Panel and Knowledge as separate processes. Their container logs are at `/data/knowledge/logs/panel.log` and `/data/knowledge/logs/knowledge.log`.

## Port conflicts

If `8125`, `8420`, `8424`, or `8096` conflicts with an existing service, change the ports in `.env`:

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# Update Knowledge's external URL to match KNOWLEDGE_PORT.
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## Use Proxy as your coding agent's API base

For example, with Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# OpenAI-protocol clients use a similar setting: OPENAI_BASE_URL=http://localhost:8096/v1
```

Panel's "Client connection address" card combines the host's LAN IP and `PROXY_PORT`, for example
`http://192.168.1.100:8096/codebuddy/default`, so teammates can copy the address to connect.
`MEMORY_HUB_PROXY_PUBLIC_URL` supplies the `metadata-instances.json.proxy_endpoint` value inside memory-hub.
When unset, the script detects the address using `hostname -I` or macOS `ipconfig getifaddr en0`, then falls back to `localhost` if detection fails.
Panel-to-Core forwarding is independent of this variable and always uses `REMOTE_INSTANCE_URL` → memory-core:8420.
If autodetection chooses the wrong address due to multiple interfaces, a public domain, or a reverse proxy, explicitly set
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<your-host>:8096` in `.env`. To preserve the UI fallback to
`gateway_endpoint`, set `MEMORY_HUB_PROXY_PUBLIC_URL` to an explicitly empty string.

Standalone `proxy` startup disables `auth`, `sessionInit`, and `costGuard` by default because they depend on internal services. It forwards requests with `tdai-memory` context injection (an injector name, not a container name). Configure the full pipeline separately; see `context_proxy/config.example.yaml`.

## Troubleshooting

**Q: Why is `./start-all.sh` waiting in wait_healthy?**
The image may still be downloading. Run `docker pull <IMAGE>` first, then rerun the script.

**Q: Why does memory-hub start but Panel fail to open?**

Ensure `KNOWLEDGE_PUBLIC_BASE_URL` in `.env` includes `/v3`; Panel reports an error if the prefix is missing.

**Q: Why does Proxy forwarding return 401?**
Check `PROXY_UPSTREAM_API_KEY` and `PROXY_UPSTREAM_URL`. Inspect errors with `docker logs tdai-proxy`.

**Q: How can containers access other host services such as Ollama or Langfuse?**
The scripts add `--add-host=host.docker.internal:host-gateway` by default. Use `http://host.docker.internal:<port>` inside containers.

## Local MCP for direct RAG

MCP runs on each member's machine, independently of the server deployment.
`start-all.sh` starts Core, Hub, and optional Proxy; it does not build, start,
check ports for, or print endpoints for MCP.

For RAG-only server deployment, set `PROXY_ENABLED=0` in `.env` and run
`./start-all.sh`. Core and Knowledge still use their internal LLM settings
for extraction and ingestion. This toggle does not stop an existing Proxy
container; use `./stop-all.sh` before switching modes if necessary.

Each member installs and configures the read-only stdio adapter in
[`adapters/memory-rag-mcp`](../../adapters/memory-rag-mcp/README.md), pointing
to the shared server's reachable Core (`8420`) and Knowledge (`8424`) URLs.
Use the actual team/agent/user IDs associated with the desired memories.
The agent keeps its existing LLM provider. No MCP listening port is needed.

`stop-all.sh` still removes an old `tdai-mcp` container from the previous
sidecar deployment for migration cleanup. It does not stop member-local MCP processes.
