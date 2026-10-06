# WorkBuddy Asset Import

Import local  WorkBuddy **skills / sessions** into Memory Hub. This guide covers the complete process.

The desktop data directory defaults to `~/.workbuddy`.

## What is scanned

| Type | Path |
|---|---|
| Skill | `~/.workbuddy/skills/*/SKILL.md`; project `.workbuddy/skills` or `workbuddy/skills` |
| Session | Project JSONL files containing OpenAI style messages |

`--workspace` changes project paths to that directory (global `~/.workbuddy` paths are still included).

## Prerequisites

Run from the repository root. Requires Node >= 22 and the following:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... key of this agent owner>
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. Use `--source workbuddy` to select the IDE covered by this guide; if omitted, `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: list skills (number/name/description/source/linked script count) and sessions (ID/time range/project path), then choose import all / none / selected (multiple numbers or IDs separated by commas or spaces).
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid>

# Noninteractive import (scripts/CI; import everything without prompting)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source workbuddy --workspace /path/to/project --agent-id <id> --team-id <tid>

# Reimport (ignore resume checkpoints and import previously imported items again)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> --force

```


