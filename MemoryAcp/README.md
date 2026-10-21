# MemoryAcp

Standalone HTTP → Agent Client Protocol → Codex bridge for text-only memory
extraction experiments. Uses the pinned `@agentclientprotocol/codex-acp` adapter
and **ChatGPT login**, not an OpenAI Platform API key.

The main `docker/docker-compose.yml` connects MemoryCore L1 extraction/dedup
through a dedicated text-only runner. L2/L3, skills and Knowledge keep their
existing LLM provider. Do not replace the global `MEMORY_LLM_BASE_URL`.
Set `MEMORY_L1_ACP_BASE_URL=` to disable the L1 override.

The L1 runner forwards prompts and cancellation but does not forward `maxTokens`:
ACP controls the output budget. L1's existing parser validates the resulting text.
ACP calls do not report estimated token credits as actual usage.

## Local use

Requires Node.js 22+, npm, and a supported Codex platform.

```bash
cd MemoryAcp
npm ci
mkdir -p .codex
CODEX_HOME="$PWD/.codex" ./node_modules/.bin/codex login --device-auth
npm start
```

Complete the interactive login with your ChatGPT account. `.codex` is a dedicated,
ignored credential directory; the bridge does not reuse your normal Codex home.
Do not copy credentials into a model API-key field.

```bash
curl http://127.0.0.1:8097/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","messages":[{"role":"system","content":"Extract useful memories. Return only a JSON array."},{"role":"user","content":"I prefer Vietnamese responses."}]}'
```

`model: "codex"` explicitly selects the adapter's default model. A specific model
must match an ID advertised by the adapter, including any reasoning-effort suffix.
Unknown IDs fail rather than falling back.

## Docker

Create `.env` from `.env.example` and set `MEMORY_ACP_TOKEN` to a random local
bridge secret. This is **not** an OpenAI key.

```bash
docker compose build
docker compose run --rm memory-acp \
  env CODEX_HOME=/data/codex /app/node_modules/.bin/codex login --device-auth
docker compose up -d
```

Supply `Authorization: Bearer <your bridge token>` on HTTP generation requests.
The named volume `codex-auth` persists login and Codex session data. The service
runs as the unprivileged `node` user and exposes only localhost port 8097.
Other containers need a shared Docker network to reach `http://memory-acp:8097/v1`.

## Contract and limitations

- `GET /health` reports process liveness and queue depth. It does not prove model
  access or login validity; `authentication: "not_checked"` is intentional.
- `POST /v1/chat/completions` accepts only `model`, `messages`, and optional
  `stream: false`. Messages must contain string `content` and a
  `system`, `user`, or `assistant` role.
- ACP has no equivalent OpenAI system-role channel. The conversation is encoded
  in a single prompt with instructions describing the roles. This is a lossy
  compatibility layer, not a general-purpose OpenAI API replacement.
- No tools, streaming, images, sampling controls, token-limit controls, or
  `response_format` yet. Unsupported fields return 400. JSON can be requested
  in the prompt, but schema enforcement belongs to the caller.
- Answers contain only `agent_message_chunk` text from the current session;
  reasoning and other session events are excluded. Token usage is omitted
  rather than fabricated.
- One job runs at a time; queued and active jobs share the configured deadline.
  Queue overflow returns 429. Timeout/disconnect cancels work and terminates
  the adapter process group on Linux/macOS.
- Each job starts a new adapter process and session in a temporary workspace.
  This favors isolation over startup latency. Workspace files are removed after
  completion, but Codex may persist session history in its credential volume.
- Client file/terminal capabilities and MCP servers are not supplied; permission
  requests are denied. Codex runs read-only with shell/web search disabled.
  Run in the dedicated container for filesystem isolation; local read-only
  execution is not a guarantee that every host file is inaccessible.
- Authentication is checked before each session. Non-ChatGPT authentication
  fails with 503 `auth_required`. No automatic API billing fallback.
- Subscription limits and model availability still apply. Re-login may be needed.
  Generation is not automatically retried, avoiding duplicate work.
- Prompts, responses, credentials and raw adapter errors are not written to
  service logs. The service does not provide multi-user account isolation;
  all jobs use the dedicated account.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MEMORY_ACP_HOST` | `127.0.0.1` | Bind address; Docker uses `0.0.0.0` |
| `MEMORY_ACP_PORT` | `8097` | HTTP port |
| `MEMORY_ACP_TOKEN` | empty | Bearer secret; required outside loopback |
| `MEMORY_ACP_TIMEOUT_MS` | `120000` | Total queue + execution deadline |
| `MEMORY_ACP_MAX_QUEUE` | `8` | Maximum waiting jobs |
| `MEMORY_ACP_CODEX_HOME` | `MemoryAcp/.codex` | Dedicated Codex state directory; use an absolute path |

`npm start` does not automatically load `.env`. Export variables for local use,
or run `node --env-file=.env src/index.js`. Docker Compose loads `.env`.

## Verification

```bash
npm test
```

Tests use a local fake ACP process; no account or paid model call is required.
The integration test imports the neighboring MemoryCore runner using Node's
TypeScript stripping and exercises MemoryCore → HTTP → ACP.
They cover HTTP auth/validation, the response envelope, model selection,
subscription checks, session filtering, process failure, cancellation and queue
limits. A successful live generation requires completing the login above.

Protocol references:
[codex-acp](https://github.com/agentclientprotocol/codex-acp),
[ACP prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn).
