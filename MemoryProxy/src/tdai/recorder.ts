import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";

/**
 * 从最后一条 user 消息中抽取「真正的用户提问」，写入 L0。
 *
 * 背景：CodeBuddy / Claude Code / DSH 等编码 agent 的 user 消息里除了真实问题，
 * 还塞了大量 harness 上下文（<additional_data>、current_time、<system_reminder>、
 * DSH 的 `Current runtime context.` 快照等）。如果把整条消息原样写进 L0，记忆
 * 会被这些噪声污染，而且每轮都不一样、检索价值极低。因此这里只保留真实提问。
 *
 * 抽取算法在 `common/user-query-extractor.ts` 内实现（tdai / mem-command /
 * codebuddy adapter 共用同一份，避免语义漂移）；本模块只负责"取最后一条
 * user message → 抽 query 文本 → 组装 TdaiMessage"这几步。
 */

// 保留 re-export，避免下游（含单测）import 路径变化引发一次性大改。
export { extractUserQueryText };

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    // History is replayed on every tool continuation. Never cross an
    // assistant/tool boundary and record an already consumed user turn again.
    if (msg?.role === "assistant" || msg?.role === "tool" || msg?.role === "function"
      || msg?.type === "function_call" || msg?.type === "function_call_output"
      || msg?.type === "reasoning") return null;
    if (msg?.role !== "user") continue;
    // 只取真实 user_query，避免把 harness 上下文写进 L0
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
    // Anthropic represents tool results as user-role content blocks.
    if (Array.isArray(msg.content) && msg.content.some(
      (part) => part?.type === "tool_result",
    )) return null;
  }
  return null;
}

export async function recordTdaiTurn(client: TdaiClient, identity: TdaiIdentity | null, userMessage: TdaiMessage | null, assistantContent: string | null | undefined): Promise<void> {
  if (!identity) return;
  const messages: TdaiMessage[] = userMessage ? [userMessage] : [];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  if (messages.length > 0) await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (!p || (p.type && p.type !== "text" && p.type !== "input_text")) return "";
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
