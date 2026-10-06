# OpenCode

> agentSource: `opencode` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (shared with CB / dsh)

---

## 1. Client configuration

OpenCode is an open source AI coding CLI [from SST](https://github.com/sst/opencode). Configure
a custom provider in `~/.config/opencode/opencode.json` to connect to the proxy:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy-memory": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Memory (OpenCode)",
      "options": {
        "baseURL": "http://127.0.0.1:8096/opencode/default/v1",
        "apiKey": "<business user's sk-mem-... user_key>"
      },
      "models": {
        "claude-opus-4.7-1m": {
          "name": "claude-opus-4.7-1m"
        }
      }
    }
  }
}
```

Field descriptions:
- `baseURL` — Proxy address + `/opencode/<spaceId>/v1`; `default` is the memory instance ID (spaceId)
- `apiKey` — Business user's `user_key` (copy from MemoryPanel → OpenCode card)
- `models.<id>.name` — Model ID supported by the proxy upstream (such as `claude-opus-4.7-1m`)
- OpenCode uses the `@ai-sdk/openai-compatible` provider and **OpenAI Chat Completions** protocol

After starting OpenCode, select a model under `proxy-memory` in the `/model` selector.

Request paths:
- Main path: `POST /opencode/:spaceId/v1/chat/completions`
- Variant without v1: `POST /opencode/:spaceId/chat/completions` (when `baseURL` omits `/v1`)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

The OpenCode client **does not send** a session ID header; the proxy automatically generates
a stable sessionId for each request (based on request context), effectively giving each conversation its own session.

If a wrapper / proxy layer adds `x-conversation-id`, the proxy uses it preferentially.

---

## 3. Session Init (session initialization / form)

### 3.1 Mechanism

OpenCode reuses CB's **`ask_followup_question`** function_call mechanism to present an interactive form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_oc_session_init_` (the handler uses a dedicated opencode prefix, distinct from CB's `call_session_init_` / dsh's `call_dsh_session_init_`)
- Protocol: OpenAI SSE tool_calls chunks

### 3.2 State machine

Reuses the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

No count limit; all options are displayed at once.

### 3.4 Skipping Session Init

- Select "No" at `asset_confirm` → pass requests through
- Enter "skip" at any step → skip

---

## 4. Marker routes (⚠️ important)

OpenCode supports adding a **marker** URL segment to trigger cost-guard routing or analyse request classification,
with the same usage as CB / Codex:

| Marker | Path | Purpose |
|--------|------|------|
| (none) | `/opencode/<spaceId>/v1/chat/completions` | Use the standard pipeline by default |
| **cost-guard** | `/opencode/<spaceId>/cost-guard/v1/chat/completions` | Force the cost-guard tier |
| **analyse** | `/opencode/<spaceId>/analyse/v1/chat/completions` | Classify the request as analyse |

Variants without v1 (when `baseURL` omits `/v1`):
- `/opencode/<spaceId>/cost-guard/chat/completions`
- `/opencode/<spaceId>/analyse/chat/completions`

### 4.1 Marker gate

Both marker routes are controlled by the `assetReflection.markerOptIn` configuration gate:
- `markerOptIn: true` → routes match and take effect
- `markerOptIn: false` → return `404 {"error":"cost_guard_marker_disabled"}` / similar

See `MemoryProxy/z_config/config.yaml` → `assetReflection.markerOptIn`.

### 4.2 Client usage

Switch directly using `baseURL` in opencode.json:

```jsonc
// Default tier
"baseURL": "http://127.0.0.1:8096/opencode/default/v1"

// Force cost-guard
"baseURL": "http://127.0.0.1:8096/opencode/default/cost-guard/v1"

// Analyse classification (for backend pipeline identification)
"baseURL": "http://127.0.0.1:8096/opencode/default/analyse/v1"
```

---

## 5. Request classification

OpenCode request classification is simple:

| Type | Description |
|------|------|
| **main** | All requests default to main |
| **analyse** | Classified as analyse when the URL contains `/analyse/` (for the report layer) |

