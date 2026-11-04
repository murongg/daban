import { X509Certificate } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { McpFetch } from './mcp-fetch.js';
import { tlsFixture } from './tls.fixture.js';

test('synthetic MCP TLS certificate is a valid self-issued CA for its hostname', async (t) => {
  const fixture = await tlsFixture((_req, res) => res.end());
  t.onTestFinished(async () => {
    await fixture.close();
  });
  const certificate = new X509Certificate(fixture.ca);
  expect(certificate.ca).toBe(true);
  expect(certificate.checkIssued(certificate)).toBe(true);
  expect(certificate.checkHost('mcp.example.test')).toBe('mcp.example.test');
  expect(certificate.verify(certificate.publicKey)).toBe(true);
});

test('MCP HTTP uses the exact endpoint, validated public IP and verified TLS name while keeping authorization on that request', async () => {
  let calls = 0;
  const fixture = await tlsFixture((req, res) => {
    calls++;
    expect(req.url).toBe('/mcp?key=synthetic-url-secret');
    expect(req.headers.authorization).toBe('Bearer synthetic-header-secret');
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
    expect(await response.json()).toStrictEqual({ ok: true });
    expect(pins).toStrictEqual(['8.8.8.8']);
    await expect(
      request.fetch(fixture.endpoint.replace('/mcp?', '/foreign?'), { method: 'POST' }),
    ).rejects.toMatchObject({ code: 'MCP_NETWORK_BLOCKED' });
    expect(calls).toBe(1);
    const mixed = new McpFetch(fixture.endpoint, {
      ...fixture,
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    await expect(mixed.fetch(fixture.endpoint, { method: 'POST' })).rejects.toMatchObject({
      code: 'MCP_NETWORK_BLOCKED',
    });
    const untrusted = new McpFetch(fixture.endpoint, {
      resolve: fixture.resolve,
      dial: fixture.dial,
    });
    await expect(untrusted.fetch(fixture.endpoint, { method: 'POST' })).rejects.toThrowError();
    expect(calls, 'a self-signed test endpoint must fail without its explicit synthetic CA').toBe(
      1,
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
    await expect(request.fetch(fixture.endpoint, { method: 'POST' })).rejects.toMatchObject({
      code: 'MCP_REDIRECT_REFUSED',
    });
    mode = 'large';
    await expect(request.fetch(fixture.endpoint, { method: 'POST' })).rejects.toMatchObject({
      code: 'MCP_RESPONSE_TOO_LARGE',
    });
    mode = 'hang';
    const abort = new AbortController();
    const pending = request.fetch(fixture.endpoint, { method: 'POST', signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrowError();
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
    await expect(
      request.fetch(fixture.endpoint, { method: 'POST', body: body(2) }),
    ).rejects.toMatchObject({
      code: 'MCP_REPLAY_BLOCKED',
    });
    expect(calls).toBe(1);
    expect(claims).toBe(1);
    const denied = new McpFetch(fixture.endpoint, {
      ...fixture,
      onDispatch: async () => {
        throw new Error('synthetic claim failure');
      },
    });
    await expect(
      denied.fetch(fixture.endpoint, { method: 'POST', body: body(3) }),
    ).rejects.toThrowError();
    expect(calls).toBe(1);
  } finally {
    await fixture.close();
  }
});

test('revocation while dialing prevents the actual MCP tool HTTP request', async () => {
  let calls = 0;
  let revoked = false;
  const fixture = await tlsFixture((_req, res) => {
    calls++;
    res.end('{}');
  });
  const options = {
    ...fixture,
    onDispatch: async () => undefined,
    assertAuthority: () => {
      if (revoked) throw new Error('APPROVAL_POLICY_CHANGED');
    },
    dial: async (address: string, port: number, signal: AbortSignal) => {
      const socket = await fixture.dial(address, port, signal);
      revoked = true;
      return socket;
    },
  };
  const request = new McpFetch(fixture.endpoint, options);
  try {
    await expect(
      request.fetch(fixture.endpoint, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'synthetic_write', arguments: {} },
        }),
      }),
    ).rejects.toThrow('APPROVAL_POLICY_CHANGED');
    expect(calls).toBe(0);
  } finally {
    await fixture.close();
  }
});
