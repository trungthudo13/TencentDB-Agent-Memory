import { describe, expect, it, vi } from "vitest";
import { extractLatestUserMessage, recordTdaiTurn } from "../tdai/recorder.js";
import type { TdaiClient } from "../tdai/client.js";

const identity = { teamId: "team", userId: "user", agentId: "agent", sessionId: "session" };
const question = { role: "user" as const, content: "adapters/ sử dụng làm gì?" };

describe("L0 user turn boundaries", () => {
  it.each([
    [{ role: "assistant", content: "Checking", tool_calls: [{}] }, { role: "tool", content: "files" }],
    [{ role: "assistant", content: [{ type: "tool_use", id: "1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "files" }] }],
    [{ type: "function_call", name: "exec" }, { type: "function_call_output", output: "files" }],
    [{ type: "reasoning", encrypted_content: "opaque" }],
    [{ role: "assistant", content: "Checking" }],
  ])("does not replay a user message during continuation %#", (...continuation) => {
    expect(extractLatestUserMessage([question, ...continuation])).toBeNull();
    // An intentionally repeated question remains a real new user turn.
    expect(extractLatestUserMessage([question, ...continuation, question])).toEqual(question);
  });

  it("records a Codex question once across commentary, tool calls and final response", async () => {
    const addConversation = vi.fn().mockResolvedValue(undefined);
    const client = { addConversation } as unknown as TdaiClient;
    const input: unknown[] = [{ type: "message", role: "user",
      content: [{ type: "input_text", text: question.content }] }];
    await recordTdaiTurn(client, identity, extractLatestUserMessage(input), "Checking");
    input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
      { type: "function_call", name: "exec" }, { type: "function_call_output", output: "files" });
    await recordTdaiTurn(client, identity, extractLatestUserMessage(input), null);
    await recordTdaiTurn(client, identity, extractLatestUserMessage(input), "Final answer");
    expect(addConversation.mock.calls.map((call) => call[1])).toEqual([
      [question, { role: "assistant", content: "Checking" }],
      [{ role: "assistant", content: "Final answer" }],
    ]);
  });

  it("skips trailing context but keeps new input before it", () => {
    expect(extractLatestUserMessage([question,
      { role: "user", content: "<tdai_recalled_l1_memories>context</tdai_recalled_l1_memories>" },
    ])).toEqual(question);
  });

  it("retains human text alongside Anthropic tool results", () => {
    expect(extractLatestUserMessage([question, { role: "assistant", content: "Checking" },
      { role: "user", content: [{ type: "tool_result", content: "tool output" },
        { type: "text", text: "Also check tests" }] },
    ])).toEqual({ role: "user", content: "Also check tests" });
  });

  it("does not write empty continuations or unbound sessions", async () => {
    const addConversation = vi.fn();
    const client = { addConversation } as unknown as TdaiClient;
    await recordTdaiTurn(client, identity, null, "  ");
    await recordTdaiTurn(client, null, question, "answer");
    expect(addConversation).not.toHaveBeenCalled();
  });
});
