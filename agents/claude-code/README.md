# Claude Code (CC)

> agentSource: `claude-code` | Protocol: Anthropic Messages API | Handler: `anthropicHandler.ts`
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

### Method 1: Environment variables

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<business user's sk-mem-... user_key>"
claude --model <upstream-model-configured-in-PROXY_UPSTREAM_MODEL>
```

### Method 2: Configuration file `~/.claude/settings.json` (recommended, persistent)

Edit `~/.claude/settings.json` and add the following to the `env` field:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<business user's sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

After configuration, simply run `claude`. CC loads environment variables from the `env` field in `settings.json` at startup.

### Field descriptions

- `ANTHROPIC_BASE_URL`: redirects CC's API from anthropic.com to the proxy; `default` in the path is the memory instance ID (`x-tdai-service-id`), always named `default` for local deployments
- `ANTHROPIC_AUTH_TOKEN`: the **business user's** user_key (available on the panel's "API Key" page; using the admin key directly is not recommended)
- `ANTHROPIC_MODEL`: upstream model name (also selectable with the `--model` command line argument)

The proxy runs: `auth` (validate user_key) → `sessionInit` (team/agent/task selection form) → `injection` (inject L2/L3 memory, skills, and knowledge into the system prompt) → forward to the upstream LLM.

Client requests hit `POST /claude-code/:spaceId/v1/messages`.

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC automatically generates a session ID for each new conversation and sends it with requests. No manual configuration is needed.

---

## 3. Session Init (session initialization / form)

### 3.1 Mechanism

CC uses **Anthropic native `tool_use`** to present an interactive form:

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- Protocol: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 State machine

```
team_select → agent_select → task_select → initialized
```

Four step flow:
1. **team_select** — Select a team
2. **agent_select** — Select an agent
3. **task_select** — Select a task (includes an isDefault virtual option for skipping)
4. **initialized** — Inject assets and start normal conversation

### 3.3 Pagination

CC's `AskUserQuestion` tool has a hard limit of **2–4 options** (an Anthropic protocol constraint).  
When there are more than three options, pagination is used:

- Each page shows three real options + one "More→" navigation option
- Selecting "More→" returns the next page
- The last page has no navigation option

### 3.4 Plan Mode / Default Mode

CC has **no** Default Mode gate. The CC client always supports tool_use, so forms can always be sent.

### 3.5 Skipping Session Init

At any step, users can enter "skip" or select Other and enter skip to skip that step (matched by the `SKIP_RE` regular expression).  
After skipping, the proxy passes requests through without injecting assets.

---

## 4. Request classification

CC distinguishes several request types:

| Type | Identification | Handling |
|------|----------|------|
| **main** | Default | Full pipeline (injection + archiving + instrumentation) |
| **fork** | Analysis of `cache_control` marker positions | Full pipeline (subagents share session_id) |
| **sidequery** | `cache_control` marker + specific pattern | Lightweight handling |
| **compact** | Path suffix `/compact` | Auxiliary request; skip injection |
| **title-gen** | Path suffix + body characteristics | Auxiliary request; skip injection |

CC's `cache_control` marker is the main criterion for distinguishing main and auxiliary requests.

---

## 5. User text extraction

Extract from the last `role: "user"` message in `body.messages`:
- Take the last `type: "text"` content block
- **Skip** blocks starting with `<system-reminder>` (these are system injections rather than user text)

---

## 6. Injection profile

System prompt injection with a **Markdown structure**:

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

The injection point is `body.system` (in the Anthropic protocol, system is separate from messages).

---

## 7. Special behavior

- **resetEpoch**: supports `mem:session-reset` and stale checks across nodes
- **Vertex AI relay**: supports passing through `x-vertex-ai-session-id`
- **Fork/Subagent**: when CC's `task` command starts a subagent, session_id stays the same; the proxy archives subagent and main agent messages together
- **mem commands**: fully supports `mem:sync` / `mem:create-skill` / `mem:session-reset`, etc.

---

## 8. Archiving triggers

- Conversations exceeding thresholds (token count / turns) automatically trigger `skill/conversation/add`
- Supports manual archiving with `skill/conversation/force-archive`
- Archived data is written to L0 (TDAI write)

---

## 9. Environment variables

No CC specific variables. Use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC upstream
```

---

## 10. FAQ

**Q: Can CC get stuck when a form has too many options?**  
A: No. Pagination ensures at most four options at a time. With many options, users may need to navigate several pages.

**Q: Do CC subagent requests repeat session-init?**  
A: No. Subagents reuse the main agent's session_id. When the proxy detects an initialized session, it skips the form.

**Q: Do CC auxiliary requests (title-gen / compact) receive injection?**  
A: No. The proxy passes auxiliary requests through without injection or archiving.
