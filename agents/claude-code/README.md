# Claude Code — project configuration

MemoryProxy settings live in `.claude/settings.json`. Knowledge MCP lives in
`.mcp.json` at the project root. Claude Code discovers these standard files;
no launcher or `--mcp-config` argument is needed.

## Run the installer

Install the client CLI separately and start MemoryProxy / Knowledge Service.
From the project you want the client to work on, run:

```bash
bash /path/to/self_agent_memory/scripts/install.sh
```

After the script is published on `main`, the same wizard can be downloaded:

```bash
curl -fsSL https://raw.githubusercontent.com/trungthudo13/TencentDB-Agent-Memory/main/scripts/install.sh | bash
```

Requires Bash, Python 3.11+, and an interactive terminal. Prompts read from
`/dev/tty`, so piping the script does not consume wizard answers. To target a
different directory, use `bash -s -- /path/to/project` after the pipe.

The wizard groups questions into Client, Memory identity, Proxy connection,
and Knowledge MCP. Its summary separates file changes (`Created`, `Updated`,
`Kept`), launch commands, exact backup paths, and future update instructions.
Warnings are grouped at the end on stderr; results and commands use stdout.
Prompts remain on `/dev/tty` when stdout is redirected.

Choose exactly one client, `codex` or `claude` (required, no default), and enter:

- `user_key` (hidden), `team_id`, and `agent_id` from Memory Hub.
- MemoryProxy root URL (default `http://127.0.0.1:8096`).
- Memory instance ID (default `default`, distinct from team/agent IDs).
- MemoryCore root URL (default `http://127.0.0.1:8420`) and optional gateway
  key for identity checks. This key is not saved in the client configuration.
- Optionally the Knowledge MCP URL (default `http://127.0.0.1:8421/mcp`), service
  ID, and service key (hidden, optional if the server has no key).

The installer configures clients; it does not install CLI binaries, start
services or authenticate model accounts. Before any file writes, it validates
Proxy health, the Memory user key, active team membership, agent ownership and
team/status, and optional MCP initialization. It then lists planned changes and
asks `Save this configuration? (y/n) [n]`. Failure or declining leaves config
files unchanged. Model authentication and Knowledge asset queries are not tested. Model
credentials remain separate from the Memory user key. For Claude, only missing options are added; existing values are skipped.
Modified existing files receive private `.bak.<timestamp>` backups. Unchanged
files are not rewritten or backed up. TOML comments
and formatting remain in the backup rather than the rewritten configuration.
Generated project config files and backups are added to `.gitignore` because
they contain literal keys. Tracked target files are rejected before writing.

## Start Claude Code

From the project root:

```bash
claude
```

The installer adds `ANTHROPIC_BASE_URL` and newline-separated
`ANTHROPIC_CUSTOM_HEADERS` only if those options are missing. New headers contain `x-tdai-user-key`, `x-team-id`, and
`x-agent-id`. An existing `ANTHROPIC_CUSTOM_HEADERS` value is kept in full.
An existing `mcpServers.memory_knowledge` entry is also skipped in full, even
if its URL or headers differ. Other servers and settings remain unchanged.
To change existing options, edit them directly. Keep your existing model
login or API key; do not replace it with the Memory user key.

The root `.mcp.json` contains a `mcpServers.memory_knowledge` HTTP entry.
Claude Code may ask you to approve the project MCP server on the first run.
Check `/mcp` after approving it. See the official
[project MCP documentation](https://code.claude.com/docs/en/mcp#project-scope).

## Upgrading from the previous installer

The previous installer used `.claude/mcp.local.json`, a custom path Claude
Code does not auto-load. That is why its launcher passed `--mcp-config`.
Rerun the wizard to write the standard files and then run `claude` directly.
Old `.memory-clients/` and `.claude/mcp.local.json` files are left untouched.

If `.claude/settings.local.json` still contains old proxy settings, review or
remove those specific values: local settings can override `.claude/settings.json`.
The wizard prints a reminder when that file exists and does not delete it.
See [settings precedence](https://code.claude.com/docs/en/settings).

## Verify the connection

Start a new client session from the project directory and accept workspace/MCP
trust prompts when applicable. Send a message and confirm it appears in Memory
Hub under the intended team and agent. Check `/mcp` for `memory_knowledge`.
Service health alone does not prove model authentication or memory capture.

Register and index repositories/Wikis through the Panel/API first. Supply a
`code_graph_id` or `wiki_id` when asking the client to use Knowledge tools.
Knowledge MCP exposes eight CodeGraph and four Wiki read tools; it does not
index assets or implement the proxy's `mem:*` commands.

If model authentication fails, check the model login independently of the
Memory user key. MCP 401 errors require the Knowledge service key, not the user
key. Check the tenant service ID and asset ID if searches return no data.
See [Knowledge MCP](../../MemoryKnowledge/MCP.md) for transport troubleshooting.

## MCP-first context hooks

The installer can register project-local lifecycle hooks without changing
`AGENTS.md` or `CLAUDE.md`. Add graph/wiki IDs after installation in
`.memory-hub/context.toml`; edit retrieval order and `strict`/`advisory`/`off`
there. Reinstall keeps this policy unchanged and preserves existing hooks.
Review `/hooks`, configure IDs, and start a new session. Strict mode blocks
local tools until configured MCP retrieval succeeds; empty IDs remain blocked.
See [setup, limitations and verification](../../scripts/CONTEXT-HOOKS.md).
