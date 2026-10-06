# DeepSeek Harness Asset Import

Import local  dsh **skills / sessions** into Memory Hub. This guide covers the complete process.

Data root: `$DSH_HOME` (defaults to `~/.dsh`). The project root is the nearest ancestor containing `.git`; if none is found, use `--workspace` / cwd.

## What is scanned

**Skill** (for duplicate names, lower ranks take precedence; scan only one level, without recursive `**/SKILL.md` scanning)

| Rank | Path |
|---|---|
| 100 | `<project-root>/.dsh/skills/` |
| 200 | `<project-root>/.agents/skills/` |
| 300 | `customSkillDirs` in `settings.yaml`, or `DSH_CUSTOM_SKILL_DIRS` |
| 400 | `$DSH_HOME/skills/` (skip `.system`) |
| 500 | `~/.agents/skills/` (override the root with `DSH_AGENTS_HOME`) |
| 600 | `$DSH_BUNDLED_SKILL_DIR` / settings `bundledSkillDir` (skip if not configured) |

Either directory layout `<name>/SKILL.md` or flat layout `<name>.md`.

**Memory**: local files are no longer scanned; memory is extracted only from sessions (see below).

**Session**

Recursively scan `$DSH_HOME/sessions/**/session.jsonl.zstd` (or uncompressed `session.jsonl`). `--workspace` does not affect sessions; `--sessions` overrides the scan root. Parse only `user/message` + `assistant/message`; skip empty sessions.

## Prerequisites

Run from the repository root. Requires Node >= 22 and the following:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... key of this agent owner>
# Optional: DSH_HOME / DSH_AGENTS_HOME / DSH_CUSTOM_SKILL_DIRS / DSH_BUNDLED_SKILL_DIR
```

`--agent-id` / `--team-id` are required.

## Usage

The shared entry point is `agents/asset-import.ts` at the repository root. Use `--source dsh` to select the IDE covered by this guide; if omitted, `auto` detects the IDE used in the current workspace.

```bash
# Interactive import: list skills (number/name/description/source/linked script count) and sessions (ID/time range/project path), then choose import all / none / selected (multiple numbers or IDs separated by commas or spaces).
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid>

# Noninteractive import (scripts/CI; import everything without prompting)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source dsh --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Reimport (ignore resume checkpoints and import previously imported items again)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> --force

```


