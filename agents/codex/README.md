# Codex

> agentSource: `codex` | Protocol: OpenAI Responses API | Handler: `codexHandler.ts` (dedicated)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

Codex is configured through the **configuration file** `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
model_provider = "team-proxy"
model = "claude-opus-4.7"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = "http://127.0.0.1:8096/codex/default"
experimental_bearer_token = "<business user's sk-mem-... user_key>"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
```

Field descriptions:
- `wire_api = "responses"` — **Required**; Codex uses the OpenAI Responses API protocol
- `base_url` — Proxy address + `/codex/<spaceId>`; `default` is the memory instance ID
- `experimental_bearer_token` — Business user's `user_key` (from the panel)
- `disable_response_storage = true` — Disable local caching to ensure each turn receives proxy injection
- `stream_idle_timeout_ms = 120000` — Avoid timeouts while session-init waits for user input

> ⚠️ **Switch to Plan mode before the first conversation** (`Shift+Tab`). Codex's default Agent mode automatically executes tool calls and skips user selections, preventing session-init from completing. Switch back to Agent mode after selecting Team→Agent→Task.

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
- **Suggest mode** — `request_user_input` is available → normal form flow
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
# Codex upstream (usually tokenhub or copilot.tencent.com)
# Dynamically routed by resolveForwardTarget
```

The local Codex upstream uses `https://copilot.tencent.com` (without /v1 or /v2).  
Available models: `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` / `deepseek-r1`; `claude-*` is strictly rejected.

---

## 10. FAQ

**Q: Does Codex Default mode have no memory injection at all?**  
A: Correct. Once the Default mode gate triggers, the proxy passes requests through without injection. This follows the Codex client's design: Default mode aims for minimal latency.

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
| Key delivery | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` |
| Session init | Automatic form | Automatic form | **Manually switch to Plan mode for the first conversation** |
