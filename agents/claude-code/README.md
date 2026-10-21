# Claude Code — local project setup

Connect Claude Code to local MemoryProxy and Knowledge MCP using files in your
working project. Put keys directly in those files. No memagent is required.
This guide uses Bash and an already installed, authenticated Claude Code CLI.

Proxy settings live in `.claude/settings.local.json`. MCP settings live in
`.claude/mcp.local.json`, loaded explicitly when starting the CLI. These files
apply to this project; no user-wide provider or MCP configuration is required.

## Step 1 — Start the local services

These instructions assume the Docker stack has already been configured in
`docker/.env`. From the **self_agent_memory repository root**, run:

```bash
docker compose -f docker/docker-compose.yml up -d --build memory memory-panel memory-proxy knowledgebase
curl -fsS http://127.0.0.1:8096/health
curl -fsS http://127.0.0.1:8421/health
```

The defaults are Panel `8125`, MemoryProxy `8096`, and Knowledge `8421`.
Adjust the client URLs below if you changed those ports. The client and Docker
stack must run on the same machine for these loopback URLs to work.

In `docker/memory-proxy.yaml`, check that `auth.enabled`,
`sessionInit.enabled`, `extraction.enabled`, `tdai.enabled`, and
`tdai.memory.writeL0` are `true` for conversation capture. Recall also needs
`injection.enabled` and `tdai.memory.inject`. These flags are enabled in the
current configuration. Keep the existing MemoryCore endpoints and service-token
settings. If MemoryCore uses a gateway key, configure the matching
`MEMORY_CORE_GATEWAY_API_KEY` in `docker/.env`.

After editing YAML, restart `memory-proxy`. After editing `.env`, recreate it
with `docker compose -f docker/docker-compose.yml up -d --force-recreate memory-proxy`.
A healthy proxy alone does not prove that model requests or capture work.

## Step 2 — Collect your local connection values

Open Memory Hub at <http://127.0.0.1:8125> and obtain:

- Your Memory Hub **user key**.
- A **team ID** you can access and an **agent ID** belonging to that team.
- Optionally, a task ID belonging to the same team.
- The Knowledge service key, if `KNOWLEDGE_SERVICE_KEY` is set in `docker/.env`.

Use IDs rather than display names. The Memory user key, Knowledge service key,
and model credential serve different purposes. The proxy removes
`x-tdai-user-key` before forwarding to the model and preserves model authentication.
`default` in the proxy URL is the memory instance ID, not the team ID.
The MCP `x-tdai-service-id` must match the tenant containing your Knowledge assets.

## Step 3 — Configure the proxy in your working project

Switch to the **project you want Claude Code to work on**, which may be different
from the self_agent_memory checkout:

```bash
cd /path/to/your/project
mkdir -p .claude
```

For a Git project, add `/.claude/settings.local.json` and
`/.claude/mcp.local.json` to its local Git exclude file
(`git rev-parse --git-path info/exclude`). These files contain literal keys.

Create or merge into `.claude/settings.local.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_CUSTOM_HEADERS": "x-tdai-user-key: <MEMORY_HUB_USER_KEY>\nx-team-id: <TEAM_ID>\nx-agent-id: <AGENT_ID>"
  }
}
```

Replace the placeholders directly in the file. Keep `\n` as JSON escapes between
headers. To associate a task, append `\nx-task-id: <TASK_ID>` inside the string.
Valid team and agent headers register the session directly; otherwise complete
the interactive selection form when it appears.

Keep your working Claude model authentication. The Memory user key is sent
through `ANTHROPIC_CUSTOM_HEADERS`; do not substitute it for the model credential
in `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. The proxy's
`upstream.agents.claude-code` entry should use `https://api.anthropic.com/v1`
with an empty `apiKey` to preserve the client's model credential.

If you authenticate with an Anthropic API key instead of an existing login,
add `"ANTHROPIC_API_KEY": "<YOUR_ANTHROPIC_API_KEY>"` to the same `env` object.
This is a model-provider key, not a Memory key. Use a model available to that
account. Successful subscription passthrough must be verified with a real
request for your client/account; service health alone cannot establish it.

