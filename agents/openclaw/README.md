# OpenClaw

> agentSource: `openclaw` | Protocol: OpenAI Chat Completions | Session Init: Header preselection (no interactive form)
>
> To import local history into Memory Hub, see the [asset import guide](./asset-import.md).

---

## 1. Client configuration

OpenClaw is configured through the `models.providers` section of the **configuration file** `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:8096/openclaw/<spaceId>",
        "apiKey": "<business user's sk-mem-... user_key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<team_id-from-panel>",
          "x-agent-id": "<agent_id-from-panel>",
          "x-task-id": "<task_id-from-panel>",
          "x-conversation-id": "<custom-conversation-identifier>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

Field descriptions:
- `baseUrl` — Proxy address + `/openclaw/<spaceId>`; `default` is the memory instance ID
- `apiKey` — Business user's `user_key` (from the panel)
- `api` — Must be `"openai-completions"`
- `headers` — Must contain `x-team-id`, `x-agent-id`, `x-task-id`, and `x-conversation-id`
- `models[].id` — Must match the model ID configured in the proxy upstream
- `allowPrivateNetwork: true` — Allow access to private network addresses

Request path: `POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| Only source | `x-conversation-id` (statically specified in the configuration file by the user) |

Like Hermes, OpenClaw does not manage session IDs automatically; change them manually.

---

## 3. Session Init (session initialization)

### ⚠️ Key difference: Header preselection only, no interactive form

OpenClaw behaves exactly like Hermes: **interactive forms are not supported**, and session registration depends on headers:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (current version) |
| `x-conversation-id` | Conversation identifier | ✅ |

**Handling logic**:
- All four headers present and valid → register the session directly and inject assets
- Any missing → session bypass (pass through without injection)

---

## 4. Request classification

All requests are **main**. OpenClaw has no auxiliary request concept.

---

## 5. Injection profile

Same as CB: XML structured injection into `messages[0].content` (system message).

---

## 6. Known limitations

Exactly the same as Hermes:

### `x-task-id` is currently required

If missing, the session is bypassed and memory injection does not take effect.  
Solution: configure `sessionInit.defaultTaskId: "no-task"` in the proxy and use that fixed value.

### `x-conversation-id` requires manual management

- Identical IDs share a session; change the value manually for new conversations
- Some subsequent tool call turns may omit headers → those turns skip injection

---

## 7. FAQ

**Q: How does it differ from Hermes?**  
A: From the proxy's perspective, behavior is identical (header preselection + OpenAI Chat). Only the client configuration format (YAML vs JSON) and agentSource marker differ.

**Q: Can I set cost to 0 in models?**  
A: Yes. OpenClaw uses cost for client budget calculations. With the proxy, actual billing occurs upstream, and setting client cost to 0 does not affect functionality.

**Q: What is `allowPrivateNetwork: true`?**  
A: OpenClaw blocks private network requests by default as a security policy. This setting allows access to a proxy on `127.0.0.1` or an internal IP.
