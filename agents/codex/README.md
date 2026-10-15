# Codex

> agentSource: `codex` | Protocol: OpenAI Responses API | Handler: `codexHandler.ts` (dedicated)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

### 1.1 ChatGPT subscription + Memory Hub

Use this setup when Codex already works with **Sign in with ChatGPT**. Each
person keeps their own ChatGPT login and uses their own Memory Hub `user_key`.
The proxy does not need an LLM API key for this flow.

Edit the user-level **`~/.codex/config.toml`**, merging into existing tables
rather than duplicating them. Keep your current `model` and reasoning settings.
Place `model_provider` at the top level, before any `[table]`:

```toml
model_provider = "memory_proxy"

[model_providers.memory_proxy]
name = "Local MemoryProxy"
base_url = "http://127.0.0.1:8096/codex/default/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
stream_idle_timeout_ms = 120000

[model_providers.memory_proxy.env_http_headers]
x-tdai-user-key = "MEMORY_USER_KEY"

[model_providers.memory_proxy.http_headers]
x-team-id = "<team_id from Memory Hub>"
x-agent-id = "<agent_id belonging to that team>"
# Optional: omit this line when no task is needed.
# x-task-id = "<task_id belonging to that team>"
```

`MEMORY_USER_KEY` above is the **environment variable name**, not the key itself.
For Bash, enter your Memory Hub user key without putting it in shell history,
then launch Codex from that same terminal:

```bash
read -r -s -p "Memory Hub user key: " MEMORY_USER_KEY
printf '\n'
export MEMORY_USER_KEY
codex
```

For an IDE or desktop app, the process launching Codex must inherit this variable;
exporting it in an unrelated terminal will not update an already running app.
**Start a new agent session after changing the configuration or environment.**
Existing sessions may retain their previous provider and identity settings.

The resulting request carries two separate credentials:

| Header | Purpose |
| --- | --- |
| `Authorization` | Codex supplies its ChatGPT login token for the model upstream. |
| `x-tdai-user-key` | Your Memory Hub identity, used for verification and memory operations; stripped before forwarding to the model. |

Do not set `experimental_bearer_token` to a Memory key for this subscription
setup. The proxy upstream should be `https://chatgpt.com/backend-api/codex` with
`upstream.apiKey: ""`, preserving the caller's model authentication.

`default` in the URL is the **memory instance ID**, not the team ID.
`127.0.0.1` works when the proxy runs on the same machine as Codex. For a shared
proxy, use the reachable gateway URL supplied by your administrator, including
`/codex/default/v1`. Everyone can share that URL while using individual user keys.

