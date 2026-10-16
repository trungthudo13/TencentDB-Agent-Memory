/**
 * L1.5 Task Judgment Prompt — determines task lifecycle.
 */
import type { MmdMeta } from "../types.js";

export const L15_SYSTEM_PROMPT = `You are a task-lifecycle gatekeeper for an AI coding assistant.
Cross-analyze the three provided input sources, determine task status precisely, and output only a JSON object.

[Required input analysis]
1. Analyze recentMessages (intent): extract the core request in the user's latest reply from current and historical conversation. Determine whether they want continued investigation, announce completion (such as "it works"), ask a one-turn question, or start a new request.
2. Align with currentMmd (baseline): compare the latest intent with the complete Mermaid content, especially taskGoal, node status (done/doing/todo), and summary. Set taskCompleted=true if the request is outside the current graph's scope or the goal is achieved (all nodes done with no follow-up). Set false if still solving its subproblems, including doing nodes or bug fixes. If currentMmd is absent, use current and historical conversation to judge continuation.
3. Search availableMmds (continuation): when starting a task (isLongTask=true and taskCompleted=true/no current task), scan taskGoal and timestamps in availableMmds. A request strongly overlapping a historical task (such as yesterday's unfinished module) is a continuation: isContinuation=true.

[Strict JSON output format]
Output a valid JSON object in this shape:
{
  "taskCompleted": boolean, // Whether the current task ended; must be true when currentMmd is none
  "isLongTask": boolean, // Whether the latest request requires complex, multistep work; false for ordinary technical questions or chat
  "isContinuation": boolean, // Whether a historical task in availableMmds is continuing
  "continuationMmdFile": "string|null", // Exact filename from availableMmds without a path prefix if continuing, otherwise null
  "newTaskLabel": "string|null" // Short label for a new long task (≤30 characters, kebab-case, such as "refactor-api"), otherwise null
}

Output only the JSON object, without explanatory text.`;

export interface L15CurrentMmd {
  filename: string;
  content: string;
}

/**
 * Build the L1.5 user prompt for task judgment.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent conversation context (Recent messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Active task graph (Active Mermaid — full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Historical task graphs (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no historical long tasks)");
  } else {
    for (const m of metas) {
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`- **${m.filename}**`);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      parts.push(
        `  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`,
      );
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push(
    "Follow the system instruction's three-step analysis strictly and output a valid JSON object.",
  );
  return parts.join("\n");
}
