import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('member-local stdio MCP retrieves read-only evidence with fixed scope', async () => {
  const calls = [];
  const api = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 0, data: { items: ['evidence'] } }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [new URL('./server.mjs', import.meta.url).pathname], stderr: 'pipe',
    env: { ...process.env, MCP_SERVICE_ID: 'instance-a', MCP_TEAM_ID: 'team-a', MCP_AGENT_ID: 'agent-a', MCP_USER_ID: 'member-a',
      MEMORY_CORE_API_URL: base, KNOWLEDGE_API_URL: base, MEMORY_CORE_API_TOKEN: 'core-token' },
  });
  const client = new Client({ name: 'test-member', version: '1' });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 6);
    assert.ok(list.tools.every(t => t.annotations.readOnlyHint));
    const result = await client.callTool({ name: 'memory_search', arguments: { query: 'deployment' } });
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(result.content[0].text), { items: ['evidence'] });
    assert.equal(calls[0].headers['x-tdai-service-id'], 'instance-a');
    assert.equal(calls[0].headers.authorization, 'Bearer core-token');
    assert.deepEqual(calls[0].body, { query: 'deployment', team_id: 'team-a', agent_id: 'agent-a', user_id: 'member-a' });
    const override = await client.callTool({ name: 'memory_search', arguments: { query: 'x', user_id: 'other-member' } });
    assert.equal(override.isError, true);
    assert.equal(calls.length, 1);
    await client.callTool({ name: 'knowledge_query', arguments: { knowledge_id: 'wiki-test', tool_name: 'search', params: { query: 'x' } } });
    assert.equal(calls[1].url, '/v3/tools/call');
    assert.equal(calls[1].headers['x-tdai-service-id'], 'instance-a');
    assert.equal(calls[1].body.user_id, undefined);
    const unknown = await client.callTool({ name: 'memory_delete', arguments: {} });
    assert.equal(unknown.isError, true);
  } finally {
    await client.close();
    await new Promise(resolve => api.close(resolve));
  }
});
