import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { expect, test } from 'vitest';
import { runMcpStdio } from './mcp-stdio.js';

function capture() {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return {
    output,
    messages: () =>
      text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

test('stdio MCP preserves RPC IDs, result blocks, error data and empty notification acknowledgements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-mcp-stdio-'));
  const socketPath = join(root, 's');
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    expect(request.url).toBe('/mcp/mock-bot');
    expect(request.headers.authorization).toBe('Bearer mock-capability');
    let text = '';
    for await (const chunk of request) text += String(chunk);
    expect(text.includes('mock-capability')).toBe(false);
    expect(text.includes('mock-provider-secret')).toBe(false);
    const rpc = JSON.parse(text);
    received.push(rpc);
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
    } else if (rpc.method === 'tools/call') {
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'image', mimeType: 'image/png', data: 'U1lOVEhFVElD' }] },
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32601, message: 'Synthetic method missing', data: { retry: false } },
        }),
      );
    }
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const requests = [
    {
      jsonrpc: '2.0',
      id: 'mock-image',
      method: 'tools/call',
      params: { name: 'screenshot', arguments: {} },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 7, method: 'synthetic/missing' },
  ];
  const captured = capture();
  try {
    const serialized = requests.map((rpc) => JSON.stringify(rpc)).join('\n');
    await runMcpStdio({
      env: {
        DABAN_AGENT_SOCKET: socketPath,
        DABAN_AGENT_BOT: 'mock-bot',
        DABAN_AGENT_CAPABILITY: 'mock-capability',
        DEEPSEEK_API_KEY: 'mock-provider-secret',
      },
      input: Readable.from([serialized.slice(0, 25), serialized.slice(25)]),
      output: captured.output,
    });
    expect(received).toStrictEqual(requests);
    expect(captured.messages()).toStrictEqual([
      {
        jsonrpc: '2.0',
        id: 'mock-image',
        result: { content: [{ type: 'image', mimeType: 'image/png', data: 'U1lOVEhFVElD' }] },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32601, message: 'Synthetic method missing', data: { retry: false } },
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('stdio MCP rejects invalid routing before IO and returns sanitized parse and transport errors', async () => {
  for (const env of [
    {},
    {
      DABAN_AGENT_SOCKET: '/tmp/mock.sock',
      DABAN_AGENT_BOT: '../mock-bot',
      DABAN_AGENT_CAPABILITY: 'mock-capability',
    },
  ]) {
    await expect(
      runMcpStdio({ env, input: Readable.from([]), output: capture().output }),
    ).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^MCP_STDIO_CONFIG_INVALID$/),
    });
  }
  const captured = capture();
  await runMcpStdio({
    env: {
      DABAN_AGENT_SOCKET: '/tmp/mock-missing-mcp.sock',
      DABAN_AGENT_BOT: 'mock-bot',
      DABAN_AGENT_CAPABILITY: 'mock-capability',
    },
    input: Readable.from([
      'mock-private-payload\n',
      `${JSON.stringify({ jsonrpc: '2.0', id: 'mock-call', method: 'tools/list' })}\n`,
    ]),
    output: captured.output,
  });
  expect(captured.messages()).toStrictEqual([
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } },
    {
      jsonrpc: '2.0',
      id: 'mock-call',
      error: { code: -32603, message: 'Private agent unavailable' },
    },
  ]);
  expect(JSON.stringify(captured.messages()).includes('mock-private-payload')).toBe(false);
});

test('stdio MCP rejects oversized frames without forwarding private diagnostics', async () => {
  const captured = capture();
  await expect(
    runMcpStdio({
      env: {
        DABAN_AGENT_SOCKET: '/tmp/mock-missing-mcp.sock',
        DABAN_AGENT_BOT: 'mock-bot',
        DABAN_AGENT_CAPABILITY: 'mock-capability',
      },
      input: Readable.from(['x'.repeat(8 * 1024 * 1024 + 1)]),
      output: captured.output,
    }),
  ).rejects.toMatchObject({
    name: 'Error',
    message: expect.stringMatching(/^MCP_STDIO_FRAME_TOO_LARGE$/),
  });
  expect(captured.messages()).toStrictEqual([]);
});

test('stdio MCP forwards cancellation while an earlier tool request is still pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-mcp-cancel-'));
  const socketPath = join(root, 's');
  let pending: import('node:http').ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const rpc = JSON.parse(text);
    if (rpc.method === 'tools/call') pending = response;
    else {
      response.writeHead(202);
      response.end();
      pending?.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'mock-pending',
          error: { code: -32800, message: 'Cancelled' },
        }),
      );
    }
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const captured = capture();
  try {
    await runMcpStdio({
      env: {
        DABAN_AGENT_SOCKET: socketPath,
        DABAN_AGENT_BOT: 'mock-bot',
        DABAN_AGENT_CAPABILITY: 'mock-capability',
      },
      input: Readable.from([
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 'mock-pending',
          method: 'tools/call',
          params: { name: 'mock' },
        })}\n`,
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 'mock-pending' },
        })}\n`,
      ]),
      output: captured.output,
      signal: AbortSignal.timeout(500),
    });
    expect(captured.messages()).toStrictEqual([
      { jsonrpc: '2.0', id: 'mock-pending', error: { code: -32800, message: 'Cancelled' } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('stdio MCP refuses a response for another request ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-mcp-scope-'));
  const socketPath = join(root, 's');
  const server = createServer((_request, response) =>
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'mock-foreign',
        result: { secret: 'mock-private-payload' },
      }),
    ),
  );
  server.listen(socketPath);
  await once(server, 'listening');
  const captured = capture();
  try {
    await runMcpStdio({
      env: {
        DABAN_AGENT_SOCKET: socketPath,
        DABAN_AGENT_BOT: 'mock-bot',
        DABAN_AGENT_CAPABILITY: 'mock-capability',
      },
      input: Readable.from([
        `${JSON.stringify({ jsonrpc: '2.0', id: 'mock-owned', method: 'tools/list' })}\n`,
      ]),
      output: captured.output,
    });
    expect(captured.messages()).toStrictEqual([
      {
        jsonrpc: '2.0',
        id: 'mock-owned',
        error: { code: -32603, message: 'Private agent unavailable' },
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});
