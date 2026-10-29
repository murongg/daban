import assert from 'node:assert/strict';
import test from 'node:test';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { McpRemote } from './mcp.js';
import { tlsFixture } from './tls.fixture.js';

for (const sse of [false, true]) {
  test(`official MCP client supports a legacy ${sse ? 'SSE' : 'JSON'} endpoint without executing tools during discovery`, async () => {
    const methods: string[] = [];
    let writes = 0,
      dispatched = 0;
    const fixture = await tlsFixture(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      methods.push(message.method || req.method);
      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      let response: unknown;
      if (message.method === 'server/discover')
        response = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Synthetic legacy endpoint' },
        };
      else {
        if (message.method === 'tools/call') writes++;
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'synthetic-mcp', version: '1.0' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'synthetic_echo',
                      description: '返回合成内容',
                      inputSchema: {
                        type: 'object',
                        properties: { value: { type: 'string' } },
                        required: ['value'],
                      },
                    },
                  ],
                }
              : message.method === 'tools/call'
                ? {
                    content: [
                      { type: 'text', text: `SYNTHETIC:${message.params.arguments.value}` },
                    ],
                  }
                : {};
        response = { jsonrpc: '2.0', id: message.id, result };
      }
      if (sse && message.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    });
    const remote = new McpRemote(
      { endpoint: fixture.endpoint, bearer: 'synthetic-token' },
      {
        ...fixture,
        onDispatch: async () => {
          dispatched++;
        },
      },
    );
    try {
      const signal = new AbortController().signal;
      await remote.start(signal);
      const tools = await remote.tools(signal);
      assert.equal(tools[0].name, 'synthetic_echo');
      assert.equal(writes, 0);
      assert.equal(dispatched, 0);
      const result = await remote.call('synthetic_echo', { value: '47' }, signal);
      assert.deepEqual(result.content, [{ type: 'text', text: 'SYNTHETIC:47' }]);
      assert.equal(writes, 1);
      assert.equal(dispatched, 1);
      await assert.rejects(remote.call('synthetic_echo', { value: '47' }, signal));
      assert.equal(writes, 1);
      assert.ok(methods.includes('initialize') && methods.includes('tools/list'));
    } finally {
      await remote.close();
      await fixture.close();
    }
  });
}

for (const responseMode of ['json', 'sse'] as const) {
  test(`official current MCP ${responseMode} server interoperates with request metadata and no legacy session`, async () => {
    let writes = 0;
    let dispatched = 0;
    const versions: string[] = [];
    const failures: unknown[] = [];
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'synthetic-current-mcp', version: '1.0' });
        server.registerTool(
          'synthetic_echo',
          {
            description: '合成现代协议回声',
            inputSchema: fromJsonSchema<{ value: string }>({
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            }),
          },
          async (args) => {
            writes++;
            return { content: [{ type: 'text', text: `SYNTHETIC-CURRENT:${args.value}` }] };
          },
        );
        return server;
      },
      { legacy: 'reject', responseMode },
    );
    const handle = toNodeHandler(handler);
    const fixture = await tlsFixture((req, res) => {
      versions.push(String(req.headers['mcp-protocol-version'] ?? ''));
      return handle(req, res).catch((error) => {
        failures.push(error);
        res.destroy();
      });
    });
    const remote = new McpRemote(
      { endpoint: fixture.endpoint },
      {
        ...fixture,
        onDispatch: async () => {
          dispatched++;
        },
      },
    );
    try {
      const signal = new AbortController().signal;
      await remote.start(signal);
      assert.equal((await remote.tools(signal))[0].name, 'synthetic_echo');
      assert.equal(writes, 0);
      assert.equal(dispatched, 0);
      const result = await remote.call('synthetic_echo', { value: '47' }, signal);
      assert.deepEqual(result.content, [{ type: 'text', text: 'SYNTHETIC-CURRENT:47' }]);
      assert.equal(writes, 1);
      assert.equal(dispatched, 1);
      assert.ok(versions.includes('2026-07-28'));
      assert.deepEqual(failures, []);
    } finally {
      await remote.close();
      await fixture.close();
      await handler.close();
    }
  });
}
