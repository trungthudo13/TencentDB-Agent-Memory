# Codex Asset Import

Import local  Codex **skills / sessions** into Memory Hub. This guide covers the complete process.


Data root: `$CODEX_HOME` (defaults to `~/.codex`).

## What is scanned

| Type | Path |
|---|---|
| Skill | USER `$HOME/.agents/skills/*/SKILL.md`; `.agents/skills` from the Git root to cwd; ADMIN `/etc/codex/skills` |
| Session | `$CODEX_HOME/sessions/**/*.jsonl`（`YYYY/MM/DD/rollout-*.jsonl`） |

Excluded: `~/.codex/skills`, repository root `skills/`, `plugins/cache`, and repository `memories/`.

`--sessions <dir>` overrides scanning for `.jsonl` and Responses `.json` files. Without `--sessions`, `$CODEX_HOME/sessions` is scanned automatically.

## Prerequisites

Run from the repository root. Requires Node >= 22 and the following:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... key of this agent owner>
# Optional: export CODEX_HOME=/path/to/.codex
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. Use `--source codex` to select the IDE covered by this guide; if omitted, `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: list skills (number/name/description/source/linked script count) and sessions (ID/time range/project path), then choose import all / none / selected (multiple numbers or IDs separated by commas or spaces).
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid>

# Noninteractive import (scripts/CI; import everything without prompting)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source codex --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Specify the historical session directory/file (override automatic scanning)
tsx agents/asset-import.ts --source codex --sessions /path/to/sessions --agent-id <id> --team-id <tid>

# Reimport (ignore resume checkpoints and import previously imported items again)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> --force

```



