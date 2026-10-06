# WorkBuddy (WB)

> agentSource: `workbuddy` | Protocol: OpenAI Responses API (Desktop) + Chat Completions (Web) | Handler: `workbuddyHandler.ts` (dedicated)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

WB configures custom models through the **configuration file** `~/.workbuddy/models.json`:

```json
[
  {
    "id": "claude-opus-4.7-1m",
    "name": "claude-opus-4.7-1m",
    "vendor": "Custom",
    "url": "http://127.0.0.1:8096/workbuddy/default",
    "apiKey": "<business user's sk-mem-... user_key>",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "useCustomProtocol": false
  }
]
```

Field descriptions:
- `id` — Model ID supported by the proxy upstream (such as `claude-opus-4.7-1m`)
- `name` — Display name in WorkBuddy's "Custom Models" list
- `vendor` — UI display only (`Custom`, `claude`, etc.); does not affect requests
- `url` — Proxy address + `/workbuddy/<spaceId>`; `default` is the memory instance ID
- `apiKey` — Business user's `user_key` (from the panel)

After configuration, select the model under "Custom Models" in WorkBuddy's model selector.  
Session init follows CC/CB (Team → Agent → Task selection); the client manages session IDs automatically.

Request paths:
- Desktop: `POST /workbuddy/:spaceId/v1/responses` or `/workbuddy/:spaceId/responses`
- Web: `POST /workbuddy/:spaceId/v1/chat/completions`

Auxiliary paths (same as Codex):
- `/workbuddy/:spaceId/responses/compact`
- `/workbuddy/:spaceId/memories/trace_summarize`
- `/workbuddy/:spaceId/realtime/calls`

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

The WB client automatically generates and sends session IDs. No manual configuration is needed.

---

## 3. Session Init (session initialization)

WB session init follows CC/CB: an interactive form selects Team → Agent → Task.

### 3.1 Interactive form

Use the interactive form when the client's `body.tools` contains `AskUserQuestion`:

- Tool name: `AskUserQuestion` (same as CC)
- Call ID prefix: `call_wb_session_init_`
- Pagination: CC style (maximum four options)
- State machine: reuses the CB state machine

### 3.4 Default Mode Gate

WB Desktop also has a Default mode gate (same as Codex):  
Client returns `"request_user_input is unavailable in Default mode"` → permanently skip the form.

---

## 4. Request classification

WB uses the same **three signals** as Codex to identify auxiliary requests:

| Signal | Check |
|------|----------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

---

## 5. User text extraction

With two protocols, WB uses **two modes** for extracting user text:

| Mode | Protocol | Extraction |
|------|------|----------|
| Desktop | Responses API | Extract from `body.input[]` (same algorithm as Codex) |
| Web | Chat Completions | Extract from the `messages[].content` string + strip `<user_query>` (same algorithm as CB) |

---

## 6. Injection profile

WB has a dedicated injection profile in `injection/agents/workbuddy/`:

- Dedicated parser / serializer
- System prompt uses **nunjucks templates**, containing placeholders:
  ```
  {{ WorkbuddyMemory_1 }}
  {{ WorkbuddySkills }}
  {{ WorkbuddyKnowledge }}
  ```
- The injection point depends on the protocol:
  - Responses API: `body.instructions`
  - Chat Completions: `messages[0].content`

---

## 7. Special behavior

- **Dedicated handler**: `workbuddyHandler.ts`, with no cross references to Codex/CB/CC
- **Two protocols**: Desktop uses Responses API and Web uses Chat Completions, handled within the same handler
- **Desktop SDK**: the client uses `@openai/agents 0.5.2`
- **Distinct headers**: `X-Agent-Intent`, `X-Agent-Purpose`, `X-User-Id`, `X-Codebuddy-Run-Timeout`
- **nginx routing**: internal nginx must forward `/workbuddy/:iid/*` to the proxy (added on 2026-08-13)

---

## 8. Archiving triggers

- Shares Codex's archiving mechanism
- Conversations exceeding thresholds automatically trigger `skill/conversation/add`
- Supports `skill/conversation/force-archive`

---

## 9. Environment variables

No WB specific variables. `resolveForwardTarget` determines upstream routing dynamically.

---

## 10. FAQ

**Q: What is the easiest way to connect WB?**  
A: Include `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-task-id` in client requests. The proxy registers the session and injects assets directly, without interaction delays.

**Q: What happens if WB sends neither headers nor a tool?**  
A: Requests pass through silently, without errors or blocking, but also without memory/skill injection. This is intentional: WB does not require memory integration.

**Q: Why do WB Desktop and Web use different protocols?**  
A: Desktop uses the `@openai/agents` SDK with Responses API; Web uses standard Chat Completions. The proxy supports both and distinguishes them by path.

**Q: How is WB code related to Codex?**  
A: They are entirely independent. Although both support Responses API, WB has a dedicated handler, injection profile, and template system, with no cross imports.
