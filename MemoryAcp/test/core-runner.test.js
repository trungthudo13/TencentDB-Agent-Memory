import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createAcpL1Runner } from "../../MemoryCore/src/adapters/standalone/acp-llm-runner.ts";
import { createBridge } from "../src/server.js";
import { runAcp } from "../src/acp.js";

test("MemoryCore L1 runner crosses HTTP and ACP and returns parseable JSON", async (t) => {
  const bridge = createBridge({
    token: "internal-test",
    runner: (request) => runAcp({
      ...request, command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/agent.mjs", import.meta.url)), "ok"],
    }),
  });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  t.after(() => bridge.close());
  const env = {
    TDAI_L1_ACP_BASE_URL: `http://127.0.0.1:${bridge.server.address().port}/v1`,
    TDAI_L1_ACP_TOKEN: "internal-test",
  };
  const runner = createAcpL1Runner(env);
  const output = await runner.run({
    taskId: "l1-extraction", prompt: "Tôi thích tiếng Việt.",
    systemPrompt: "Extract memory as JSON", maxTokens: 4096,
  });
  assert.deepEqual(JSON.parse(output), { memory: "Tiếng Việt" });
  await assert.rejects(runner.run({ taskId: "l1", prompt: "x", enableTools: true }), /does not support tools/);
  const badAuth = createAcpL1Runner({ ...env, TDAI_L1_ACP_TOKEN: "wrong" });
  await assert.rejects(badAuth.run({ taskId: "l1", prompt: "x" }), /HTTP 401/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.run({ taskId: "l1", prompt: "x", abortSignal: controller.signal }));
});

test("L1 override is opt-in and validates configuration", () => {
  assert.equal(createAcpL1Runner({}), undefined);
  assert.equal(createAcpL1Runner({ TDAI_L1_ACP_BASE_URL: "" }), undefined);
  assert.throws(() => createAcpL1Runner({ TDAI_L1_ACP_BASE_URL: "http://bridge/v1" }), /TOKEN/);
  assert.throws(() => createAcpL1Runner({
    TDAI_L1_ACP_BASE_URL: "file:///tmp", TDAI_L1_ACP_TOKEN: "test",
  }), /Invalid/);
});
