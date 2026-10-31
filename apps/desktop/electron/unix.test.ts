import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, globalAgent, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readAgentToken, unixFetch } from './unix';

const roots = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});
async function listener(handler: (request: IncomingMessage, response: ServerResponse) => unknown) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mock-unix-'));
  roots.add(root);
  const socket = join(root, 's');
  const server = createServer(handler);
  server.listen(socket);
  await once(server, 'listening');
  await fs.chmod(socket, 0o600);
  return {
    root,
    socket,
    async close() {
      server.closeAllConnections();
      await new Promise<unknown>((done, reject) =>
        server.close((error) => (error ? reject(error) : done(undefined))),
      );
    },
  };
}

it('Unix fetch preserves status, headers and binary bytes while bypassing the ambient HTTP agent', async () => {
  const server = await listener(async (request, response) => {
    expect(request.url).toBe('/api/mock?part=1');
    expect(request.headers.host).toBe('127.0.0.1:8766');
    expect(request.headers['x-prototype-token']).toBe('a'.repeat(64));
    let body = '';
    for await (const chunk of request) body += String(chunk);
    expect(body).toBe('synthetic body');
    response.writeHead(201, { 'content-type': 'application/octet-stream', 'x-mock': 'preserved' });
    response.end(Buffer.from([0, 1, 255]));
  });
  vi.spyOn(globalAgent, 'createConnection').mockImplementation(() => {
    throw new Error('AMBIENT_AGENT_MUST_NOT_RUN');
  });
  try {
    const response = await unixFetch(server.socket)('http://127.0.0.1:8766/api/mock?part=1', {
      method: 'POST',
      headers: { host: 'untrusted.test', 'x-prototype-token': 'a'.repeat(64) },
      body: 'synthetic body',
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-mock')).toBe('preserved');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 1, 255]));
  } finally {
    await server.close();
  }
});

it('Unix fetch rejects foreign origins and unsafe sockets without any network fallback', async () => {
  const received = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
    response.end('ok'),
  );
  const server = await listener(received);
  try {
    for (const url of [
      'http://127.0.0.1:8767/api/state',
      'https://example.test/',
      'http://user:secret@127.0.0.1:8766/',
    ])
      await expect(unixFetch(server.socket)(url)).rejects.toThrow('AGENT_REQUEST_DENIED');
    expect(received).not.toHaveBeenCalled();
    const original = await fs.lstat(server.socket);
    const foreign = Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      uid: original.uid + 1,
    });
    vi.spyOn(fs, 'lstat').mockResolvedValueOnce(foreign);
    await expect(unixFetch(server.socket)('http://127.0.0.1:8766/api/state')).rejects.toThrow(
      'AGENT_SOCKET_UNSAFE',
    );
    vi.restoreAllMocks();
    await fs.chmod(server.root, 0o755);
    await expect(unixFetch(server.socket)('http://127.0.0.1:8766/api/state')).rejects.toThrow(
      'AGENT_SOCKET_UNSAFE',
    );
    expect(received).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
  await expect(
    unixFetch(join(server.root, 'missing'))('http://127.0.0.1:8766/api/state'),
  ).rejects.toThrow('AGENT_SOCKET_UNSAFE');
});

it('Unix fetch bounds request and response bytes and cancels a streaming upload on abort', async () => {
  const accepted = vi.fn();
  let uploading: () => unknown = () => {};
  const started = new Promise<unknown>((done) => {
    uploading = () => done(undefined);
  });
  const server = await listener((request, response) => {
    accepted();
    if (request.url === '/large') response.end('x'.repeat(65));
    else uploading();
  });
  try {
    const fetcher = unixFetch(server.socket, { maxBytes: 64 });
    await expect(
      fetcher('http://127.0.0.1:8766/mock', { method: 'POST', body: 'x'.repeat(65) }),
    ).rejects.toThrow('AGENT_REQUEST_TOO_LARGE');
    expect(accepted).not.toHaveBeenCalled();
    await expect(fetcher('http://127.0.0.1:8766/large')).rejects.toThrow(
      'AGENT_RESPONSE_TOO_LARGE',
    );
    const abort = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('mock upload'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = fetcher('http://127.0.0.1:8766/upload', {
      method: 'POST',
      body: stream,
      signal: abort.signal,
    });
    await started;
    abort.abort('mock-private-payload');
    await expect(request).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Agent request aborted',
    });
    expect(cancelled).toBe(true);
  } finally {
    await server.close();
  }
});

it('host authentication reads only the private local model token and refuses missing, linked or permissive files', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mock-agent-auth-'));
  roots.add(root);
  const model = join(root, 'model');
  const token = join(model, 'control-token');
  await fs.mkdir(model, { mode: 0o700 });
  await fs.writeFile(token, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  await fs.writeFile(join(root, 'execution-token'), 'b'.repeat(64), { mode: 0o600 });
  expect(await readAgentToken(root)).toBe('a'.repeat(64));
  await fs.chmod(token, 0o644);
  await expect(readAgentToken(root)).rejects.toThrow('AGENT_AUTH_UNAVAILABLE');
  await fs.unlink(token);
  await fs.symlink(join(root, 'execution-token'), token);
  await expect(readAgentToken(root)).rejects.toThrow('AGENT_AUTH_UNAVAILABLE');
  await fs.unlink(token);
  await expect(readAgentToken(root)).rejects.toThrow('AGENT_AUTH_UNAVAILABLE');
  const original = await fs.lstat(root);
  vi.spyOn(fs, 'lstat').mockResolvedValueOnce(
    Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      uid: original.uid + 1,
    }),
  );
  await expect(readAgentToken(root)).rejects.toThrow('AGENT_AUTH_UNAVAILABLE');
});

it('counts streamed bytes and rejects non-byte chunks before dispatching an upload', async () => {
  const accepted = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
    response.end('ok'),
  );
  const server = await listener(accepted);
  try {
    const fetcher = unixFetch(server.socket, { maxBytes: 64 });
    const large = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
        controller.close();
      },
    });
    await expect(
      fetcher('http://127.0.0.1:8766/upload', { method: 'POST', body: large }),
    ).rejects.toThrow('AGENT_REQUEST_TOO_LARGE');
    const invalid = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('x'.repeat(65));
        controller.close();
      },
    });
    await expect(
      fetcher('http://127.0.0.1:8766/upload', { method: 'POST', body: invalid }),
    ).rejects.toThrow('AGENT_REQUEST_UNAVAILABLE');
    expect(accepted).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
