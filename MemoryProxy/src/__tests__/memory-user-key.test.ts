import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metadataClient = vi.hoisted(() => vi.fn(() => ({})));
const initSession = vi.hoisted(() => vi.fn());
vi.mock("../instance-upstream-cache.js", async (original) => ({
  ...await original<typeof import("../instance-upstream-cache.js")>(),
  getInstanceUpstreamConfigs: async () => [],
}));
vi.mock("../meta/client.js", async (original) => ({
  ...await original<typeof import("../meta/client.js")>(),
  getMetadataClient: metadataClient,
}));
vi.mock("../session/index.js", async (original) => ({
  ...await original<typeof import("../session/index.js")>(),
  getSessionStore: () => ({ getOrRecover: async () => undefined, bind: () => {} }),
  handleSessionInit: initSession,
}));
vi.mock("../tdai/capabilities.js", () => ({
  fetchAssetCapabilities: async () => ({ chat_memory: true }),
}));

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConfig, DEFAULT_CONFIG } from "../config.js";
import { initAuth, resolveMemoryUserKey } from "../auth.js";
import { createApp } from "../server.js";

const protocols = ["codex", "claude-code"] as const;
const token = "dummy-model-token";
const memoryKey = "dummy-memory-key";
const session = { team_id: "team-test", agent_id: "agent-test", user_id: "user-test", session_id: "session-test", space_id: "default" };

