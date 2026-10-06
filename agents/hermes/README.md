# Hermes

> agentSource: `hermes` | Protocol: OpenAI Chat Completions | Session Init: Header preselection (no interactive form)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

Hermes is configured through the **configuration file** `~/.hermes/config.yaml`:

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:8096/hermes/<spaceId>
  api_key: <business user's sk-mem-... user_key>
  default_headers:
    x-team-id: <team_id-from-panel>
    x-agent-id: <agent_id-from-panel>
    x-task-id: <task_id-from-panel>
    x-conversation-id: <custom-conversation-identifier>
```

Field descriptions:
- `base_url` — Proxy address + `/hermes/<spaceId>`; `default` is the memory instance ID
- `api_key` — Business user's `user_key` (from the panel)
- `x-team-id` / `x-agent-id` / `x-task-id` — Obtain from the corresponding panel pages
- `x-conversation-id` — User defined conversation identifier (see §6 Known limitations below)

Request path: `POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| Only source | `x-conversation-id` (statically specified in the configuration file by the user) |

⚠️ Hermes does not manage session IDs automatically. Users must manually change `x-conversation-id` for each new conversation.

---

## 3. Session Init (session initialization)

### ⚠️ Key difference: Header preselection only, no interactive form

Hermes **does not support interactive forms** (the client cannot respond to function_call returned by the proxy).  
Session registration depends entirely on request headers:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (current version) |
| `x-conversation-id` | Conversation identifier | ✅ |

**Handling logic**:
- All four headers present and valid → register the session directly and inject assets
- Any missing → session bypass (pass through without injection)

### No Plan Mode / Default Mode

Hermes has no Plan/Default mode distinction. Complete headers enable the full pipeline; otherwise requests bypass it.

---

## 4. Request classification

All requests are **main**. Hermes has no auxiliary request concept.

---

## 5. Injection profile

Same as CB: XML structured injection into `messages[0].content` (system message).

---

## 6. Known limitations

### `x-task-id` is currently required

Proxy header preselection requires all three IDs to register a session. Without `x-task-id`, the proxy tries to present a form, but Hermes cannot respond → session bypass → memory injection does not take effect.

**Impact**:
- Users must create a task in the panel beforehand and obtain task_id
- Switching tasks requires manually editing the configuration file

### `x-conversation-id` requires manual management

- All requests with the same conversation ID share one session
- Change it manually for each new conversation (otherwise the previous session state is reused)
- Some subsequent client tool call requests may omit extra headers → those turns skip injection

---

## 7. FAQ

**Q: Why is memory injection not taking effect?**  
A: Check that all four `extra_headers` values are present and correct. Any missing/incorrect value causes session bypass.

**Q: How do I obtain team_id / agent_id / task_id?**  
A: Sign in to the panel → corresponding page → find the ID field in the details. Alternatively, query panel APIs `team/list`, `agent/list`, and `task/list`.

**Q: What if I do not want to link a task?**  
A: It is required in the current version. Configure `sessionInit.defaultTaskId: "no-task"` in the proxy's `config.yaml`, then use that fixed value.
