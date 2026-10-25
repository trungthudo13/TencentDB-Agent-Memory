# Memory Hub context hooks

Run `bash /path/to/self_agent_memory/scripts/install.sh` from the client project
(or use its existing curl installer). Enable Knowledge MCP and context hooks.
The wizard does not ask for graph/wiki IDs. It installs native project hooks:

- Codex: `.codex/hooks.json` alongside the project MCP config.
- Claude Code: merges hooks into `.claude/settings.json` alongside proxy settings.
- Both: `.memory-hub/context-hook.py` and `.memory-hub/context.toml`.

This is direct hook registration, not a marketplace plugin installation. It uses
Python 3.11+ already required by the Bash installer, with POSIX file locking.
No AGENTS.md or CLAUDE.md is created or modified. Existing hook handlers remain;
reruns replace only Memory Hub handlers and back up changed files. Declining the
installer's final confirmation changes nothing. Choosing not to install hooks on
a later run does not uninstall previously installed hooks.

## Configure assets after installation

Edit `.memory-hub/context.toml` manually:

```toml
mode = "strict"
mcp_server = "memory_knowledge"
code_graph_ids = ["cg-your-project"]
wiki_ids = ["wiki-your-team"]
order = ["wiki", "code"]
```

Use actual IDs shown in Memory Hub; example IDs are placeholders. Either list can
be empty; multiple IDs are supported. The order is yours: both source names must
appear once, empty sources are skipped, and IDs within a source run in listed
order. The generated template has empty lists and `order = ["code", "wiki"]`.
No API keys belong here. Credentials remain in the MCP configuration.

Every hook rereads this file. Changing policy invalidates prior retrieval state;
no reinstall is necessary. Reinstall preserves the file byte-for-byte, including
comments and custom order. The `.memory-hub/` directory is ignored by Git.

## Lifecycle and enforcement

1. SessionStart injects policy, including when the client resumes after compact.
2. UserPromptSubmit resets this session's retrieval gate and injects policy again.
3. The agent calls `code_explore`/`code_search` and/or `wiki_search` with matching
   asset IDs and a nonempty query relevant to the prompt, in configured order.
4. PreToolUse records the expected MCP call; PostToolUse accepts its successful
   MCP result. Status/list calls and wrong IDs do not satisfy the gate. Empty
   successful results count, but the agent must disclose missing context.
5. Once every configured asset has been queried, local tools may verify current
   source, run tests and make changes. A new prompt resets the gate.

`strict` blocks supported local tools (shell, file reads/searches/edits) until
retrieval completes. It applies to every prompt that needs these tools, even a
simple local command. Empty IDs or an invalid policy remain blocked and visibly
report configuration is needed. Fix the TOML manually; the agent is instructed
not to change policy to bypass it. On MCP failure, strict mode remains closed.

`advisory` injects instructions but allows local tools; use it for an explicit
fallback during an outage. `off` disables this integration's hook behavior.
Neither setting removes another team's hooks or changes client permissions.

SubagentStart injects the same instructions. State is separated by session and
agent ID when supplied by the host; subagent enforcement depends on the host
emitting tool hooks with distinct session/agent identities. State uses locked,
atomic writes and records hashes/step counters, not prompts, keys or results.

## Activate and verify

After installing, fill the TOML and check `/mcp` and `/hooks` in the client.
Codex requires the project and exact hook definitions to be reviewed/trusted;
installation does not grant that trust. New/changed definitions need review.
Start a new session after changing hook registration or updating the script.
Claude settings that disable hooks, managed policy, or unsupported client
versions can prevent execution. The installer reports installed, not verified
active: its preflight checks the MCP handshake, not asset readiness or hook runs.

In a new session ask about a code path. Observe the configured MCP searches before
local reads. Test a local search before retrieval: it should be denied in strict
mode. Test another prompt to confirm the gate resets. Inspect results and verify
queries are relevant; the hook cannot judge semantic relevance or index freshness.

This is workflow enforcement over tool events the host exposes, not a security
sandbox. It cannot guarantee coverage for unobserved tools, tool wrappers,
clients that skip hooks, or hosts that omit identity/result fields. The shell
itself can alter local files after the gate opens. Do not describe this as an
unbypassable access control system. No automatic network query is made by the
hook; the agent must use the configured MCP tools.

To disable, set `mode = "off"`. To remove, delete only handlers whose command
ends in `--memory-hub-managed` and points at `.memory-hub/context-hook.py` from
both clients' hook configs before removing `.memory-hub/`. Keep other hooks.

## Verification and references

Run `python3 -m unittest discover -s scripts/tests -v` and
`bash -n scripts/install.sh`. Tests use isolated directories and simulated tool
payloads; they do not replace the activation check in your installed clients.

- [Codex hooks: discovery, trust, inputs and decisions](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Ponytail lifecycle implementation](https://github.com/DietrichGebert/ponytail/blob/main/hooks/claude-codex-hooks.json)
