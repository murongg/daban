import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { McpFetch } from './mcp-fetch.js';
import { tlsFixture } from './tls.fixture.js';

test('MCP HTTP uses the exact endpoint, validated public IP and verified TLS name while keeping authorization on that request', async () => {
  let calls = 0;
  const fixture = await tlsFixture((req, res) => {
    calls++;
    assert.equal(req.url, '/mcp?key=synthetic-url-secret');
    assert.equal(req.headers.authorization, 'Bearer synthetic-header-secret');
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const pins: string[] = [];
  const request = new McpFetch(fixture.endpoint, {
    ...fixture,
    dial: async (address, port, signal) => {
      pins.push(address);
      return fixture.dial(address, port, signal);
    },
  });
  try {
    const response = await request.fetch(fixture.endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-header-secret' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(pins, ['8.8.8.8']);
    await assert.rejects(
      request.fetch(fixture.endpoint.replace('/mcp?', '/foreign?'), { method: 'POST' }),
      { code: 'MCP_NETWORK_BLOCKED' },
    );
    assert.equal(calls, 1);
    const mixed = new McpFetch(fixture.endpoint, {
      ...fixture,
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await assert.rejects(mixed.fetch(fixture.endpoint, { method: 'POST' }), {
      code: 'MCP_NETWORK_BLOCKED',
    });
    const untrusted = new McpFetch(fixture.endpoint, {
      resolve: fixture.resolve,
      dial: fixture.dial,
    });
    await assert.rejects(untrusted.fetch(fixture.endpoint, { method: 'POST' }));
    assert.equal(
      calls,
      1,
      'a self-signed test endpoint must fail without its explicit synthetic CA',
    );
  } finally {
    await fixture.close();
  }
});

test('MCP fetch refuses redirects, bounded decompression and cancelled reads without forwarding secrets elsewhere', async () => {
  let mode = 'redirect';
  const fixture = await tlsFixture((_req, res) => {
    if (mode === 'redirect') {
      res.writeHead(307, { location: 'https://other.example.test/mcp' });
      res.end();
    } else if (mode === 'large') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync('x'.repeat(2048)));
    }
  });
  try {
    const request = new McpFetch(fixture.endpoint, { ...fixture, maxBytes: 1024 });
    await assert.rejects(request.fetch(fixture.endpoint, { method: 'POST' }), {
      code: 'MCP_REDIRECT_REFUSED',
    });
    mode = 'large';
    await assert.rejects(request.fetch(fixture.endpoint, { method: 'POST' }), {
      code: 'MCP_RESPONSE_TOO_LARGE',
    });
    mode = 'hang';
    const abort = new AbortController();
    const pending = request.fetch(fixture.endpoint, { method: 'POST', signal: abort.signal });
    abort.abort();
    await assert.rejects(pending);
  } finally {
    await fixture.close();
  }
});

test('one approved MCP invocation can physically dispatch tools/call only once, including SDK retries with a new id', async () => {
  let calls = 0,
    claims = 0;
  const fixture = await tlsFixture((_req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  try {
    const request = new McpFetch(fixture.endpoint, {
      ...fixture,
      onDispatch: async () => {
        claims++;
      },
    });
    const body = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'synthetic_write', arguments: { value: 47 } },
      });
    await request.fetch(fixture.endpoint, { method: 'POST', body: body(1) });
    await assert.rejects(request.fetch(fixture.endpoint, { method: 'POST', body: body(2) }), {
      code: 'MCP_REPLAY_BLOCKED',
    });
    assert.equal(calls, 1);
    assert.equal(claims, 1);
    const denied = new McpFetch(fixture.endpoint, {
      ...fixture,
      onDispatch: async () => {
        throw new Error('synthetic claim failure');
      },
    });
    await assert.rejects(denied.fetch(fixture.endpoint, { method: 'POST', body: body(3) }));
    assert.equal(calls, 1);
  } finally {
    await fixture.close();
  }
});