OpenCode has **no** auxiliary request types such as fork / sidequery / compact.

---

## 6. User text extraction

OpenCode's `message.content` is a **plain string** (rather than a content block array, and without
XML wrappers):

- No `<user_query>` wrapper (unlike CB)
- No content block array (unlike CC)
- Take the content string from the last user message directly

Image input passes through as an `image_url` content part (the client encodes it as base64, and the proxy
forwards it directly upstream), without special proxy handling.

---

## 7. Injection profile

OpenCode shares CB's handler path (both use OpenAI Chat Completions) and injection behavior:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (append inside the system message string).

---

## 8. Special behavior

- **Shared handler**: OpenCode reuses CB's `handleChatCompletions` (same path as dsh)
- **agentSource identification**: routing segment `/opencode/` → `agentSource=opencode`
- **No dedicated header fingerprint**: OpenCode CLI sends no custom headers; the proxy identifies it by URL segment + user-agent
- **Marker routes**: `/cost-guard/` and `/analyse/` URL markers; see §4

---

## 9. Archiving triggers

- Shares CB / dsh's archiving mechanism
- Conversations exceeding thresholds automatically trigger `skill/conversation/add`
- Supports `skill/conversation/force-archive`
- Archived data is written to L0

---

## 10. Environment variables

No OpenCode specific variables. `resolveForwardTarget` determines upstream routing dynamically
(usually to tokenhub or a direct provider).

---

## 11. FAQ

**Q: How is OpenCode distinguished when sharing CB / dsh's handler?**  
A: The routing layer uses the `/:agent/` segment. Within the handler, `agentSource=opencode` triggers
OpenCode specific behavior (marker routes, automatic session ID generation, etc.).

**Q: Must `baseURL` in opencode.json include `/v1`?**  
A: Including it is recommended (main path); the proxy also accepts the variant without `/v1`. Both are supported.

**Q: What should I do if a marker route returns 404?**  
A: Check that `assetReflection.markerOptIn` in `MemoryProxy/z_config/config.yaml` is
`true`. After changing it, run `./scripts/proxy.sh restart` to reload.

**Q: Does OpenCode CLI support `@image:path` syntax?**  
A: This is a client capability independent of the proxy. The client reads the file, encodes it as base64, and puts it in an `image_url`
content part; the proxy then forwards it transparently upstream.

**Q: Can local historical sessions / skills be imported into Memory Hub?**  
A: OpenCode does not save local skill / session files (unlike CB / dsh), so there is currently no
`asset-import.md`. To import historical conversations, use the panel manually or the `mem:sync` command.

---

## 12. Differences from CB / dsh

| Dimension | CodeBuddy | dsh | **OpenCode** |
|---|---|---|---|
| Protocol | OpenAI Chat Completions | OpenAI Chat Completions | **OpenAI Chat Completions** |
| Configuration file | `~/.codebuddy/models.json` | `~/.dsh/settings.yaml` + `.credentials.yaml` | **`~/.config/opencode/opencode.json`** |
| URL prefix | `/codebuddy/<spaceId>` | `/dsh/<spaceId>` (without `/v1`) | **`/opencode/<spaceId>`** |
| Provider library | Built in | Built in | **`@ai-sdk/openai-compatible`** |
| Key delivery | JSON `apiKey` | `.credentials.yaml` environment variable | **JSON `provider.*.options.apiKey`** |
| Form tool | `ask_followup_question` | `ask_user_question` | **`ask_followup_question`** (same as CB) |
| Session ID | Client sends `x-conversation-id` | Client sends `x-deepseek-harness-session-id` | **Generated by proxy** |
| Marker routes | None | None | **`/cost-guard/` `/analyse/`** |
| Local asset import | Yes (`asset-import.md`) | Yes (`asset-import.md`) | **No** (client does not save files) |

---

## 13. Current status

- ✅ Implementation complete (handler reuses CB path)
- ✅ Marker route tests (cost-guard / analyse) passed 6/6
- ✅ End to end curl validation passed (three real upstream streaming responses)
- ✅ Panel displays the OpenCode card