function setup(agent: typeof protocols[number], valid = true, sessions = false) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = "http://upstream.test/v1";
  config.auth = { enabled: true, url: "http://memory.test", timeoutMs: 1000, serviceToken: "dummy-gateway-key" };
  config.sessionInit.enabled = sessions;
  config.ccRequestRouting.enabled = false;
  config.creditReport.url = "";
  config.extraction.extractors = ["tdai-memory"];
  config.tdai.enabled = sessions;
  config.tdai.endpoint = "http://memory.test";
  config.tdai.apiKey = "dummy-gateway-key";
  config.tdai.memory.enabled = sessions;
  config.tdai.memory.writeL0 = sessions;
  initAuth(config.auth);
  initSession.mockResolvedValue({intercepted:false, sessionInfo:{...session}});
  const calls: Array<{url:string; headers:Headers; body:any}> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const url = String(input);
    calls.push({url,headers:new Headers(options?.headers),body:options?.body ? await new Response(options.body).json() : null});
    if (url.endsWith("/auth/verify")) {
      return Response.json({code:0,data:valid ? {valid:true,user:{user_id:"user-test"}} : {valid:false}});
    }
    if (url.endsWith("/conversation/add")) return Response.json({code:0,data:{}});
    if (agent === "codex") {
      return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"answer"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {headers:{"content-type":"text/event-stream"}});
    }
    return Response.json({id:"msg-test",type:"message",role:"assistant",model:"test",content:[{type:"text",text:"answer"}],stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:1}});
  });
  const app = createApp(config);
  const request = (key: string | null = memoryKey, suffix?: string) => app.request(
    `http://localhost/${agent}/default/v1/${suffix ?? (agent === "codex" ? "responses" : "messages")}`,
    {method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`,"chatgpt-account-id":"account-test","anthropic-beta":"oauth-test","session-id":"session-test","x-claude-code-session-id":"session-test",...(key === null ? {} : {"x-tdai-user-key":key})},
      body:JSON.stringify(agent === "codex"
        ? {model:"test",stream:true,input:[{type:"message",role:"user",content:[{type:"input_text",text:"question"}]}]}
        : {model:"test",max_tokens:32,stream:false,messages:[{role:"user",content:"question"}]})},
  );
  return {calls,request,app};
}

beforeEach(() => { metadataClient.mockClear(); initSession.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); initAuth({enabled:false,url:"",timeoutMs:1000}); });

describe.each(protocols)("%s Memory identity", (agent) => {
  it("uses the Memory key for Core and preserves model authentication", async () => {
    const {calls,request} = setup(agent);
    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    const auth = calls.find(c => c.url.endsWith("/auth/verify"))!;
    expect(auth.body).toEqual({user_key:memoryKey});
    expect(auth.headers.get("authorization")).toBe("Bearer dummy-gateway-key");
    const upstream = calls.find(c => c.url.startsWith("http://upstream.test"))!;
    expect(upstream.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(upstream.headers.has("x-tdai-user-key")).toBe(false);
    expect(upstream.headers.get("anthropic-beta")).toBe("oauth-test");
    expect(upstream.headers.get("chatgpt-account-id")).toBe("account-test");
  });

  it("supports legacy credentials when the Memory header is absent", async () => {
    const {calls,request} = setup(agent);
    const response = await request(null);
    expect(response.status).toBe(200);
    await response.text();
    expect(calls[0].body).toEqual({user_key:token});
  });

  it("rejects an invalid Memory key without calling the model", async () => {
    const {calls,request} = setup(agent,false);
    expect((await request("bad-memory-key")).status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.user_key).toBe("bad-memory-key");
  });

  it("does not fall back to the model token for an explicitly empty Memory key", async () => {
    const {calls,request} = setup(agent);
    expect((await request("")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("passes the Memory identity into session initialization and L0 writes", async () => {
    const {calls,request} = setup(agent,true,true);
    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    expect(metadataClient).toHaveBeenCalledWith(expect.anything(),"default",memoryKey);
    expect(initSession.mock.calls[0][8]).toBe(memoryKey);
    await vi.waitFor(() => {
      const write = calls.find(c => c.url.endsWith("/conversation/add"));
      expect(write?.body).toMatchObject({team_id:session.team_id,agent_id:session.agent_id,user_id:session.user_id,session_id:session.session_id,messages:[{role:"user",content:"question"},{role:"assistant",content:"answer"}]});
    });
  });
});

it("keeps legacy clients working when no separate Memory header exists", () => {
  expect(resolveMemoryUserKey(undefined, token)).toBe(token);
});

it("uses the separate key for Claude auxiliary requests too", async () => {
  const {calls,request} = setup("claude-code");
  expect((await request(memoryKey,"messages/count_tokens")).status).toBe(200);
  expect(calls[0].body).toEqual({user_key:memoryKey});
  expect(calls.at(-1)?.headers.has("x-tdai-user-key")).toBe(false);
});

it("strips Memory credentials even on the direct route", async () => {
  const {calls,app} = setup("claude-code");
  await app.request("http://localhost/direct/v1/messages",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`,"x-tdai-user-key":memoryKey},body:JSON.stringify({model:"test",messages:[],stream:false})});
  expect(calls.at(-1)?.headers.has("x-tdai-user-key")).toBe(false);
  expect(calls.at(-1)?.headers.get("authorization")).toBe(`Bearer ${token}`);
});

it("loads the internal credential from environment placeholders without changing the model key", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-auth-config-"));
  vi.stubEnv("TEST_MEMORY_GATEWAY_KEY", "dummy-internal-key");
  try {
    const configFile = join(dir, "config.yaml");
    writeFileSync(configFile, JSON.stringify({
      auth: { serviceToken: "${TEST_MEMORY_GATEWAY_KEY}" },
      tdai: { apiKey: "${TEST_MEMORY_GATEWAY_KEY}" },
      skill: { serviceToken: "${TEST_MEMORY_GATEWAY_KEY}" },
      knowledge: { serviceToken: "${TEST_MEMORY_GATEWAY_KEY}" },
    }));
    const config = buildConfig({ configFile });
    expect(config.auth.serviceToken).toBe("dummy-internal-key");
    expect(config.tdai.apiKey).toBe("dummy-internal-key");
    expect(config.coreSkill.serviceToken).toBe("dummy-internal-key");
    expect(config.knowledge.serviceToken).toBe("dummy-internal-key");
    expect(config.upstream.apiKey).toBe("");
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
