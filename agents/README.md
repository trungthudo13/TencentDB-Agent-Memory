# Agents

Memory Proxy currently supports seven types of AI agent clients, with significant differences in protocol, session initialization, and injection logic.

> 🛠 **Want to connect a new AI agent client that is not listed below?**
> Read the [**new client adaptation development guide →**](./adapter-agent-development.md)
> It includes a 20 item checklist covering traffic capture, proxy routing / adapters / session-init, and successful end to end validation, plus eight common pitfalls and a reusable dsh reference implementation.

## Quick start

### Method 1: Run the script manually

```bash
cd <repository-root>
bash agents/setup-proxy.sh
```

The interactive wizard guides you through connecting an agent to the proxy:
1. Automatically scan existing configuration (reuse it if present, without reentering values)
2. Select the agent to configure
3. Enter the model ID
4. Run a health probe (verify proxy connectivity)
5. Write the configuration file (automatically back up the original as `.bak`)
6. Optional: import local skills/conversations into team memory

Supports all seven agents. Configure one per run; run again to configure other agents.

### Method 2: AI agent assisted configuration (skill)

Let an AI agent such as Claude Code / CodeBuddy guide configuration using the skill. The agent checks the environment, verifies connectivity, and adapts its choices step by step.

#### Step 1: Copy the agents directory to your home directory

```bash
cd <repository-root>
cp -r agents ~/agents
```

#### Step 2: Use the following prompts in an AI agent conversation

> Note: the agent must first run `cd ~/agents` before executing scripts.

**Connect a new agent to the proxy:**

```
Please read the skill document ~/agents/skills/setup-proxy/SKILL.md and follow its steps to guide me through connecting an agent to Memory Proxy.
```

**Configure a specific agent (such as Claude Code):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and configure Claude Code to connect to Memory Proxy. My proxy address is http://localhost:8096 and the instance ID is default.
```

**Configure Hermes/OpenClaw (requires header preselection):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and configure Hermes to connect to Memory Proxy. The panel address is http://localhost:8125. Fetch the team/agent lists from the panel so I can choose.
```

**Run only a health probe (without writing configuration):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and check whether the proxy at http://localhost:8096 is working, using the codebuddy protocol and model claude-opus-4.7.
```

> ℹ️ The skill is in `agents/skills/setup-proxy/SKILL.md`, with its script at `agents/skills/setup-proxy/setup-proxy.sh`. The agent collects information and validates the environment step by step, then calls the script in `--non-interactive` mode to write configuration.

---

Each subdirectory corresponds to an agent and contains:
- `README.md` — Connection configuration, adaptation approach, Session Init flow, and FAQ
- `asset-import.md` — Import the client's local skills / memory / sessions into Memory Hub (complete guide in one file)
- `asset-import.ts` — Client disk scanning implementation; the shared entry point is `agents/asset-import.ts` at the repository root, with `--source <name>` selecting the IDE
- Future additions may include adaptation notes, debugging scripts, traffic capture fixtures, etc.

---

## Quick comparison

| Agent | Protocol | Session Init method | Form Tool | Pagination | Default/Plan Gate | Headless Bypass |
|-------|------|-------------------|-----------|------|-------------------|-----------------|
| [Claude Code](./claude-code/) | Anthropic Messages | Interactive form | `AskUserQuestion` | ✅ (max 4) | ❌ | ❌ |
| [CodeBuddy](./codebuddy/) | OpenAI Chat Completions | Interactive form | `ask_followup_question` | ❌ (unlimited) | ❌ | ❌ |
| [Codex](./codex/) | OpenAI Responses API | Interactive form + Default Gate | `request_user_input` | ✅ | ✅ | ❌ |
| [WorkBuddy](./workbuddy/) | Responses (Desktop) / Chat (Web) | Interactive form | `AskUserQuestion` | ✅ (max 4) | ✅ | ✅ (silent pass through) |
| [dsh (DeepSeek Harness)](./dsh/) | OpenAI Chat Completions | Interactive form + Headless Bypass | `ask_user_question` | ❌ (unlimited) | ❌ | ✅ (when no tool is available) |
| [Hermes](./hermes/) | OpenAI Chat Completions | Header preselection (no form) | N/A | N/A | N/A | ✅ (when headers are missing) |
| [OpenClaw](./openclaw/) | OpenAI Chat Completions | Header preselection (no form) | N/A | N/A | N/A | ✅ (when headers are missing) |

---

## Local asset import

Import each client's skills / memory / historical sessions from disk into Memory Hub. Each client has a scanner that you can run directly:

```bash
# Interactive import (prompts y/N for skills / memory / sessions after starting)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# Noninteractive full import (scripts/CI)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```


