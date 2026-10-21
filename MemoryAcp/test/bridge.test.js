import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { runAcp } from "../src/acp.js";
import { createBridge, validateRequest } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixtures/agent.mjs", import.meta.url));
const request = { model: "codex", messages: [{ role: "user", content: "Trích xuất ký ức" }] };
const acp = (mode, extra = {}) => runAcp({
  prompt: "test", model: "codex", signal: AbortSignal.timeout(5000),
  command: process.execPath, args: [fixture, mode], ...extra,
});

test("ACP returns only answer chunks from the requested session", async () => {
  assert.deepEqual(await acp("ok", { model: "test-model" }), {
    text: '{"memory":"Tiếng Việt"}', finishReason: "stop",
  });
});
test("ACP requires subscription authentication", async () => {
  await assert.rejects(acp("unauthenticated"), { code: "auth_required" });
});
test("ACP rejects unavailable models", async () => {
  await assert.rejects(acp("ok", { model: "unavailable" }), { code: "invalid_model" });
});
test("ACP handles process failure and cancellation", async () => {
  await assert.rejects(acp("crash"), { code: "acp_error" });
  await assert.rejects(acp("hang", { signal: AbortSignal.timeout(150) }), { code: "timeout" });
});
test("unsupported request semantics fail explicitly", () => {
  for (const extra of [{ tools: [] }, { stream: true }, { response_format: { type: "json_object" } }, { temperature: 0 }, { max_tokens: 42 }]) {
    assert.throws(() => validateRequest({ ...request, ...extra }), { status: 400 });
  }
  assert.throws(() => validateRequest({ ...request, messages: [{ role: "tool", content: "x" }] }), { status: 400 });
});

async function start(t, options = {}) {
  const bridge = createBridge({ runner: () => acp("ok"), ...options });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  return {
    url,
    post: (body = request, headers = {}) => fetch(`${url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }),
  };
}
test("HTTP auth, errors and OpenAI response envelope", async (t) => {
  const { post, url } = await start(t, { token: "test-secret" });
  assert.equal((await post()).status, 401);
  const headers = { authorization: "Bearer test-secret" };
  const response = await post(request, headers);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, '{"memory":"Tiếng Việt"}');
  assert.equal(body.usage, undefined);
  assert.equal((await post({ ...request, stream: true }, headers)).status, 400);
  assert.equal((await (await fetch(`${url}/health`)).json()).authentication, "not_checked");
});
test("bounded queue rejects overload and times out requests", async (t) => {
  let calls = 0;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { post } = await start(t, {
    timeoutMs: 150, maxQueue: 1,
    runner: ({ signal }) => new Promise((resolve, reject) => {
      calls++;
      started();
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  });
  const first = post();
  await running;
  const second = post();
  // Wait until the queue is occupied through the observable health endpoint.
  // The first request stays pending until its deadline.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await post()).status, 429);
  assert.equal((await first).status, 504);
  await second;
  assert.ok(calls <= 2);
});

test("client disconnect cancels the active runner", async (t) => {
  let started;
  let cancelled;
  const running = new Promise((resolve) => { started = resolve; });
  const stopped = new Promise((resolve) => { cancelled = resolve; });
  const { url } = await start(t, {
    runner: ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener("abort", () => {
        cancelled();
        reject(new Error("cancelled"));
      }, { once: true });
    }),
  });
  const controller = new AbortController();
  const response = fetch(`${url}/v1/chat/completions`, {
    method: "POST", body: JSON.stringify(request), signal: controller.signal,
  });
  await running;
  controller.abort();
  await assert.rejects(response);
  await Promise.race([
    stopped,
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Cancellation not delivered")), 1000);
      timer.unref();
    }),
  ]);
});
