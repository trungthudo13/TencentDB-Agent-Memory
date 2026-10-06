# Hermes Asset Import

Import local  Hermes Agent **skills / sessions** into Memory Hub. This guide covers the complete process.


Data root: `$HERMES_HOME` (defaults to `~/.hermes`). Sessions are read from SQLite, requiring **Node >= 22** (`node:sqlite`).

## What is scanned

**Skill** (for duplicate names, global skills override repository bundled skills; subdirectories containing `SKILL.md` may use deeper categories such as `mlops/inference/llama-cpp`)

| Priority | Path |
|---|---|
| 1 | `$HERMES_HOME/skills/<category>/<name>/SKILL.md` |
| 2 | `<hermes-agent-repository>/skills/` |
| 3 | `<hermes-agent-repository>/optional-skills/` |

Repository root: `HERMES_AGENT_ROOT`, otherwise `$HERMES_HOME/hermes-agent`. `HERMES_BUNDLED_SKILLS` / `HERMES_OPTIONAL_SKILLS` are also recognized.

Excluded: project `.hermes/skills` / `.agents/skills`, `skills.external_dirs`, `.hub`, pending, and `SKILL.md` nested inside `references/`.

**Memory**: local files are no longer scanned; memory is extracted only from sessions (see below).

**Session**

| Storage | Path | Imported? |
|---|---|---|
| Main database | `$HERMES_HOME/state.db` | Yes: `sessions` metadata + `user`/`assistant` entries in `messages` |
| Raw dumps | `$HERMES_HOME/sessions/request_dump_*.json` | No |

Exclude `session_{sid}.json` and `moa-traces/`. `--workspace` does not restrict sessions. Session scanning is skipped below Node 22.

## Prerequisites

Run from the repository root:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... key of this agent owner>
# Optional: HERMES_HOME / HERMES_AGENT_ROOT
```

`--agent-id` / `--team-id` are required. If skills are in repository `optional-skills/`, point `--workspace` to the hermes-agent repository root or set `HERMES_AGENT_ROOT`.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. Use `--source hermes` to select the IDE covered by this guide; if omitted, `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: list skills (number/name/description/source/linked script count) and sessions (ID/time range/project path), then choose import all / none / selected (multiple numbers or IDs separated by commas or spaces).
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid>

# Noninteractive import (scripts/CI; import everything without prompting)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source hermes --workspace /path/to/hermes-agent --agent-id <id> --team-id <tid>

# Reimport (ignore resume checkpoints and import previously imported items again)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> --force

```


