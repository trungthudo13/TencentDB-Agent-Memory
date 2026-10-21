import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpRoutes } from './http.js';
import { accessLog } from '../middleware/response-envelope.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

const serviceKey = 'test-service-secret';
const headers = {
  authorization: `Bearer ${serviceKey}`,
  'x-tdai-service-id': 'tenant-a',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const listRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

function fixture(options: { apiPrefix?: string; serviceKey?: string; allowedOrigins?: string[]; apiFetch?: (request: Request) => Response | Promise<Response> } = {}) {
  const calls: { path: string; tenant: string | null; auth: string | null; method: string; body: unknown }[] = [];
  const app = new Hono();
  // Match production: logging must leave the SDK-owned MCP body unread.
  app.use('*', accessLog({ skipBodyPaths: ['/mcp'] }));
  app.route('/mcp', createMcpHttpRoutes({
    serviceKey: options.serviceKey ?? serviceKey,
    allowedOrigins: options.allowedOrigins ?? ['https://agent.example'],
    apiPrefix: options.apiPrefix ?? '/v3',
    apiFetch: options.apiFetch ?? (async request => {
      const path = new URL(request.url).pathname;
      const tenant = request.headers.get('x-tdai-service-id');
      calls.push({ path, tenant, auth: request.headers.get('authorization'), method: request.method, body: await request.json() });
      const data = path.endsWith('/code-graph/search')
        ? { text: `symbols for ${tenant}`, isError: false }
        : { pages: [{ title: 'Authentication', tenant }] };
      return Response.json({ code: 0, message: 'ok', data });
    }),
  }));
  return { app, calls };
}

async function connect(app: Hono, tenant = 'tenant-a') {
  const requests: { method: string; status: number; rpcMethod?: string }[] = [];
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${serviceKey}`, 'x-tdai-service-id': tenant } },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const rpcMethod = request.method === 'POST' ? (await request.clone().json()).method : undefined;
      const response = await app.request(request);
      requests.push({ method: request.method, status: response.status, rpcMethod });
      return response;
    },
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, requests };
}

function post(app: Hono, overrides: Record<string, string | undefined> = {}, body = JSON.stringify(listRequest)) {
  const requestHeaders = new Headers(headers);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) requestHeaders.delete(key);
    else requestHeaders.set(key, value);
  }
  return app.request('/mcp', { method: 'POST', headers: requestHeaders, body });
}

describe('Streamable HTTP MCP', () => {
  it('initializes a real SDK client, acknowledges notification, and lists the twelve read tools', async () => {
    const { app, calls } = fixture();
    const { client, requests } = await connect(app);
    const result = await client.listTools();
    expect(result.tools.map(tool => tool.name).sort()).toEqual([
      'code_callees', 'code_callers', 'code_explore', 'code_files', 'code_impact', 'code_node', 'code_search', 'code_status',
      'wiki_graph', 'wiki_list', 'wiki_read', 'wiki_search',
    ]);
    expect(requests).toContainEqual({ method: 'POST', status: 200, rpcMethod: 'initialize' });
    expect(requests).toContainEqual({ method: 'POST', status: 202, rpcMethod: 'notifications/initialized' });
    expect(calls).toHaveLength(0);
  });

  it('bridges code and wiki calls using the configured prefix, tenant and bearer', async () => {
    const { app, calls } = fixture({ apiPrefix: '/custom/v9' });
    const { client } = await connect(app);
    const codeArgs = { code_graph_id: 'cg-test', query: 'auth' };
    expect(await client.callTool({ name: 'code_search', arguments: codeArgs })).toMatchObject({
      content: [{ type: 'text', text: 'symbols for tenant-a' }], isError: false,
    });
    const wikiArgs = { wiki_id: 'wiki-test', refs: ['authentication'] };
    const wiki = await client.callTool({ name: 'wiki_read', arguments: wikiArgs });
    expect(wiki.isError).toBe(false);
    expect(JSON.parse((wiki.content as { text: string }[])[0].text)).toEqual({ pages: [{ title: 'Authentication', tenant: 'tenant-a' }] });
    expect(calls).toEqual([
      { path: '/custom/v9/code-graph/search', tenant: 'tenant-a', auth: `Bearer ${serviceKey}`, method: 'POST', body: codeArgs },
      { path: '/custom/v9/wiki/page/read', tenant: 'tenant-a', auth: `Bearer ${serviceKey}`, method: 'POST', body: wikiArgs },
    ]);
  });

  it('keeps concurrent clients isolated by request tenant', async () => {
    const { app, calls } = fixture();
    const [{ client: a }, { client: b }] = await Promise.all([connect(app, 'tenant-a'), connect(app, 'tenant-b')]);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? b : a).callTool({
      name: 'code_search', arguments: { code_graph_id: `cg-${index}`, query: 'auth' },
    })));
    results.forEach((result, index) => expect(result.content).toEqual([{ type: 'text', text: `symbols for tenant-${index % 2 ? 'b' : 'a'}` }]));
    expect(calls).toHaveLength(12);
    for (const call of calls) expect(call.tenant).toBe(Number((call.body as { code_graph_id: string }).code_graph_id.split('-')[1]) % 2 ? 'tenant-b' : 'tenant-a');
  });

  it('returns unknown tools as tool errors without contacting the API', async () => {
    const { app, calls } = fixture();
    const { client } = await connect(app);
    expect(await client.callTool({ name: 'delete_everything', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('Unknown tool') }] });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { response: () => Response.json({ code: 403, message: 'access denied', data: null }, { status: 403 }), text: 'access denied' },
    { response: () => new Response('upstream unavailable', { status: 503 }), text: '503' },
    { response: () => Response.json({ code: 500, message: 'error', data: { text: 'graph not ready', isError: true } }, { status: 500 }), text: 'graph not ready' },
  ])('preserves upstream failures as MCP tool errors: $text', async ({ response, text }) => {
    const { app } = fixture({ apiFetch: response });
    const { client } = await connect(app);
    expect(await client.callTool({ name: 'code_status', arguments: { code_graph_id: 'cg-test' } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining(text) }] });
  });

  it.each([undefined, 'Bearer wrong', serviceKey])('rejects missing or invalid authorization: %s', async authorization => {
    const { app, calls } = fixture();
    expect((await post(app, { authorization })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, '../other', 'tenant/other', '..'])('rejects missing or malformed tenant: %s', async tenant => {
    const { app } = fixture();
    expect((await post(app, { 'x-tdai-service-id': tenant })).status).toBe(400);
  });

  it('rejects untrusted Origins and allows the explicit Origin and nonbrowser requests', async () => {
    const { app } = fixture();
    expect((await post(app, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await post(app, { origin: 'null' })).status).toBe(403);
    expect((await post(app, { origin: 'https://agent.example' })).status).toBe(200);
    expect((await post(app)).status).toBe(200);
  });

  it.each(['GET', 'DELETE'])('does not offer stateful %s endpoints', async method => {
    const { app } = fixture();
    const response = await app.request('/mcp', { method, headers });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });


  it('permits local no-key mode but still requires tenant and validates supplied Origins', async () => {
    const { app } = fixture({ serviceKey: '', allowedOrigins: [] });
    expect((await post(app, { authorization: undefined })).status).toBe(200);
    expect((await post(app, { authorization: undefined, 'x-tdai-service-id': undefined })).status).toBe(400);
    expect((await post(app, { authorization: undefined, origin: 'http://localhost' })).status).toBe(403);
    expect((await post(app, { authorization: undefined, origin: 'https://agent.example' })).status).toBe(403);
  });

  it('ignores malicious routing headers when forwarding tool calls', async () => {
    const forwarded: Request[] = [];
    const { app } = fixture({ apiFetch: request => {
      forwarded.push(request);
      return Response.json({ code: 0, message: 'ok', data: { text: 'safe', isError: false } });
    } });
    const response = await post(app, {
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    }, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'code_search', arguments: { code_graph_id: 'cg-test', query: 'auth' } } }));
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe('http://knowledge.internal/v3/code-graph/search');
    expect(forwarded[0].headers.get('authorization')).toBe(`Bearer ${serviceKey}`);
    expect(forwarded[0].headers.get('x-tdai-service-id')).toBe('tenant-a');
    expect(forwarded[0].headers.has('x-forwarded-host')).toBe(false);
  });

  it('requires credentials and tenant again on calls after a successful initialization', async () => {
    const { app, calls } = fixture();
    const { client } = await connect(app);
    await client.listTools();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'code_status', arguments: { code_graph_id: 'cg-test' } } });
    expect((await post(app, { authorization: undefined }, body)).status).toBe(401);
    expect((await post(app, { authorization: 'Bearer wrong' }, body)).status).toBe(401);
    expect((await post(app, { 'x-tdai-service-id': undefined }, body)).status).toBe(400);
    expect((await post(app, { 'x-tdai-service-id': '../other' }, body)).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await post(app, { 'x-tdai-service-id': 'tenant-b' }, body)).status).toBe(200);
    expect(calls[0].tenant).toBe('tenant-b');
  });


  it('retains SDK body limits with production access logging enabled', async () => {
    const { app, calls } = fixture();
    const oversizedBody = JSON.stringify({ ...listRequest, params: { padding: 'x'.repeat(4 * 1024 * 1024) } });
    const oversized = await post(app, {}, oversizedBody);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.message).toContain('Payload Too Large');
    const declaredOversize = await post(app, { 'content-length': String(4 * 1024 * 1024 + 1) });
    expect(declaredOversize.status).toBe(413);
    expect(calls).toHaveLength(0);
    // A rejected body must not damage handling of the next request.
    const { client } = await connect(app);
    expect((await client.listTools()).tools).toHaveLength(12);
  });

  it('rejects malformed JSON, invalid JSON-RPC, unsupported protocol and incompatible Accept', async () => {
    const { app } = fixture();
    expect((await post(app, {}, '{')).status).toBe(400);
    expect((await post(app, {}, JSON.stringify({ invalid: true }))).status).toBe(400);
    expect((await post(app, { 'mcp-protocol-version': '1900-01-01' })).status).toBe(400);
    expect((await post(app, { accept: 'application/json' })).status).toBe(406);
  });
});
