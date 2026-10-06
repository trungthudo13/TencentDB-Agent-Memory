# DeepSeek Harness (dsh)

> agentSource: `dsh` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (shared with CB)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

dsh is configured through the **configuration files** `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`:

**`~/.dsh/settings.yaml`**：
```yaml
llm-deepseek:
  # dsh reads the proxy user_key from this environment variable
  apiKeyEnv: PROXY_USER_KEY

  # ⚠️ Do not append /v1: dsh hardcodes ${baseURL}/chat/completions
  baseURL: http://127.0.0.1:8096/dsh/default

  # Thinking mode
  reasoningEffort: high
```

**`~/.dsh/.credentials.yaml`**：
```yaml
PROXY_USER_KEY: <business user's sk-mem-... user_key>
```

**Strict permission requirements** (checked at startup; dsh refuses to start if incorrect):
```bash
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

Field descriptions:
- `baseURL` — Proxy address + `/dsh/<spaceId>`; **without `/v1`** (dsh hardcodes `${baseURL}/chat/completions`)
- `apiKeyEnv` — Environment variable name from which to read the key; the value itself is in `.credentials.yaml`
- `PROXY_USER_KEY` — Business user's `user_key` (from the panel)

Request paths (⚠️ dsh omits the `/v1` prefix):
- `POST /dsh/:spaceId/chat/completions` (main path)
- `POST /dsh/:spaceId/v1/chat/completions` (also accepted)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-deepseek-harness-session-id` |
| 2 | `x-session-id` |

The dsh client automatically generates a session ID and sends it in the header. No manual configuration is needed. The proxy reads only the header, with no body fallback.

---

## 3. Session Init (session initialization / form)

### 3.1 Mechanism

dsh uses an **`ask_user_question`** tool_call to present an interactive form:

- Tool name: `ask_user_question`
- Call ID prefix: `call_dsh_session_init_`
- Protocol: OpenAI Chat Completions SSE

### 3.2 State machine

Reuses the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

dsh's option list has **no count limit**, so pagination is unnecessary. All options are displayed at once.

### 3.4 Headless Bypass (⚠️ key difference)

dsh has a distinct **headless bypass** mechanism:

- Inspect the `body.tools` array
- If `body.tools` is nonempty **but does not contain** `ask_user_question` → the proxy treats the request as headless
- In headless mode → **skip session-init entirely** and pass requests through

This allows dsh to work in scenarios without interactive capabilities (such as direct API calls or batch mode).

### 3.5 reasoning_content requirements

The dsh client uses DeepSeek thinking mode and **strictly validates** that assistant messages contain `reasoning_content`.  
The proxy must insert a nonempty `reasoning_content` placeholder when generating form responses.

### 3.6 Skipping Session Init

Three ways:
1. Headless bypass (no `ask_user_question` in tools) → automatic skip
2. User enters "skip"
3. Select "No" at asset_confirm

### 3.7 First conversation — Select Team → Agent → Task

Start the Web UI:

```bash
cd /path/to/deepseek-harness
pnpm dsh web --port 3080
# Or: node apps/cli/lib/bin.js web --port 3080
```

Open <http://127.0.0.1:3080> in a browser and send a message (such as "hi"). The proxy returns a four step form with buttons:

1. "Link team assets?" — Select **Yes** to link and inject, or **No** to pass through
2. Team selector (automatically skipped if only one team exists)
3. Agent selector
4. Task selector (the first option is the virtual **"Do not link a task for this conversation"**)

After selection, the agent introduces itself. Subsequent turns automatically receive blocks such as `<session_context>` + `<available_skills>` + `<tdai_profile_memory>`.

Mem commands such as `mem:help` / `mem:sync` / `mem:create-skill` are also available after session init completes.

---

## 4. Request classification

dsh uses dedicated classification logic:

| Type | Identification | Handling |
|------|----------|------|
| **compact** | `x-deepseek-harness-compact: 1` header | Auxiliary request; skip injection |
| **title-gen** | Combined body characteristics: no tools + thinking.disabled + max_tokens≤128 + system starts with "Create a concise title..." | Auxiliary request; skip injection |
| **main** | All others | Full pipeline |

---

## 5. User text extraction

dsh message content is always a **plain string**, without wrapper tags:
- No `<user_query>` wrapper (unlike CB)
- No content block array (unlike CC)
- Take the content string from the last user message directly

---

## 6. Injection profile

dsh shares CB's handler path (both use OpenAI Chat Completions), with similar injection:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (append inside the system message string).

---

## 7. Special behavior

- **Shared handler**: dsh reuses CB's `handleChatCompletions` (no dedicated handler)
- **Client fingerprint headers**: 
  - `user-agent: deepseek-harness/*`
  - `x-deepseek-harness-user-id`
  - `x-deepseek-harness-session-id`
  - `x-deepseek-harness-compact`
- **Thinking mode**: assistant messages may contain `reasoning_content` (DeepSeek chain of thought)
- **No `<user_query>` wrapper**: shares CB's handler but uses different user text extraction logic (dsh does not strip tags)

---

## 8. Archiving triggers

- Shares CB's archiving mechanism
- Conversations exceeding thresholds automatically trigger `skill/conversation/add`
- Supports `skill/conversation/force-archive`

---

## 9. Environment variables

No dsh specific variables. Upstream routing is determined dynamically (usually to the DeepSeek API).

---

## 10. FAQ

**Q: How are dsh and CB distinguished when sharing a handler?**  
A: The routing layer uses the `/:agent/` segment. Within the handler, `agentSource` controls behavior differences (form tool name, session ID header, content extraction, etc.).

**Q: When does dsh headless bypass trigger?**  
A: When the client's `body.tools` is nonempty but lacks `ask_user_question`. A typical scenario is direct dsh API mode with custom tools but no user interaction tool.

**Q: What is dsh's `x-deepseek-harness-compact` header?**  
A: The dsh client sends it during conversation compaction. The proxy recognizes it, skips injection/archiving, and forwards the request upstream for compaction.

**Q: Why does dsh need a reasoning_content placeholder?**  
A: The DeepSeek thinking mode client strictly validates assistant message format: `reasoning_content` must exist. Proxy session-init form responses are also assistant messages and must include the field (its content may be an empty string or placeholder).

---

## 11. Differences from Claude Code / CodeBuddy / Codex

| Dimension | Claude Code | CodeBuddy | Codex | **dsh** |
|---|---|---|---|---|
| Protocol | Anthropic Messages | OpenAI Chat | OpenAI Responses | **OpenAI Chat** |
| Configuration file | Environment variables | `~/.codebuddy/models.json` | `~/.codex/config.toml` | `~/.dsh/settings.yaml` + `.credentials.yaml` |
| URL prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` | **`/dsh/<spaceId>`** (without `/v1`) |
| Key delivery | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` | `.credentials.yaml` environment variable |
| Session init | Automatic form | Automatic form | Switch to Plan mode initially | **Automatic form** |
| UI form tool | `AskUserQuestion` | `ask_followup_question` | fake `function_call` | **`ask_user_question`** (native dsh) |
| Wire specifics | cache_control markers | None | encrypted rs_id | **`reasoning_content` required on tool call turns** (handled automatically by the proxy) |

---

## 12. Current status

- ✅ Implementation complete
- ✅ Local validation passed
- ⚠️ Not yet widely used in production
