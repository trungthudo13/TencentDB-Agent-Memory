import { fileURLToPath } from "node:url";
import { runAcp } from "./acp.js";
import { createBridge } from "./server.js";

const host = process.env.MEMORY_ACP_HOST ?? "127.0.0.1";
const token = process.env.MEMORY_ACP_TOKEN ?? "";
if (!["127.0.0.1", "::1", "localhost"].includes(host) && !token) {
  throw new Error("MEMORY_ACP_TOKEN is required when listening outside loopback");
}
const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
};
const command = fileURLToPath(new URL("../node_modules/.bin/codex-acp", import.meta.url));
const bridge = createBridge({
  token,
  timeoutMs: integer("MEMORY_ACP_TIMEOUT_MS", 120000),
  maxQueue: integer("MEMORY_ACP_MAX_QUEUE", 8),
  runner: (request) => runAcp({ ...request, command }),
});
bridge.server.listen(integer("MEMORY_ACP_PORT", 8097), host, () => {
  console.log("MemoryAcp listening; authentication is checked on the first generation");
});
process.on("SIGTERM", () => bridge.close());
process.on("SIGINT", () => bridge.close());
