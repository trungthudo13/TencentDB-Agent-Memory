import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class BridgeError extends Error {
  constructor(message, status = 502, code = "acp_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A fresh process and workspace per job trade startup latency for isolation.
// Neither the caller's repository nor its tools are exposed to the ACP agent.
export async function runAcp({ prompt, model, signal, command, args = [] }) {
  const cwd = await mkdtemp(join(tmpdir(), "memory-acp-"));
  let child;
  let lines;
  let failure;
  let nextId = 0;
  let output = "";
  let sessionId;
  const pending = new Map();
  const fail = (error) => {
    failure ??= error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const abort = () => fail(new BridgeError("Request cancelled or timed out", 504, "timeout"));
  try {
    if (signal.aborted) throw new BridgeError("Request cancelled", 504, "timeout");
    // Do not give Codex the bridge bearer secret, database credentials,
    // API-key auth, or configuration from an enclosing agent.
    const inherited = new Set([
      "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL",
      "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    ]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key)));
    env.CODEX_HOME = process.env.MEMORY_ACP_CODEX_HOME ??
      fileURLToPath(new URL("../.codex", import.meta.url));
    await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
    env.NO_BROWSER = "1";
    env.INITIAL_AGENT_MODE = "read-only";
    env.CODEX_CONFIG = JSON.stringify({
      approval_policy: "never",
      sandbox_mode: "read-only",
      model_provider: "openai",
      web_search: "disabled",
      features: { shell_tool: false },
    });
    child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.closedPromise = closed;
    child.on("error", () => fail(new BridgeError("Cannot start ACP adapter")));
    child.on("exit", () => fail(new BridgeError("ACP adapter exited")));
    child.stdin.on("error", () => fail(new BridgeError("ACP transport closed")));
    // Drain diagnostics without logging prompts, credentials, or model output.
    child.stderr.resume();
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const call = (method, params) => {
      if (failure) return Promise.reject(failure);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    };
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error("Oversized message");
        const msg = JSON.parse(line);
        if (msg.method && msg.id !== undefined) {
          if (msg.method === "session/request_permission") {
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Client tools disabled" } });
          }
        } else if (msg.method === "session/update") {
          const update = msg.params?.update;
          if (msg.params?.sessionId === sessionId &&
              update?.sessionUpdate === "agent_message_chunk" &&
              update.content?.type === "text") {
            output += update.content.text;
            if (output.length > 2 * 1024 * 1024) fail(new BridgeError("ACP output too large"));
          }
        } else if (msg.id !== undefined) {
          const waiter = pending.get(msg.id);
          if (!waiter) return;
          pending.delete(msg.id);
          if (msg.error) {
            // Adapter messages can contain request contents; never relay them.
            waiter.reject(new BridgeError("ACP request failed; check adapter authentication and model availability"));
          } else waiter.resolve(msg.result);
        }
      } catch {
        fail(new BridgeError("Invalid ACP response"));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const init = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "memory-acp", version: "0.1.0" },
    });
    if (init.protocolVersion !== 1) throw new BridgeError("Unsupported ACP protocol version");
    const auth = await call("authentication/status", {});
    if (auth.type !== "chat-gpt") {
      throw new BridgeError("ChatGPT login required in the dedicated MemoryAcp Codex home", 503, "auth_required");
    }
    const session = await call("session/new", { cwd, mcpServers: [] });
    sessionId = session.sessionId;
    if (!sessionId) throw new BridgeError("Adapter did not create a session");
    // Select only advertised model IDs; do not silently substitute a model.
    if (model !== "codex") {
      const models = session.models?.availableModels ?? [];
      if (!models.some((entry) => entry.modelId === model)) {
        throw new BridgeError("Model not advertised by ACP adapter", 400, "invalid_model");
      }
      await call("session/set_model", { sessionId, modelId: model });
    }
    const result = await call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    if (failure) throw failure;
    if (!["end_turn", "max_tokens"].includes(result.stopReason)) {
      throw new BridgeError(`ACP turn stopped: ${result.stopReason ?? "unknown"}`);
    }
    if (!output.trim()) throw new BridgeError("ACP returned no answer");
    return { text: output, finishReason: result.stopReason === "max_tokens" ? "length" : "stop" };
  } finally {
    signal.removeEventListener("abort", abort);
    lines?.close();
    if (child?.pid) {
      // Stop the adapter and allow it to shut down its app-server child.
      child.stdin.end();
      const kill = (signal) => {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      };
      kill("SIGTERM");
      const killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      await child.closedPromise;
      clearTimeout(killTimer);
      kill("SIGKILL");
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
