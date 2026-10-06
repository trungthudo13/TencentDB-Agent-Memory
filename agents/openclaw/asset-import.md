# OpenClaw Asset Import

Import local OpenClaw **skills / sessions** into Memory Hub. This guide covers the complete process.


Scan the native client data, rather than this project's `~/.openclaw/context-offload/*`.

## What is scanned

**Skill** (for duplicate names, user custom skills override system bundled skills)

| Priority | Path |
|---|---|
| 1 | `~/.agents/skills/<name>/SKILL.md` |
| 2 | `~/npm-global/lib/node_modules/openclaw/skills/<name>/SKILL.md` |

May include `scripts/`, `references/`, `assets/`, and `agents/`. Exclude workspace / `~/.openclaw/skills` / extraDirs.

**Memory**: local files are no longer scanned; memory is extracted only from sessions (see below).

**Session** (`$OPENCLAW_STATE_DIR/agents/<id>/sessions/`; the state directory defaults to `~/.openclaw`)

Import `<sessionId>.jsonl` files one level below. Exclude `sessions.json`, `*.trajectory.jsonl`, `*.lock`, and SQLite.

## Prerequisites

Run from the repository root. Requires Node >= 22 and the following:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... key of this agent owner>
# Optional: OPENCLAW_STATE_DIR / OPENCLAW_WORKSPACE_DIR
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. Use `--source openclaw` to select the IDE covered by this guide; if omitted, `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: list skills (number/name/description/source/linked script count) and sessions (ID/time range/project path), then choose import all / none / selected (multiple numbers or IDs separated by commas or spaces).
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid>

# Noninteractive import (scripts/CI; import everything without prompting)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source openclaw --workspace /path/to/workspace --agent-id <id> --team-id <tid>

# Reimport (ignore resume checkpoints and import previously imported items again)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> --force

```


