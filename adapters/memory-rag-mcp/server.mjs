import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

for (const name of ['MEMORY_CORE_API_URL', 'KNOWLEDGE_API_URL', 'MCP_TEAM_ID', 'MCP_AGENT_ID', 'MCP_USER_ID']) {
  if (!process.env[name]) throw new Error(`${name} is required; configure this member's local MCP environment`);
}
for (const name of ['MEMORY_CORE_API_URL', 'KNOWLEDGE_API_URL']) {
  const url = new URL(process.env[name]);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) server root URL without credentials, a path, query, or fragment`);
  }
}
const scope = {
  team_id: process.env.MCP_TEAM_ID || 'default',
  agent_id: process.env.MCP_AGENT_ID || 'default',
  user_id: process.env.MCP_USER_ID || 'default',
};
const serviceId = process.env.MCP_SERVICE_ID || 'default';
if (!/^[A-Za-z0-9_-]+$/.test(serviceId)) throw new Error('Invalid MCP_SERVICE_ID');
const tools = [
  ['memory_search', 'Search atomic memories in the configured scope.', '/v3/atomic/search', z.object({ query: z.string().min(1).max(2048), limit: z.number().int().min(1).max(100).optional() }).strict()],
  ['memory_scenarios', 'List scenario files in the configured scope.', '/v3/scenario/ls', z.object({ path_prefix: z.string().optional() }).strict()],
  ['memory_read_scenario', 'Read a scenario file in the configured scope.', '/v3/scenario/read', z.object({ path: z.string().min(1) }).strict()],
  ['memory_read_profile', 'Read the core profile in the configured scope.', '/v3/core/read', z.object({}).strict()],
  ['knowledge_tools', 'Discover read-only tools for a Wiki or Code Graph resource.', '/v3/tools/list', z.object({ knowledge_id: z.string().regex(/^(wiki|cg)-[A-Za-z0-9_-]+$/) }).strict()],
  ['knowledge_query', 'Execute a discovered read-only knowledge tool. Use knowledge_tools first.', '/v3/tools/call', z.object({ knowledge_id: z.string().regex(/^(wiki|cg)-[A-Za-z0-9_-]+$/), tool_name: z.string().min(1), params: z.record(z.string(), z.unknown()) }).strict()],
];

function mcpServer() {
  const server = new Server({ name: 'team-memory-rag', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(([name, description, , schema]) => ({
    name, description, inputSchema: z.toJSONSchema(schema),
    annotations: { readOnlyHint: true, destructiveHint: false },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const tool = tools.find(([name]) => name === params.name);
      if (!tool) throw new Error('Unknown tool');
      const body = tool[3].parse(params.arguments || {});
      const knowledge = params.name.startsWith('knowledge_');
      const base = knowledge ? process.env.KNOWLEDGE_API_URL : process.env.MEMORY_CORE_API_URL;
      const headers = { 'Content-Type': 'application/json', 'x-tdai-service-id': serviceId };
      const key = knowledge ? process.env.KNOWLEDGE_API_TOKEN : process.env.MEMORY_CORE_API_TOKEN;
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await fetch(`${base.replace(/\/$/, '')}${tool[2]}`, {
        method: 'POST', headers, body: JSON.stringify(knowledge ? body : { ...body, ...scope }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw new Error(result.message || `API returned ${response.status}`);
      return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  });
  return server;
}

const server = mcpServer();
await server.connect(new StdioServerTransport());
// stdout is reserved for MCP protocol messages.
console.error(`Team RAG MCP connected via stdio (service=${serviceId})`);
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
