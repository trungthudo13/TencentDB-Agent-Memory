# CodeBuddy (CB)

> agentSource: `codebuddy` | Protocol: OpenAI Chat Completions / Anthropic Messages | Handler: `handler.ts` (shared)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

CB configures custom models through the **configuration file** `~/.codebuddy/models.json`:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<business user's sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

Field descriptions:
- `id` — Model ID supported by the proxy upstream (such as `claude-sonnet-4-20250514`)
- `name` — Customizable display name in the CodeBuddy conversation dialog
- `vendor` — UI display only (such as `claude`, `openai`); does not affect requests
- `apiKey` — Business user's `user_key` (from the panel, same as CC's `ANTHROPIC_AUTH_TOKEN`)
- `url` — Proxy address + `/codebuddy/<spaceId>`; `default` is the memory instance ID

After configuration, select this model in the CB conversation dialog.

### ⚠️ Version limitations

> CodeBuddy **4.10.2–4.10.4** does not send sessionId and cannot complete Session Init.  
> **Use ≥ 4.10.5 or ≤ 4.10.1**.

Request paths:
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

The CB IDE plugin automatically generates and sends `x-conversation-id`.

---

## 3. Session Init (session initialization / form)

### 3.1 Mechanism

CB uses an **`ask_followup_question`** function_call to present an interactive form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- Protocol: OpenAI SSE tool_calls chunks or Anthropic SSE

### 3.2 State machine

```
asset_confirm → team_select → agent_task_select → initialized
```

Four step flow:
1. **asset_confirm** — Confirm whether to inject assets ("Use memory/skills?")
2. **team_select** — Select a team
3. **agent_task_select** — Combined agent + task selection
4. **initialized** — Inject assets and start normal conversation

### 3.3 Pagination

CB's `ask_followup_question` option list has **no count limit**, so pagination is unnecessary.  
All options are displayed at once.

### 3.4 Plan Mode / Default Mode

CB has **no** Default Mode gate. Its `ask_followup_question` tool is always available, so forms can always be sent.

### 3.5 Skipping Session Init

- Select "No" at `asset_confirm` → skip all remaining steps and pass requests through
- Enter "skip" at any step → skip when SKIP_RE matches

---

## 4. Request classification

CB request classification is simple:

| Type | Description |
|------|------|
| **main** | All requests default to main |

CB has **no** auxiliary request types such as fork / sidequery / compact. Every request runs through the full pipeline.

---

## 5. User text extraction

CB's `message.content` is always a **plain string** (rather than a content block array).

Extraction logic:
1. Look for a `<user_query>...</user_query>` XML wrapper in the string
2. If found → extract the inner text
3. If absent → use the entire string as user text
4. Strip CB's pseudo XML tags (`<agent_context>`, `<code_context>`, etc.)

---

## 6. Injection profile

System prompt injection with an **XML structure**:

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection points:
- OpenAI: `messages[0].content` (append inside the system message string)
- Anthropic: `system` field

---

## 7. Special behavior

- **Distinct headers**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`
- **Assistant placeholder**: CB assistant messages may use `"-"` as a placeholder (empty response marker)
- **Shared handler**: dsh also reuses this handler (`handleChatCompletions`)
- **Dual protocol support**: the same CB version may use OpenAI or Anthropic; the handler adapts automatically

---

## 8. Archiving triggers

- Conversations exceeding thresholds automatically trigger `skill/conversation/add`
- Supports `skill/conversation/force-archive`
- Archived data is written to L0

---

## 9. Environment variables

No CB specific variables. Use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI upstream
# Or FORWARD_URL=https://api.anthropic.com  # CB Anthropic upstream
```

`resolveForwardTarget` determines the actual upstream dynamically (tokenhub / direct provider).

---

## 10. FAQ

**Q: What are the main differences between CB and CC?**  
A: Different protocols (OpenAI vs Anthropic), different content structures (string vs content block array), no auxiliary request classification, and no option pagination.

**Q: Who adds CB's `<user_query>` wrapper?**  
A: The CB IDE plugin wraps the original user text before sending it; the proxy strips the wrapper during extraction.

**Q: How does CB using Anthropic differ from CC?**  
A: The form tool names differ (`ask_followup_question` vs `AskUserQuestion`), content still uses string format, injection uses XML rather than Markdown, and the agentSource markers differ.