Claude Code supports project-local settings and newline-separated custom
headers. See [settings](https://code.claude.com/docs/en/settings) and
[environment variables](https://code.claude.com/docs/en/env-vars).

## Step 4 — Create the project-local MCP file

Create `.claude/mcp.local.json`:

```json
{
  "mcpServers": {
    "memory_knowledge": {
      "type": "http",
      "url": "http://127.0.0.1:8421/mcp",
      "headers": {
        "x-tdai-service-id": "default"
      }
    }
  }
}
```

If Knowledge has a service key, add this entry to `headers`, with a comma after
the preceding entry:

```json
"Authorization": "Bearer <KNOWLEDGE_SERVICE_KEY>"
```

Replace the placeholder with the literal server key. No MCP OAuth login is
needed. `.claude/mcp.local.json` is a custom file name; the launch command below
loads it explicitly. See [Claude Code MCP](https://code.claude.com/docs/en/mcp).

```bash
chmod 600 .claude/settings.local.json .claude/mcp.local.json
```

## Step 5 — Start a new local session

From your working project root, run:

```bash
claude --mcp-config .claude/mcp.local.json
```

Claude Code loads `.claude/settings.local.json` for the project. Complete any
workspace trust prompt so project settings can apply. Approve the MCP connection
if prompted. The explicit MCP file must be supplied on each launch; plain
`claude` does not automatically load this custom file name.

Start a fresh session after changing keys or team/agent values. Use `/status`
to inspect the active client configuration and `/mcp` to inspect MCP status.
The `--mcp-config` flag is documented in the
[CLI reference](https://code.claude.com/docs/en/cli-reference).

## Step 6 — Verify model routing, memory, and MCP separately

1. Send a normal message and confirm the model responds through MemoryProxy.
2. Check Chat Memory in the Panel under the configured team and agent after the
   response finishes. A model response alone does not prove capture succeeded.
3. Run `/mcp` in the client and check that `memory_knowledge` connects and exposes
   12 tools: eight CodeGraph tools and four Wiki tools.
4. Register and index a repository or Wiki through the Panel/API. Then ask:
   “Use code_status for CodeGraph `<CODE_GRAPH_ID>`, then use code_search to find
   the authentication code.” For Wiki, supply its wiki ID and ask for wiki_search.

MCP provides read tools for CodeGraph/Wiki. It does not create/index assets or
provide the proxy's `mem:*` commands. You can use MCP independently of model
routing through MemoryProxy.

From the **self_agent_memory repository root**, inspect service logs if needed:

```bash
docker compose -f docker/docker-compose.yml logs --tail=100 memory-proxy knowledgebase
```

| Symptom | Check |
| --- | --- |
| Proxy connection refused | Start `memory-proxy`; verify port `8096`. |
| Memory authentication fails | Check the literal `x-tdai-user-key` value and the server's gateway key. |
| Model authentication fails | Check the model login/credential separately from the Memory user key. |
| No captured conversation | Check capture flags, user access, and successful team/agent session registration. Start a new session. |
| MCP returns 404 | Rebuild `knowledgebase` and confirm `KNOWLEDGE_MCP_ENABLED=true`. |
| MCP returns 401 | Match the MCP Authorization header to the server's Knowledge service key. |
| MCP returns 403 | If the client sends Origin, add that exact origin to `KNOWLEDGE_MCP_ALLOWED_ORIGINS`. |
| MCP connects but cannot find an asset | Check the asset ID, index status, and `x-tdai-service-id`. |

Opening `/mcp` in a browser sends GET; 405 is expected after access checks.
Use the client's MCP connection to test initialization and tool calls.
See [Knowledge MCP](../../MemoryKnowledge/MCP.md) for transport details.

## Adapter reference

- Agent source: `claude-code`; handler: `MemoryProxy/src/anthropicHandler.ts`.
- Protocol: Anthropic Messages; route: `/claude-code/:spaceId/v1/messages`.
- Session headers: `x-claude-code-session-id`, `x-session-id`, then
  `x-conversation-id`.
- Interactive selection uses `AskUserQuestion`; valid team/agent headers bypass
  the form. Task association is optional.
- Memory is injected into `body.system`. Auxiliary requests bypass the main
  injection/archiving flow.
- The proxy handles `mem:*` commands; Knowledge MCP supplies separate read tools.

For optional historical imports, see [asset import](./asset-import.md).
