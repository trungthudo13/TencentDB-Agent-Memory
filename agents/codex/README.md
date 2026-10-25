# Codex — per-project Memory configuration

Codex uses an explicitly selected user-level profile for MemoryProxy routing,
and project-local `.codex/config.toml` for Knowledge MCP. Your default
`~/.codex/config.toml` is not changed.

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
credentials remain separate from the Memory user key. Existing values are
merged and old files receive private `.bak.<timestamp>` backups. TOML comments
and formatting remain in the backup rather than the rewritten configuration.
Generated project config files and backups are added to `.gitignore` because
they contain literal keys. Tracked target files are rejected before writing.

## Profile naming and launch

The folder name is lowercased, accents are normalized to ASCII (including
Vietnamese `đ`), runs of separators become `-`, and `-memory` is appended.
For example, `My_Project` becomes `my-project-memory`; `Dự Án_Test` becomes
`du-an-test-memory`. A name without ASCII letters/digits falls back to `project`.

For this repository, the generated files are:

```text
~/.codex/self-agent-memory-memory.config.toml  # Proxy + user/team/agent headers
<project>/.codex/config.toml                 # Knowledge MCP, if enabled
```

Run from the project root:

```bash
codex --profile self-agent-memory-memory
```

The wizard prints the actual command for your folder. Profiles share your
normal Codex home and login; no separate login or launcher is created. A plain
`codex` invocation does not select the generated profile. Profile selection is
explicit, not automatically bound to a directory.

The profile selects the `memory_proxy` provider, using Responses over HTTP/SSE
and `x-tdai-user-key`, `x-team-id`, `x-agent-id` headers. Keep the proxy's Codex
upstream configured to accept your model authentication. The Memory user key
is not a model bearer token.

The installer looks for the normalized profile name and creates it if absent.
For an existing profile (including one created manually), it updates
`model_provider`, the managed fields in `[model_providers.memory_proxy]`, and
the three Memory headers in `[model_providers.memory_proxy.http_headers]`.
Other settings, providers, and custom headers are preserved; a backup is made
before writing. Projects with the same normalized folder name use the same
profile, so installing either updates that shared profile.
Unset a custom `CODEX_HOME` before installation so `codex --profile` reads the
profiles in `~/.codex/`.

Provider routing keys are ignored in project-local `.codex/config.toml`.
User-level profile files are selected using `--profile`; see the official
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Upgrading from the previous installer

Rerun the wizard and use the printed `codex --profile` command. Old
`.codex-local/` and `.memory-clients/` files are left untouched and are no longer
needed by this setup. If you authenticated only in the old isolated home, sign
in to your normal Codex home with `codex login` once.

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
