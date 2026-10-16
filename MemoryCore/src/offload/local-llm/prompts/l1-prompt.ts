/**
 * L1 Summarization Prompt — migrated from context-offload-server.
 *
 * Converts tool call/result pairs into high-density JSON summaries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L1_SYSTEM_PROMPT = `You are a tool-result summarizer for an AI coding assistant. Understand the current conversation deeply and condense complex tool calls and results into a high-density JSON array, with one summary per tool-call/result pair.

Before summarizing, reason internally about:
1. Task alignment: identify the user's core goal and latest intent from recent conversation. If context conflicts, follow the latest user intent.
2. Value filtering: omit redundant implementation details and extract key discoveries, actions, specific changes, and exact errors.
3. Impact assessment: determine the result's material effect on the task, such as confirming a hypothesis, completing a step, making a decision, or blocking progress with an error.

[Output format]
Output only a valid JSON array of objects [{...}]. Every object MUST contain:
- "tool_call": a concise description of the tool call, following these rules:
  · If the pair is marked [NEEDS_COMPRESS], compress the tool name and key parameters into one description (≤150 characters). Preserve the tool name and target (such as file path or command intent); omit inline scripts and large payload details.
    Example: exec({"command":"python3 -c 'import csv; ...200 lines...'"}) → "exec: run Python script (xx/xx/xx.sh; specify exact path/file) to analyze sales_channels.csv data quality"
    Example: write_file({"path":"/root/app.py","content":"...5000 characters..."}) → "write_file: write /root/app.py (main Flask application file), containing..."
  · Without [NEEDS_COMPRESS], briefly describe the tool and parameters (the system will replace this with the original value).
- "summary": a concise synthesis (≤200 characters). State the result's practical value and how it advances or blocks the task.
- "tool_call_id": pass through the original tool_call_id unchanged.
- "timestamp": pass through the original China Standard Time (+08:00) ISO 8601 timestamp unchanged.
- "score" (REQUIRED): assess how well the summary can replace the original based on information density and task intent, from 0 to 10; higher means a better replacement.

[Strict rules]
Output only a JSON array, without reasoning or explanatory text.`;

// ─── Constants ───────────────────────────────────────────────────────────────

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L1ToolPair {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1 user prompt for summarization.
 * Mirrors context-offload-server/internal/service/prompt/BuildL1UserPrompt.
 */
export function buildL1UserPrompt(recentMessages: string, pairs: L1ToolPair[]): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (to understand the current task):");
  parts.push(recentMessages);
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
