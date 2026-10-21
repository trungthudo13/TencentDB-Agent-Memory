# Codex — local project setup

Connect the Codex CLI to local MemoryProxy and Knowledge MCP. Keys are written
directly into a private config file inside the project. No memagent is required.
This guide uses Bash and an already installed Codex CLI.

Codex ignores provider routing keys in an ordinary project `.codex/config.toml`.
Use a separate **project-local Codex home**, `.codex-local/`, and select it on
each invocation. This makes its `config.toml` the active home configuration
without changing settings for other projects. Config, login, and sessions live
under this directory when file-based credentials are selected.
See OpenAI's [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [CODEX_HOME documentation](https://learn.chatgpt.com/docs/config-file/environment-variables).

## Step 1 — Start the local services

These instructions assume the Docker stack has already been configured in
`docker/.env`. From the **self_agent_memory repository root**, run:

```bash
docker compose -f docker/docker-compose.yml up -d --build memory memory-panel memory-proxy knowledgebase
curl -fsS http://127.0.0.1:8096/health
curl -fsS http://127.0.0.1:8421/health
```

The defaults are Panel `8125`, MemoryProxy `8096`, and Knowledge `8421`.
Adjust the client URLs below if you changed those ports. The client and Docker
stack must run on the same machine for these loopback URLs to work.

In `docker/memory-proxy.yaml`, check that `auth.enabled`,
`sessionInit.enabled`, `extraction.enabled`, `tdai.enabled`, and
`tdai.memory.writeL0` are `true` for conversation capture. Recall also needs
`injection.enabled` and `tdai.memory.inject`. These flags are enabled in the
current configuration. Keep the existing MemoryCore endpoints and service-token
settings. If MemoryCore uses a gateway key, configure the matching
`MEMORY_CORE_GATEWAY_API_KEY` in `docker/.env`.

After editing YAML, restart `memory-proxy`. After editing `.env`, recreate it
with `docker compose -f docker/docker-compose.yml up -d --force-recreate memory-proxy`.
A healthy proxy alone does not prove that model requests or capture work.

## Step 2 — Collect your local connection values

Open Memory Hub at <http://127.0.0.1:8125> and obtain:

- Your Memory Hub **user key**.
- A **team ID** you can access and an **agent ID** belonging to that team.
- Optionally, a task ID belonging to the same team.
- The Knowledge service key, if `KNOWLEDGE_SERVICE_KEY` is set in `docker/.env`.

Use IDs rather than display names. The Memory user key, Knowledge service key,
and model credential serve different purposes. The proxy removes
`x-tdai-user-key` before forwarding to the model and preserves model authentication.
`default` in the proxy URL is the memory instance ID, not the team ID.
The MCP `x-tdai-service-id` must match the tenant containing your Knowledge assets.

## Step 3 — Create a private Codex home in your working project

Switch to the **project you want Codex to work on**, which may be different from
the self_agent_memory checkout:

```bash
cd /path/to/your/project
mkdir -p .codex-local
chmod 700 .codex-local
```

For a Git project, add `/.codex-local/` to its local Git exclude file
(`git rev-parse --git-path info/exclude`). This directory will contain literal
keys and login state; keep it out of commits.

Create or merge into `.codex-local/config.toml`:

```toml
# Top-level settings must appear before the first [table].
model_provider = "memory_proxy"
cli_auth_credentials_store = "file"
# Optional: set model to an ID available to your ChatGPT account.
# model = "<YOUR_MODEL_ID>"

[model_providers.memory_proxy]
name = "Local MemoryProxy"
base_url = "http://127.0.0.1:8096/codex/default/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
stream_idle_timeout_ms = 120000

[model_providers.memory_proxy.http_headers]
x-tdai-user-key = "<MEMORY_HUB_USER_KEY>"
x-team-id = "<TEAM_ID>"
x-agent-id = "<AGENT_ID>"
# x-task-id = "<TASK_ID>"
```

Replace the placeholders directly in this file. No `MEMORY_USER_KEY`
environment variable or `env_http_headers` table is needed. Valid team and agent
headers register the session without a selection form. If you omit them or they
are invalid, initialize in **Plan mode** so the selection form can run.

This setup uses your **ChatGPT login** for model authentication. Keep the proxy's
`upstream.agents.codex.url` set to `https://chatgpt.com/backend-api/codex` and its
`apiKey` empty. HTTP/SSE is used because this proxy does not forward WebSockets.
Do not put the Memory user key in `experimental_bearer_token`.