Codex configuration references: [ChatGPT login through a gateway](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway)
and [provider settings](https://learn.chatgpt.com/docs/config-file/config-reference).

### 1.2 Select a team, agent, and optional task

Use actual **IDs**, not display names. Obtain them from Memory Hub or your
administrator. `x-agent-id` identifies a Memory Hub agent record, not a Codex
process or a model name. Each user must have access to the selected team.

The proxy validates these headers against the teams, agents, and tasks visible
to the authenticated Memory Hub user:

| Supplied headers | Session initialization behavior |
| --- | --- |
| Valid `x-team-id` + `x-agent-id` | Registers the session directly, without the selection form; task is optional. |
| Only `x-team-id` | Preselects the team; remaining selections use the form. |
| No team header | Uses the interactive selection flow. |
| Unknown/inaccessible team or agent | Falls back to the form by default (`onMismatch: form`). |
| Unknown task with valid team + agent | Drops the task and registers without a task association. |

Headers take effect when initializing a session with `sessionInit.enabled: true`
and `sessionInit.headerAutoSelect.enabled: true` (header auto-selection defaults
to enabled). Start a new session when switching teams or agents.

**If the form is needed, switch Codex to Plan mode before the first message.**
Default mode blocks `request_user_input`; the proxy may then skip initialization
and cannot capture L0 without a complete session identity. With valid team and
agent headers, direct registration avoids this form requirement.

### 1.3 Administrator: enable chat memory capture

Routing a model call through the proxy does **not** by itself enable chat memory.
The initial [Docker configuration](../../docker/memory-proxy.yaml) disables
capture. In that file, merge these settings into the existing sections:

```yaml
auth:
  enabled: true
sessionInit:
  enabled: true
  headerAutoSelect:
    enabled: true
    onMismatch: form
extraction:
  enabled: true
  extractors: [tdai-memory]
tdai:
  enabled: true
  memory:
    enabled: true
    writeL0: true
```

Keep the existing endpoints and service-token settings. The internal
`MEMORY_CORE_GATEWAY_API_KEY` in `docker/.env` is a server credential; it is
separate from each person's `MEMORY_USER_KEY`. See the [Docker guide](../../docker/GUIDE.md#separate-memory-identity-from-model-authentication)
for those settings. Injection/recall is configured separately from L0 capture.

After editing the YAML, restart the proxy from the repository root:

```bash
docker compose -f docker/docker-compose.yml restart memory-proxy
```

If `docker/.env` changed, recreate the container to load the new environment:

```bash
docker compose -f docker/docker-compose.yml up -d --no-deps --force-recreate memory-proxy
```

Open a new Codex session, send a message, wait for the answer, then check Chat
Memory in Memory Hub under the selected team and agent. If no record appears,
check the capture flags, user-key verification, and session registration in:

```bash
docker compose -f docker/docker-compose.yml logs --tail=100 memory-proxy
```

A successful model response or `/health` check alone does not confirm L0 capture.

### 1.4 Legacy proxy-managed model authentication

Older deployments may use `experimental_bearer_token = "<Memory Hub user_key>"`
when the proxy separately supplies the model's upstream credential. When
`x-tdai-user-key` is absent, MemoryProxy falls back to that original credential
for Memory authentication. An explicitly empty Memory header does not fall back.
Use section 1.1 for ChatGPT subscription passthrough.

Request paths:
- `POST /codex/:spaceId/v1/responses`
- `POST /codex/:spaceId/responses` (without the v1 prefix; also accepted)

Auxiliary paths:
- `/codex/:spaceId/responses/compact` — Compaction requests
- `/codex/:spaceId/memories/trace_summarize` — Trace summaries
- `/codex/:spaceId/realtime/calls` — Realtime calls

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

Codex CLI automatically generates session_id and writes it to both header and body. No manual configuration is needed.

---

## 3. Session Init (session initialization / form)

### 3.1 Mechanism

Codex uses a **`request_user_input`** function_call to present an interactive form:

- Tool name: `request_user_input`
- ID prefix: `fc_codex_session_init_` (⚠️ the `fc_` prefix is mandatory and strictly validated by the OpenAI Responses specification)
- Call ID prefix: `call_codex_session_init_`
- Protocol: OpenAI Responses API SSE (`response.created` / `response.output_item.*` / `response.completed` events)

### 3.2 State machine

Reuses the CB state machine with `agentSource="codex"`, `protocol="responses"` markers:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

Codex uses dedicated `computeCodexPagination` logic, with rules similar to CC (limited option count) but a separate implementation.

### 3.4 ⚠️ Default Mode Gate (key difference)

Codex has two operating modes:
- **Plan mode** — `request_user_input` is available → normal form flow
- **Default mode** — the client blocks `request_user_input` calls

**Default mode detection**: after the proxy sends a form, the client's `function_call_output.output` contains:

```
"request_user_input is unavailable in Default mode"
```

When the proxy detects this gate string → **permanently skip** session-init and pass all subsequent requests through.

### 3.5 Skipping Session Init

Three ways:
1. Default mode gate triggers automatically → permanent skip
2. User manually enters "skip"
3. Select "No" at asset_confirm

---

## 4. Request classification

Codex uses **three signals** to identify auxiliary requests:

| Signal | Check |
|------|----------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

Any matching signal → classify as auxiliary → skip injection/archiving.

---

## 5. User text extraction

Extract from the `body.input[]` array:
1. Find the last item with `type: "message"` and `role: "user"`
2. Extract text from all `input_text` blocks in its `content[]`
3. Concatenate them into the final user text

⚠️ Codex's body structure differs completely from Chat Completions (`input[]` rather than `messages[]`).

---

## 6. Injection profile

Uses the Codex specific injection builder `buildCodexInjectionBlock`:

```
Injection into the instructions field (rather than messages/input)
```

Codex's injection point is `body.instructions` (the Responses API equivalent of a system prompt).

---

## 7. Special behavior

- **Dedicated handler**: `codexHandler.ts`, not shared with CB/CC
- **Mandatory fc_ prefix**: OpenAI Responses API function_call IDs must start with `fc_`; otherwise client replay returns 400
- **Marker routes**: `/codex/:spaceId/cost-guard/responses` and `/codex/:spaceId/analyse/responses` support cost-guard/analyse routing
- **Archiving hook**: Codex's `skill/conversation/add` + TDAI L0 writes were added on 2026-08-11 (data was previously lost silently)

---

## 8. Archiving triggers

- Conversations exceeding thresholds automatically trigger `skill/conversation/add` (through the responses branch of `normalize-conversation`)
- Supports `skill/conversation/force-archive`
- Codex archiving requires `normalizeCodexConversation` to convert conversations into the unified format

---

## 9. Environment variables

```env
PROXY_PORT=8096
# Docker: model upstream for ChatGPT subscription passthrough
PROXY_UPSTREAM_URL=https://chatgpt.com/backend-api/codex
# Client process: each person's Memory Hub key
MEMORY_USER_KEY=<your own Memory Hub user_key>
```

The model must be available to the caller's upstream account. Other deployments
can use different upstreams; their authentication and model availability depend
on that upstream's configuration.

---

## 10. FAQ

**Q: Does Codex Default mode have no memory injection at all?**  
A: Default mode blocks the interactive selection form. Supply valid team and agent headers to register directly, or initialize through the form in Plan mode. Memory capture and injection also depend on their respective proxy settings.

**Q: What is the fc_ prefix issue?**  
A: OpenAI Responses API validates function_call IDs with a regular expression requiring `fc_`. Proxy forms use `fc_codex_session_init_` for id and retain `call_` for call_id. Before the fix, the fifth replay request from the Codex client always returned 400.

**Q: What is Codex's /compact request?**  
A: Like CC conversation compaction, it is an auxiliary request triggered automatically by the client and does not need injection/archiving.

**Q: What code does Codex reuse from CB?**  
A: Codex has a dedicated `codexHandler.ts`, but the underlying session-init state machine reuses CB's implementation with different agentSource + protocol arguments.

---

## 11. Differences from Claude Code / CodeBuddy

| Dimension | Claude Code | CodeBuddy | Codex |
|------|-------------|-----------|-------|
| Protocol | Anthropic Messages | OpenAI Chat Completions | **OpenAI Responses** |
| Configuration file | Environment variables | `~/.codebuddy/models.json` | `~/.codex/config.toml` |
| URL prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` |
| Key delivery | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | `x-tdai-user-key` via `env_http_headers` (subscription); legacy bearer token |
| Session init | Automatic form | Automatic form | **Team/agent headers, or Plan mode for the selection form** |
