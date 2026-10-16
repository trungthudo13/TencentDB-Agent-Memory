/**
 * mem:help — 返回支持的命令列表及示例
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## Supported mem: commands

| Command | Description |
|---------|-------------|
| \`mem:session-reset\` | Reset this session's Team/Agent/Task links and reopen selection |
| \`mem:sync\` | Refresh all asset injections (Skill / Memory / Knowledge / Task & Agent descriptions) |
| \`mem:create-skill [prompt]\` | Archive this conversation as a Skill for asynchronous background extraction |
| \`mem:create-task [title]\` | Create a Task from this conversation and link it to this session |
| \`mem:update-task [new description]\` | Update the linked Task's description |
| \`mem:help\` | Show this help |

---

### 🆕 \`mem:create-task\` — Create and link a Task

**Usage**
- **Without arguments**: The LLM infers a title and description from recent conversation.
- **With arguments**: The argument becomes the title (truncated to 40 characters); the LLM generates only the description.

**If this session already has a real Task**, a new Task preview is returned. Reply with one of:

| Reply | Result |
|-------|--------|
| \`mem:create-task confirm\` | ✅ Replace the link and create a new Task |
| \`mem:update-task\` or \`mem:update-task <new description>\` | ⭐ **Recommended** — Reuse the current Task and update only its description |
| \`mem:create-task cancel\` | 🚫 Cancel without changes |

---

### ✏️ \`mem:update-task\` — Update the current Task description

**Usage**
- **Without arguments**: The LLM compares the current description with recent conversation to generate a new description.
  - No meaningful changes → ℹ️ No update needed (idempotent; safe to retry).
  - Changes found → Return a preview.
- **With arguments**: Use the argument directly as the new description (without an LLM call) and return a preview.

**Confirm the preview**:
- ✅ \`mem:update-task confirm\` — Confirm
- 🚫 \`mem:update-task cancel\` — Cancel

**Safeguards**:
- No Task linked to this session → Ask you to run \`mem:create-task\` first.
- You did not create the linked Task → Reject the update (cross-user modification is unsupported); use \`mem:create-task\` to create your own.

---

### Examples

\`\`\`
mem:sync
mem:create-skill Summarize database migration steps and pitfalls
mem:create-task Refactor SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task Add today's progress and remaining risks
mem:update-task confirm
mem:update-task cancel
mem:session-reset
mem:help
\`\`\`

> Use \`mem:<command>\` with no space after the colon. Command names are case-insensitive.`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
