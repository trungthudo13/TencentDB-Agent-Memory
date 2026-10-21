/** MCP stdio entry point. HTTP uses the shared factory directly. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "../logger.js";
import { createMcpServer } from "./create-server.js";
export { createMcpServer } from "./create-server.js";

const log = createLogger("mcp-server");

export async function startMcpServer(): Promise<void> {
  const baseUrl = process.env.KNOWLEDGE_API_URL || "http://localhost:8421";
  const token = process.env.KNOWLEDGE_API_TOKEN;

  log.info(`MCP server starting, API URL: ${baseUrl}`);

  const serviceId = process.env.KNOWLEDGE_SERVICE_ID || "default";
  const apiPrefix = process.env.KNOWLEDGE_API_PREFIX || "/v3";
  const server = createMcpServer({ baseUrl, token, serviceId, apiPrefix });
  const transport = new StdioServerTransport();

  await server.connect(transport);
  log.info("MCP server connected via stdio");
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  void startMcpServer().catch((err) => {
    log.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
