---
name: setup-proxy
description: Interactively guide users through connecting an AI agent to Memory Proxy, probing and validating step by step
triggers:
  - configure proxy
  - configure agent
  - setup proxy
  - connect to proxy
  - connect to memory
---

# Setup Proxy — Agent connection configuration wizard

You are helping the user connect an AI agent client (Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / Hermes / OpenClaw) to Memory Proxy.

## Background

Memory Proxy is an LLM request proxy that injects team memory/skills/knowledge before forwarding requests upstream. Each agent client has a different configuration format and protocol:

| Agent | Configuration file | Protocol | Special requirements |
|-------|----------|------|----------|
| claude-code | `~/.claude/settings.json` | Anthropic Messages | Set five model variables in the env field |
| codebuddy | `~/.codebuddy/models.json` | OpenAI Chat | Append an entry to the models array |
| codex | `~/.codex/config.toml` | OpenAI Responses | TOML format; requires `wire_api = "responses"` |
| workbuddy | `~/.workbuddy/models.json` | OpenAI Chat / Responses | Top level array |
| dsh | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` | OpenAI Chat (without /v1) | Two files + chmod 700/600 |
| hermes | `~/.hermes/config.yaml` | OpenAI Chat | Requires header preselection (x-team-id/agent-id/task-id) |
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | Requires header preselection + allowPrivateNetwork |

## Script location

Configuration writing script: `agents/skills/setup-proxy/setup-proxy.sh` (relative to the repository root)

## Execution flow

**Follow this order strictly. Validate each step successfully before proceeding to the next.**

### Step 1: Scan existing configuration

First check whether the user already has proxy configuration to avoid asking for the same values again:

```bash
# Check Claude Code
cat ~/.claude/settings.json 2>/dev/null | jq -r '.env.ANTHROPIC_BASE_URL // empty'

# Check CodeBuddy
cat ~/.codebuddy/models.json 2>/dev/null | jq -r '.models[]? | select(.url | contains("/codebuddy/")) | .url' 2>/dev/null | head -1

