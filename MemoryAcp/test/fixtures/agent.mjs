import { createInterface } from "node:readline";
const mode = process.argv[2];
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { protocolVersion: 1 } });
  else if (method === "authentication/status") send({ id, result: { type: mode === "unauthenticated" ? "unauthenticated" : "chat-gpt" } });
  else if (method === "session/new") send({ id, result: { sessionId: "test", models: { availableModels: [{ modelId: "test-model" }] } } });
  else if (method === "session/set_model") send({ id, result: {} });
  else if (method === "session/prompt") {
    if (mode === "hang") return;
    if (mode === "crash") process.exit(1);
    send({ method: "session/update", params: { sessionId: "test", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } } } });
    send({ method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong session" } } } });
    send({ method: "session/update", params: { sessionId: "test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"memory":"Tiếng Việt"}' } } } });
    send({ id, result: { stopReason: "end_turn" } });
  }
});
