/** Stateless MCP Streamable HTTP adapter, embedded in the knowledge API. */
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { extractServiceId, SERVICE_ID_HEADER } from "../api-helpers.js";
import { verifyBearer } from "../middleware/auth.js";
import { createMcpServer } from "./create-server.js";

export interface McpHttpOptions {
  serviceKey: string;
  allowedOrigins: string[];
  apiPrefix: string;
  apiFetch: (request: Request) => Response | Promise<Response>;
}

/** Mount at /mcp. Each POST has independent credentials, server and transport. */
export function createMcpHttpRoutes(options: McpHttpOptions): Hono {
  const app = new Hono();
  const allowedOrigins = new Set(options.allowedOrigins);

  app.all("/", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Origin not allowed" } }, 403);
    }
    if (options.serviceKey && !verifyBearer(c.req.header("authorization"), options.serviceKey)) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized: valid service key required" } }, 401);
    }
    // No standalone SSE subscription or persistent sessions in stateless mode.
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } }, 405);
    }
    const serviceId = extractServiceId(c.req.header(SERVICE_ID_HEADER));
    if (serviceId === null) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Valid ${SERVICE_ID_HEADER} header required` } }, 400);
    }

    // Fixed internal URL and injected app.fetch prevent Host/forwarded headers
    // from directing tool execution to an attacker-controlled upstream.
    const server = createMcpServer({
      baseUrl: "http://knowledge.internal",
      apiPrefix: options.apiPrefix,
      serviceId,
      token: options.serviceKey || undefined,
      fetch: options.apiFetch,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // JSON mode resolves after the complete response has been assembled, so
      // closing here cannot truncate an active SSE response.
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}