# Check other agents similarly...
```

If a URL contains a proxy path (segments such as `/claude-code/`, `/codebuddy/`, `/codex/`), **extract and display**:
- Proxy address (the URL portion before `/<agent>/`)
- Instance ID (the segment after `/<agent>/`)
- User Key (the corresponding field, masked to show only the first and last four characters)
- Model ID

Ask the user: "Existing configuration detected. Reuse it?"
- Yes → skip to Step 3
- No → continue to Step 2 for manual input

### Step 2: Collect basic information

Ask the user for the following in order:
1. **Proxy address** (including scheme and port, such as `http://127.0.0.1:8096`)
2. **Instance ID** (defaults to `default`; local deployments usually need no change)
3. **User Key** (from the panel's API Key page; any format is accepted)

Confirm each item after receiving it; do not ask for all three at once.

### Step 3: Select an agent

Show the seven available agents and ask the user to choose **one**:
1. Claude Code
2. CodeBuddy
3. Codex
4. WorkBuddy
5. dsh (DeepSeek Harness)
6. Hermes
7. OpenClaw

### Step 4: Enter the model ID

Tell the user:
- The model ID must be supported by the proxy upstream
- Common examples: `claude-sonnet-4-20250514`, `claude-opus-4.7`, `gpt-5.5`, `deepseek-r1`

### Step 5: Health probe (critical validation step)

Build a corresponding curl probe **based on the selected agent's protocol**:

```bash
# Claude Code → Anthropic Messages
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# CodeBuddy / Hermes / OpenClaw → OpenAI Chat
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/${AGENT}/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# dsh → OpenAI Chat without /v1
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# Codex → Responses API
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],"stream":false}'

# WorkBuddy → OpenAI Chat (more generally applicable)
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
```

**Interpret results**:
- HTTP connection failure (000) → tell the user the proxy is unreachable and ask them to check address/port/service status; **do not continue**
- 2xx → healthy; continue
- 4xx → proxy reachable (may be a session-init form or auth issue); **show the response body for reference** and continue
- 5xx → proxy issue; **show the full error response** and ask whether to continue

### Step 6: Header preselection (Hermes / OpenClaw only)

If hermes or openclaw is selected, collect header preselection information. These agents do not support interactive forms, so team/agent/task IDs must be filled in beforehand.

**Preferred approach: fetch lists through the panel API and let the user choose**

Ask whether the user can provide the panel backend address (defaults to `http://127.0.0.1:8125`). If provided:

```bash
# 1. First obtain user_id through auth/verify
curl -s -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Extract from .data.user.user_id

# 2. Fetch the team list
curl -s -X POST "${PANEL_URL}/api/v1/meta/team/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Display .data.items for user selection

# 3. Fetch the agent list (filtered by owner_user_id)
curl -s -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'","owner_user_id":"'${USER_ID}'"}'
# Display .data.items for user selection

# 4. Fetch the task list
curl -s -X POST "${PANEL_URL}/api/v1/meta/task/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'"}'
# The first option is always "Do not link a task for this conversation (no-task)"
```

If the panel is unreachable or the user does not wish to provide it, ask for team_id / agent_id / task_id manually.

An **x-conversation-id** is also required (can be generated automatically, such as `conv-20260820-xxxx`).

### Step 7: Confirm the configuration file path

Tell the user the default path (see the table above) and ask whether to use it. Otherwise, ask for their preferred path.

### Step 8: Call the script to write configuration

After all information is collected and validated, **call the script in noninteractive mode** to write configuration:

```bash
bash agents/skills/setup-proxy/setup-proxy.sh --non-interactive \
  --proxy-host "${PROXY_HOST}" \
  --instance-id "${INSTANCE_ID}" \
  --user-key "${USER_KEY}" \
  --agent "${CHOSEN_AGENT}" \
  --model "${MODEL_ID}" \
  --config-path "${CONFIG_PATH}"
```

For Hermes/OpenClaw, append:
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

**Check the script exit code**: 0 = success, nonzero = failure (show the output to the user).

### Step 9: Verify the written configuration

Read the configuration file after writing to confirm its contents:
```bash
cat <config_path>
```

Show the key fields for user confirmation.

### Step 9.5: Remind the user to switch models

**Writing configuration does not make it active**. Remind the user to select the proxy model in the client so requests use the proxy pipeline:

| Agent | How to switch |
|-------|----------|
| Claude Code | No action needed; env from `settings.json` loads automatically at startup |
| CodeBuddy | Switch the dialog model to **proxy-memory-agent** (the configured model ID) |
| Codex | No action needed; `config.toml` already specifies model |
| WorkBuddy | Select the corresponding model from the custom model list in the model selector |
| dsh | No action needed; `settings.yaml` already specifies the model |
| Hermes / OpenClaw | Ensure the selected provider/model points to the proxy configuration |

**Make sure the user knows**: without switching models, requests do not pass through the proxy and memory/skill injection does not take effect.

### Step 10: Asset import (optional)

After configuration, ask whether to import the agent's local assets (skills + conversation history) into team memory.

If the user chooses to import:
- Panel URL, Team ID, and Agent ID are required
- If team/agent were selected in Step 6, recommend reusing them
- Otherwise, ask the user to provide them

Then call:
```bash
PANEL_URL="${PANEL_URL}" TDAI_SERVICE_ID="${INSTANCE_ID}" TDAI_USER_KEY="${USER_KEY}" \
  tsx agents/asset-import.ts --source "${CHOSEN_AGENT}" --team-id "${TEAM_ID}" --agent-id "${AGENT_ID}"
```

If `tsx` is unavailable, ask the user to run the command manually.

## Error handling principles

1. **Connection failure**: clearly identify the failed step and suggest troubleshooting (service status, port, network)
2. **4xx response**: proxy reachable but application error; show the full response body and help determine whether the key is wrong, the model is unsupported, or another issue exists
3. **File permissions**: check that the directory exists and is writable before writing; dsh requires chmod
4. **Do not guess**: if information is missing or state is unclear, ask the user instead of assuming

## Notes

- Configure only one agent at a time; after completion, tell the user they can run again for other agents
- The script automatically backs up the original configuration as `.bak.<timestamp>`
- All CC model environment variables (HAIKU/SONNET/OPUS/SUBAGENT) are set to the user's selected model
- Codex requires Plan mode (Shift+Tab) before the first conversation; this is a client limitation
- dsh URLs omit `/v1`; this is hardcoded by the client
- Hermes/OpenClaw's x-conversation-id must be changed manually for each new conversation
