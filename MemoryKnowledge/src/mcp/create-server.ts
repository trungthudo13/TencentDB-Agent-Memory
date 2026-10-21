/** Transport-independent MCP tool registry shared by stdio and HTTP. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MCP_TOOLS, type McpToolDef } from "./tools.js";
import { callApi, isApiToolResult, type HttpClientOptions } from "./http-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-server");

export function createMcpServer(httpOpts: HttpClientOptions): Server {
  const toolMap = new Map<string, McpToolDef>();
  for (const tool of MCP_TOOLS) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "knowledge-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      log.warn(`Unknown tool requested: "${name}"`);
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const body = (args ?? {}) as Record<string, unknown>;
    try {
      const data = await callApi(httpOpts, tool.endpoint, body);

      // The code-graph query endpoints return {text, isError} — pass through directly
      if (isApiToolResult(data)) {
        const result = data;
        return {
          content: [{ type: "text", text: result.text || "(empty result)" }],
          isError: result.isError,
        };
      }

      // Other endpoints return structured data — serialize as JSON
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tool ${name} failed: ${msg}`);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