## Step 4 — Add MCP to the same local config

Append this table to `.codex-local/config.toml` (merge if already present):

```toml
[mcp_servers.memory_knowledge]
url = "http://127.0.0.1:8421/mcp"
http_headers = { "x-tdai-service-id" = "default" }
```

If Knowledge has a service key, **replace** the `http_headers` line with:

```toml
http_headers = { "x-tdai-service-id" = "default", "Authorization" = "Bearer <KNOWLEDGE_SERVICE_KEY>" }
```

Replace the placeholder with the literal server key. No OAuth login is needed
for this MCP server. Codex supports static HTTP headers for Streamable HTTP
servers; see [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

```bash
chmod 600 .codex-local/config.toml
```

## Step 5 — Sign in and launch with the local home

From the same working project, sign in once for this isolated Codex home:

```bash
env CODEX_HOME="$PWD/.codex-local" codex login
env CODEX_HOME="$PWD/.codex-local" codex login status
```

Choose ChatGPT login. An existing login in a different Codex home is not
implicitly copied here. Then check the MCP entry and start a new session:

```bash
env CODEX_HOME="$PWD/.codex-local" codex mcp list
env CODEX_HOME="$PWD/.codex-local" codex
```

Use that launch command every time from the project root. A plain `codex`
command does not select this isolated home. Start a fresh session after changing
provider, key, or team/agent values. This walkthrough targets the CLI; an IDE or
desktop process must also be launched with the same absolute `CODEX_HOME` to
use this configuration.

## Step 6 — Verify model routing, memory, and MCP separately

1. Send a normal message and confirm the model responds through MemoryProxy.
2. Check Chat Memory in the Panel under the configured team and agent after the
   response finishes. A model response alone does not prove capture succeeded.
3. Run `/mcp` in the client and check that `memory_knowledge` connects and exposes
   12 tools: eight CodeGraph tools and four Wiki tools.
4. Register and index a repository or Wiki through the Panel/API. Then ask:
   “Use code_status for CodeGraph `<CODE_GRAPH_ID>`, then use code_search to find
   the authentication code.” For Wiki, supply its wiki ID and ask for wiki_search.

MCP provides read tools for CodeGraph/Wiki. It does not create/index assets or
provide the proxy's `mem:*` commands. You can use MCP independently of model
routing through MemoryProxy.

From the **self_agent_memory repository root**, inspect service logs if needed:

```bash
docker compose -f docker/docker-compose.yml logs --tail=100 memory-proxy knowledgebase
```

| Symptom | Check |
| --- | --- |
| Proxy connection refused | Start `memory-proxy`; verify port `8096`. |
| Memory authentication fails | Check the literal `x-tdai-user-key` value and the server's gateway key. |
| Model authentication fails | Check the model login/credential separately from the Memory user key. |
| No captured conversation | Check capture flags, user access, and successful team/agent session registration. Start a new session. |
| MCP returns 404 | Rebuild `knowledgebase` and confirm `KNOWLEDGE_MCP_ENABLED=true`. |
| MCP returns 401 | Match the MCP Authorization header to the server's Knowledge service key. |
| MCP returns 403 | If the client sends Origin, add that exact origin to `KNOWLEDGE_MCP_ALLOWED_ORIGINS`. |
| MCP connects but cannot find an asset | Check the asset ID, index status, and `x-tdai-service-id`. |

Opening `/mcp` in a browser sends GET; 405 is expected after access checks.
Use the client's MCP connection to test initialization and tool calls.
See [Knowledge MCP](../../MemoryKnowledge/MCP.md) for transport details.

## Adapter reference

- Agent source: `codex`; handler: `MemoryProxy/src/codexHandler.ts`.
- Protocol: OpenAI Responses; main route: `/codex/:spaceId/v1/responses`
  (also accepted without `/v1`).
- Session identity: `session-id`, then `body.client_metadata.session_id`.
- Interactive selection uses `request_user_input`; Default mode can block it.
  Valid team/agent headers avoid the form.
- Memory is injected into `body.instructions`. Auxiliary compaction and trace
  requests bypass the main injection/archiving flow.

For optional historical imports, see [asset import](./asset-import.md). Point
its scanner at this project's `.codex-local` home to import these sessions.
