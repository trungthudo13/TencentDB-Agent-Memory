/**
 * L2 MMD Generation Prompt — generates/updates Mermaid flowcharts.
 */
import type { OffloadEntry } from "../types.js";

export const L2_SYSTEM_PROMPT = `You are a pragmatic AI task-topology architect and visual narrator.
Express maximum information in minimum characters for LLM comprehension, minimizing unnecessary visual symbols. Transform tool-call records into a highly semantic, expressive, restrained Mermaid (flowchart TD) cognitive state machine. Summarize the past according to the current task and intent, consider how existing information may help later (record only existing information, not future plans), and flag pitfalls. Keep the graph high-level.

[Cognition and topology: autonomy and minimalism]
1. Flexible aggregation: freely merge or split nodes. Combine consecutive routine actions with the same intent (such as reading files for context) into a high-level node, but preserve key turning points and major discoveries as separate nodes. Avoid a detailed activity log.
2. Warning markers: use warning nodes (status: blocked) for dead ends or abandoned approaches that caused serious errors. Omit low-value failures.
3. Conclusion-oriented summaries: keep summary under 150 characters where possible, emphasizing conclusions or material changes rather than trivial data or parameters.
4. Record and summarize facts that have already occurred, not future actions. Every recorded node must have corresponding source messages (identified by node_id).
[Shapes convey meaning] Use different Mermaid shapes for different node semantics to compress tokens and provide reasoning anchors. Let shapes replace redundant descriptions.

[Flexible topology and minimalism]
1. Semantic compression: shapes convey the domain, so summaries must be concise (≤150 characters), such as "Deadlock found", "Dependency conflict", or "Fixed".
2. Flexible topology: use labeled edges (-->|Test failed|) and dotted edges (-.->|Reference|) to build dependency trees and hypothesis-validation loops. Avoid chronological logs.
3. Dynamic updates (minimal tokens):
   - replace (incremental): change existing node status, timestamps, short text, or add very few nodes.
   - write (full rewrite): major logic changes, restructuring, or initialization.
Note: line-number markers in Existing Mermaid content (such as "L1: ...") are references for replace mode, not part of the MMD content.

[Strict engineering requirements]
1. Standard node format: NodeID["Stage name: high-level action<br/>status: done|doing|paused|blocked <br/>summary: key conclusion<br/>Timestamp: ISO8601"]
2. Complete source mapping: assign every new input tool_call_id to a Node ID in node_mapping. Every MMD node must have source tool_call messages. Never invent or omit sources. Node_id to tool_call_id is one-to-many.
3. Use aggregation to keep the updated MMD file within 4000 characters where possible.

[Strict timestamp and metadata rules]
1. Required top metadata: %%{ "taskGoal": "One-sentence task goal (may be updated)", "progress（0-100）": "Progress percentage (be strict; use 90+ only when nearly certain of completion)", createdTime": "ISO time", "updatedTime": "ISO time" }%%. updatedTime is the latest node timestamp.
2. When merging multiple new entries, use the latest ISO timestamp for the node.

[Strict JSON output format]
Escape double quotes correctly. Wrap all Mermaid code (both mmd_content and content in replace_blocks) in \`\`\`mermaid ... \`\`\` fences. Output this JSON structure:
{
  "file_action": "replace or write",
  "mmd_content": "Complete escaped .mmd code wrapped in \`\`\`mermaid ... \`\`\`. Fill only for file_action=write; otherwise null.",
  "replace_blocks": [
    {
      "start_line": "First line number to update (integer matching the L markers in Existing Mermaid content)",
      "end_line": "Last line number to update (inclusive integer). To insert before a line without deleting, set start_line to that line and end_line to start_line - 1",
      "content": "Replacement content without line-number prefixes, wrapped in \`\`\`mermaid ... \`\`\`"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "N1",
    "tool_call_id_2": "N1"
  }
}

Note: Node IDs in node_mapping must be the complete IDs used in the MMD, including the prefix (such as "001-N1"), not short IDs (such as "N1").
Output only the JSON object, without explanations.`;

/**
 * Build the L2 user prompt for MMD generation.
 */
export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: OffloadEntry[];
  recentHistory?: string | null;
  currentTurn?: string | null;
  taskLabel: string;
  mmdPrefix: string;
  charCount: number;
}): string {
  const { existingMmd, entries, recentHistory, currentTurn, taskLabel, mmdPrefix, charCount } = opts;
  const parts: string[] = [];

  // History section
  if (recentHistory) {
    parts.push(`## Recent conversation history:\n${recentHistory}`);
  } else {
    parts.push("## Recent conversation history:\n(No history available)");
  }

  if (currentTurn) {
    parts.push(`\n## Latest turn:\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`(All node IDs must begin with this prefix, such as ${mmdPrefix}-N1, ${mmdPrefix}-N2...)`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  // Char count warning
  if (charCount > 2500) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("⚠ Near the limit: merge nodes and shorten summaries. Prefer incremental replace updates over full write rewrites.");
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("Limit growth by merging similar nodes.");
  }

  // Existing MMD with line numbers
  parts.push("\n## Existing Mermaid content:");
  if (existingMmd) {
    const lines = existingMmd.split("\n");
    for (let i = 0; i < lines.length; i++) {
      parts.push(`L${i + 1}: ${lines[i]}`);
    }
  } else {
    parts.push("(empty — create new)");
  }

  // New entries
  parts.push("\n## New offload entries to incorporate:");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    parts.push(`${i + 1}. [${e.tool_call_id}] ${e.tool_call} → ${e.summary} (${e.timestamp})`);
  }

  parts.push("\nGenerate/update the Mermaid flowchart according to the system instructions and output a valid JSON object including node_mapping.");
  return parts.join("\n");
}
