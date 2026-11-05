import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http, {
  type ClientRequest,
  createServer,
  globalAgent,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { bridgeRequest, callBridge } from './bridge.js';

async function socketServer(
  handler: (request: IncomingMessage, response: ServerResponse) => unknown,
) {
  const root = await mkdtemp(join(tmpdir(), 'mock-bridge-'));
  const socketPath = join(root, 's');
  const server = createServer(handler);
  server.listen(socketPath);
  await once(server, 'listening');
  return {
    socketPath,
    async close() {
      server.closeAllConnections();
      await new Promise<unknown>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('private bridge keeps capability in headers and rejects RPC errors without echoing raw payloads', async () => {
  const config = {
    url: 'http://127.0.0.1:12345/mcp/mock-bot',
    capability: 'mock-private-capability',
  };
  const value = await callBridge(
    config,
    'mock.method',
    { value: 'synthetic' },
    new AbortController().signal,
    async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer mock-private-capability');
      expect(String(init.body).includes('mock-private-capability')).toBe(false);
      return Response.json({ result: { accepted: true } });
    },
  );
  expect(value).toStrictEqual({ accepted: true });
  await expect(
    callBridge(config, 'mock.method', {}, new AbortController().signal, async () =>
      Response.json({ error: { message: 'mock-private-payload' } }),
    ),
  ).rejects.toThrowError(/BRIDGE_UNAVAILABLE/);
});

test('Unix callback transport sends the logical route and optional capability without using fetch', async () => {
  const received: string[] = [];
  const server = await socketServer(async (request, response) => {
    expect(request.url).toBe('/mcp/mock-bot');
    expect(request.headers.host).toBe('127.0.0.1:8766');
    received.push(request.headers.authorization || '');
    let body = '';
    for await (const chunk of request) body += String(chunk);
    expect(body.includes('mock-private-capability')).toBe(false);
    expect(JSON.parse(body).method).toBe('mock.method');
    response.end(JSON.stringify({ jsonrpc: '2.0', result: { accepted: true } }));
  });
  try {
    for (const capability of ['mock-private-capability', undefined]) {
      const value = await callBridge(
        { url: 'http://127.0.0.1:8766/mcp/mock-bot', socketPath: server.socketPath, capability },
        'mock.method',
        { value: 'synthetic' },
        new AbortController().signal,
        async () => {
          throw new Error('FETCH_MUST_NOT_RUN');
        },
      );
      expect(value).toStrictEqual({ accepted: true });
    }
    expect(received).toStrictEqual(['Bearer mock-private-capability', '']);
  } finally {
    await server.close();
  }
});

test('Unix bridge preserves complete RPC envelopes and empty notification acknowledgements', async () => {
  const rpc = { jsonrpc: '2.0', id: 'mock-call', method: 'tools/call', params: { name: 'mock' } };
  const failure = {
    jsonrpc: '2.0',
    id: 'mock-call',
    error: { code: -32601, message: 'mock error', data: { retry: false } },
  };
  const server = await socketServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body);
    if (!Object.hasOwn(input, 'id')) {
      response.writeHead(202);
      response.end();
    } else {
      expect(input).toStrictEqual(rpc);
      response.end(JSON.stringify(failure));
    }
  });
  const config = { url: 'http://127.0.0.1:8766/mcp/mock-bot', socketPath: server.socketPath };
  try {
    expect(await bridgeRequest(config, rpc, new AbortController().signal)).toStrictEqual(failure);
    expect(
      await bridgeRequest(
        config,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        new AbortController().signal,
      ),
    ).toBe(undefined);
  } finally {
    await server.close();
  }
});

test('Unix bridge bypasses an ambient HTTP agent so model proxy settings cannot reroute callbacks', async () => {
  const server = await socketServer((_request, response) =>
    response.end(JSON.stringify({ result: true })),
  );
  const previous = globalAgent.createConnection;
  globalAgent.createConnection = () => {
    throw new Error('AMBIENT_AGENT_MUST_NOT_RUN');
  };
  try {
    expect(
      await callBridge(
        { url: 'http://127.0.0.1:8766/mcp/mock-bot', socketPath: server.socketPath },
        'mock.method',
        {},
        new AbortController().signal,
      ),
    ).toBe(true);
  } finally {
    globalAgent.createConnection = previous;
    await server.close();
  }
});

test('Unix bridge rejects oversized padding even when the retained prefix is valid JSON', async () => {
  const server = await socketServer((_request, response) =>
    response.end(`{"result":true}${' '.repeat(16 * 1024 * 1024)}`),
  );
  try {
    await expect(
      callBridge(
        { url: 'http://127.0.0.1:8766/mcp/mock-bot', socketPath: server.socketPath },
        'mock.method',
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^BRIDGE_UNAVAILABLE$/),
    });
  } finally {
    await server.close();
  }
});

test('Unix bridge rejects the byte limit before a simultaneous end event can resolve valid JSON', async () => {
  const previous = http.request;
  http.request = ((_options: unknown, reply: (response: IncomingMessage) => unknown) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const connection = Object.assign(new EventEmitter(), {
      end: () => {
        reply(response as unknown as IncomingMessage);
        response.emit('data', Buffer.from('{"result":true}'));
        response.emit('data', Buffer.alloc(16 * 1024 * 1024, 32));
        response.emit('end');
      },
      destroy: (error: Error) => {
        queueMicrotask(() => connection.emit('error', error));
        return connection;
      },
    });
    return connection as unknown as ClientRequest;
  }) as typeof http.request;
  syncBuiltinESMExports();
  try {
    await expect(
      callBridge(
        { url: 'http://127.0.0.1:8766/mcp/mock-bot', socketPath: '/tmp/mock-private.sock' },
        'mock.method',
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^BRIDGE_UNAVAILABLE$/),
    });
  } finally {
    http.request = previous;
    syncBuiltinESMExports();
  }
});

test('Unix bridge fails closed on unavailable sockets, abort, oversized responses and malformed bodies', async () => {
  let fetches = 0;
  const missing = {
    url: 'http://127.0.0.1:8766/mcp/mock-bot',
    socketPath: '/tmp/mock-absent-daban.sock',
    capability: 'mock-private-capability',
  };
  await expect(
    callBridge(missing, 'mock.method', {}, new AbortController().signal, async () => {
      fetches++;
      return Response.json({ result: true });
    }),
  ).rejects.toMatchObject({
    name: 'Error',
    message: expect.stringMatching(/^BRIDGE_UNAVAILABLE$/),
  });
  expect(fetches).toBe(0);
  for (const body of [
    'mock-private-payload',
    JSON.stringify({ result: 'x'.repeat(16 * 1024 * 1024) }),
  ]) {
    const server = await socketServer((_request, response) => response.end(body));
    try {
      await expect(
        callBridge(
          { ...missing, socketPath: server.socketPath },
          'mock.method',
          {},
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        name: 'Error',
        message: expect.stringMatching(/^BRIDGE_UNAVAILABLE$/),
      });
    } finally {
      await server.close();
    }
  }
  let accepted: () => unknown = () => {};
  const received = new Promise<unknown>((resolve) => {
    accepted = () => resolve(undefined);
  });
  const server = await socketServer(() => accepted());
  const abort = new AbortController();
  try {
    const result = callBridge(
      { ...missing, socketPath: server.socketPath },
      'mock.method',
      {},
      abort.signal,
    );
    await received;
    abort.abort();
    await expect(result).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
  } finally {
    await server.close();
  }
});
