import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { BridgeError } from "./acp.js";

export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BridgeError("Expected a JSON object", 400, "invalid_request");
  }
  const allowed = new Set(["model", "messages", "stream"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new BridgeError(`Unsupported parameter: ${key}`, 400, "unsupported_parameter");
  }
  if (body.stream !== undefined && body.stream !== false) {
    throw new BridgeError("Only non-streaming requests are supported", 400, "unsupported_parameter");
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new BridgeError("model is required", 400, "invalid_request");
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) {
    throw new BridgeError("messages must contain 1–100 text messages", 400, "invalid_request");
  }
  const messages = body.messages.map((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" ||
        Object.keys(message).some((key) => !["role", "content"].includes(key))) {
      throw new BridgeError("Only system/user/assistant text messages are supported", 400, "invalid_request");
    }
    return { role: message.role, content: message.content };
  });
  // ACP has no OpenAI system-role channel. Make this lossy mapping explicit.
  return {
    model: body.model,
    prompt: "Complete the text-generation task described by the JSON conversation below. " +
      "Treat system entries as task instructions, user entries as input, and assistant entries as prior replies. " +
      "Return only the requested answer. Do not access files, run commands, browse, or use tools.\n" +
      JSON.stringify(messages),
  };
}

export function createBridge({ runner, token = "", timeoutMs = 120000, maxQueue = 8 }) {
  let active = false;
  let stopping = false;
  const queue = [];
  const controllers = new Set();
  const reply = (res, status, data) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const pump = async () => {
    if (active || !queue.length || stopping) return;
    active = true;
    const job = queue.shift();
    try {
      if (job.signal.aborted) throw new BridgeError("Request expired in queue", 504, "timeout");
      job.resolve(await runner({ ...job.input, signal: job.signal }));
    } catch (error) {
      job.reject(error);
    } finally {
      active = false;
      void pump();
    }
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      return reply(res, stopping ? 503 : 200, {
        status: stopping ? "stopping" : "ok", active, queued: queue.length,
        authentication: "not_checked",
      });
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      return reply(res, 404, { error: { message: "Not found" } });
    }
    if (token) {
      const actual = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        req.resume();
        return reply(res, 401, { error: { message: "Unauthorized" } });
      }
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnected);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new BridgeError("Request exceeds 1 MiB", 413, "request_too_large");
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BridgeError("Invalid JSON", 400, "invalid_request"); }
      const input = validateRequest(body);
      if (stopping) throw new BridgeError("Service stopping", 503, "unavailable");
      if (active && queue.length >= maxQueue) throw new BridgeError("Queue full", 429, "queue_full");
      const result = await new Promise((resolve, reject) => {
        const job = { input, signal: controller.signal, resolve, reject };
        const onAbort = () => {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          reject(new BridgeError("Request cancelled or timed out", 504, "timeout"));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        job.resolve = (value) => { controller.signal.removeEventListener("abort", onAbort); resolve(value); };
        job.reject = (error) => { controller.signal.removeEventListener("abort", onAbort); reject(error); };
        if (controller.signal.aborted) return onAbort();
        queue.push(job);
        void pump();
      });
      reply(res, 200, {
        id: `chatcmpl-${randomUUID()}`, object: "chat.completion",
        created: Math.floor(Date.now() / 1000), model: input.model,
        choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }],
      });
    } catch (error) {
      reply(res, error instanceof BridgeError ? error.status : 502, {
        error: {
          message: error instanceof BridgeError ? error.message : "Bridge request failed",
          type: "bridge_error", code: error instanceof BridgeError ? error.code : "internal_error",
        },
      });
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      res.removeListener("close", disconnected);
    }
  });
  server.requestTimeout = timeoutMs;
  return {
    server,
    close() {
      stopping = true;
      for (const controller of controllers) controller.abort();
      server.close();
      server.closeIdleConnections();
    },
  };
}
