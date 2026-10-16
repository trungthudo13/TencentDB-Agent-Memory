/**
 * Format recall results into prompt context.
 *
 * Output structure (mirrors original memory-tencentdb plugin):
 * - prependContext: dynamic L1 memories (changes per turn, injected before user message)
 * - appendSystemContext: stable content (Persona + Scene Nav + tools guide, appended to system prompt)
 */

import type { RecallResult } from "./hooks/recall.js";

interface L1Item {
  id: string;
  content: string;
  type: string;
  score?: number;
}

interface SceneEntry {
  path: string;
  created_at?: string;
  updated_at?: string;
}

// ── Memory Tools Guide ──
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## Memory tool usage guide

When the injected memory excerpts above are insufficient to answer the user, use these tools to obtain more information:

- **tdai_memory_search**: Search structured memories (L1) for user preferences, historical events, rules, and similar information.
- **tdai_conversation_search**: Search original conversations (L0) for exact messages, timelines, and context.
- **tdai_read_file**: Read memory file details using the complete relative path from Scene Navigation below, such as scene_blocks/xxx.md; persona.md is also supported.

### ⚠️ Call limit
Use tdai_memory_search and tdai_conversation_search **at most 3 times combined per conversation turn**.
- If the first search returns no results, retry with different keywords or the other tool without exceeding 3 total calls.
- If 3 searches return no results, the information is absent from memory. Answer using the information already available.
</memory-tools-guide>`;

/**
 * Format L1 memories as prependContext.
 */
function formatL1Memories(items: L1Item[]): string | undefined {
  if (items.length === 0) return undefined;

  const lines: string[] = [
    "<relevant-memories>",
    "",
  ];

  for (const item of items) {
    const typeTag = item.type ? `[${item.type}]` : "";
    lines.push(`- ${typeTag} ${item.content}`);
  }

  lines.push("");
  lines.push("</relevant-memories>");

  return lines.join("\n");
}

/**
 * Format stable system context: Persona + Scene Navigation + Tools Guide.
 */
function formatSystemContext(
  persona: string | null,
  scenes: SceneEntry[],
): string | undefined {
  const parts: string[] = [];

  // Persona (L3)
  if (persona) {
    parts.push("<user-persona>");
    parts.push(persona);
    parts.push("</user-persona>");
  }

  // Scene Navigation (L2 index) — only if not already in persona
  if (scenes.length > 0 && (!persona || !persona.includes("Scene Navigation"))) {
    parts.push("");
    parts.push("## 🗺️ Scene Navigation");
    parts.push("*Index of current scene memories. Use tdai_read_file to read details.*");
    parts.push("");
    for (const scene of scenes) {
      parts.push(`- \`${scene.path}\``);
    }
  }

  // Tools guide (always append)
  parts.push("");
  parts.push(MEMORY_TOOLS_GUIDE);

  const result = parts.join("\n").trim();
  return result || undefined;
}

/**
 * Main format function: produce RecallResult for prompt injection.
 */
export function formatRecallResult(
  l1Items: L1Item[],
  persona: string | null,
  scenes: SceneEntry[],
): RecallResult {
  return {
    prependContext: formatL1Memories(l1Items),
    appendSystemContext: formatSystemContext(persona, scenes),
  };
}