| Agent | Guide |
|-------|------|
| Claude Code | [asset-import.md](./claude-code/asset-import.md) |
| CodeBuddy | [asset-import.md](./codebuddy/asset-import.md) |
| Codex | [asset-import.md](./codex/asset-import.md) |
| WorkBuddy | [asset-import.md](./workbuddy/asset-import.md) |
| dsh | [asset-import.md](./dsh/asset-import.md) |
| Hermes | [asset-import.md](./hermes/asset-import.md) |
| OpenClaw | [asset-import.md](./openclaw/asset-import.md) |

---

## Session ID header reference

| Agent | Primary header | Fallback |
|-------|-----------|------|
| Claude Code | `x-claude-code-session-id` | `x-session-id`, `x-conversation-id` |
| CodeBuddy | `x-conversation-id` | `x-session-id`, `x-cb-session-id`, `x-codebuddy-session-id` |
| Codex | `session-id` | `body.client_metadata.session_id` |
| WorkBuddy | `session-id` | `body.client_metadata.session_id` |
| dsh | `x-deepseek-harness-session-id` | `x-session-id` |
| Hermes | `x-conversation-id` | — (statically configured by user) |
| OpenClaw | `x-conversation-id` | — (statically configured by user) |

---

## Client configuration methods

| Agent | Configuration method | Configuration file / variables | Key delivery |
|-------|----------|-----------------|----------|
| Claude Code | Environment variables or configuration file | `~/.claude/settings.json` or env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | env / JSON `env.ANTHROPIC_AUTH_TOKEN` |
| CodeBuddy | Configuration file | `~/.codebuddy/models.json` | JSON `apiKey` |
| Codex | Configuration file | `~/.codex/config.toml` | TOML `experimental_bearer_token` |
| WorkBuddy | Configuration file | `~/.workbuddy/models.json` | JSON `apiKey` |
| dsh | Configuration file | `~/.dsh/settings.yaml` + `.credentials.yaml` | YAML environment variable reference |
| Hermes | Configuration file | `~/.hermes/config.yaml` | YAML `api_key` + headers |
| OpenClaw | Configuration file | `~/.openclaw/openclaw.json` | JSON `apiKey` + headers |

---

## Routing rules

```
/:agent/:spaceId/v1/messages          → Anthropic protocol (CC, CB-Anthropic)
/:agent/:spaceId/v1/chat/completions  → OpenAI Chat (CB, WB-web, dsh, Hermes, OpenClaw)
/:agent/:spaceId/chat/completions     → OpenAI Chat without v1 prefix (dsh)
/:agent/:spaceId/v1/responses         → Responses API (Codex, WB-desktop)
/:agent/:spaceId/responses            → Responses API without v1 prefix (Codex, WB-desktop)
```

---

## Header preselection (shared, available to all agents)

In addition to interactive forms, **all agents** support direct session registration through HTTP headers, skipping form interaction. Suitable for:
- Clients unable to respond to forms (such as Hermes / OpenClaw)
- Skipping forms to speed up the first response (such as CI/CD automation)
- Third party platforms / custom agents

### Required headers

| Header | Description |
|--------|------|
| `Authorization: Bearer <user_key>` | Business user's API key (from the panel) |
| `x-team-id` | Team ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | Task ID (required in the current version) |
| `x-conversation-id` | Conversation identifier generated and managed by the client |

All headers present → the proxy registers the session and injects assets directly, without a form.  
Any missing → interactive form (if supported by the client) or session bypass (if forms are unsupported).

### Connecting other platforms

Any OpenAI API compatible platform can connect by pointing its API base URL to the proxy:

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`: must be one of the values supported by the proxy: `claude-code`, `codebuddy`, `workbuddy`, `codex`, `hermes`, `openclaw`. Other platforms can connect by identifying as one of these (such as `codebuddy`)
- `<spaceId>`: memory instance ID (always `default` for local deployments)

---

## New agent integration overview

1. **Capture traffic** — Use mitmproxy to capture 3–5 typical request types (main / aux / title-gen), and save them in `MemoryProxy/docs/<agent>-recon/`
2. **Identify the protocol** — Determine the wire protocol (Anthropic / Chat / Responses)
3. **Determine the Session ID source** — Find the unique conversation identifier in headers or body
4. **Choose a Session Init strategy** — Tool available → interactive form; no tool → header preselection / headless bypass
5. **Classify auxiliary requests** — Identify title-gen / compact / fork requests that do not need the full pipeline
6. **Implement or reuse a handler** — Clients sharing a protocol can share a handler (such as dsh reusing CB's handleChatCompletions)
7. **Injection profile** — Define injection templates matching the client's system prompt format
8. **E2E validation** — Run the complete pipeline to confirm session-init + injection + archiving

👉 **For the complete development steps (20 item checklist + eight common pitfalls + dsh reference implementation), see [`adapter-agent-development.md`](./adapter-agent-development.md)**.
