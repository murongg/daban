import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { SearchClient } from './search.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

const waitingRead = vi.hoisted(() => ({
  file: '',
  enter: () => {},
  wait: undefined as Promise<undefined> | undefined,
}));
const transport = vi.hoisted(() => ({
  resolve: vi.fn(),
  dial: vi.fn(),
  request: vi.fn(),
  tls: vi.fn(),
}));
vi.mock('node:tls', async (original) => ({
  ...(await original<typeof import('node:tls')>()),
  connect: transport.tls,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      if (String(args[0]) === waitingRead.file && waitingRead.wait) {
        waitingRead.enter();
        await waitingRead.wait;
      }
      return result;
    },
  };
});
vi.mock('./network.js', async (original) => ({
  ...(await original<typeof import('./network.js')>()),
  resolvePublic: transport.resolve,
  dialAddress: transport.dial,
}));
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: transport.request,
}));

function barrier() {
  let enter = () => {};
  const entered = new Promise<undefined>((resolve) => {
    enter = () => resolve(undefined);
  });
  let release = () => {};
  const wait = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  return { enter, entered, wait, release };
}
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  waitingRead.file = '';
  waitingRead.wait = undefined;
  transport.resolve.mockReset();
  transport.dial.mockReset();
  transport.request.mockReset();
  transport.tls.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each(['retired', 'cancelled', 'timeout', 'certificate'] as const)(
  'a proxy TLS handshake sends no query after %s',
  async (mode) => {
    const socket = new PassThrough();
    const tls = new PassThrough();
    const handshake = barrier();
    const abort = new AbortController();
    const deadline = new AbortController();
    if (mode === 'timeout') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    transport.resolve.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    transport.dial.mockResolvedValue(socket);
    transport.tls.mockImplementation(() => {
      handshake.enter();
      return tls;
    });
    let current = true;
    let sends = 0;
    transport.request.mockImplementation(
      (
        options: { agent: { createConnection: () => unknown } },
        callback: (response: EventEmitter) => unknown,
      ) => {
        options.agent.createConnection();
        const response = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
        });
        return Object.assign(new EventEmitter(), {
          end: () => {
            sends++;
            callback(response);
            response.emit('data', Buffer.from('<p class="no-results">Synthetic empty result</p>'));
            response.emit('end');
          },
        });
      },
    );
    const pending = new SearchClient().query(
      'duckduckgo',
      '',
      'synthetic query',
      abort.signal,
      5,
      () => {
        if (!current) throw new Fault('UNAUTHORIZED', 403);
      },
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await handshake.entered;
    if (mode === 'retired') {
      current = false;
      tls.emit('secureConnect');
    } else if (mode === 'cancelled') abort.abort();
    else if (mode === 'timeout') deadline.abort(new Error('Synthetic deadline'));
    else if (mode === 'certificate') tls.emit('error', new Error('Synthetic certificate refused'));
    const codes = {
      retired: 'UNAUTHORIZED',
      cancelled: 'SEARCH_CANCELLED',
      timeout: 'SEARCH_TIMEOUT',
      certificate: 'SEARCH_UNAVAILABLE',
    };
    expect(await outcome).toMatchObject({ error: { code: codes[mode] } });
    expect(sends).toBe(0);
    expect(transport.request).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(tls.destroyed).toBe(true);
  },
);
async function fixture(client: ConstructorParameters<typeof SearchSettings>[2], legacy = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-fence-'));
  roots.push(root);
  const models = new ModelSettings(path.join(root, 'models.json'));
  if (legacy)
    await writeFile(models.file, JSON.stringify({ apiKey: 'synthetic-legacy-key' }), {
      mode: 0o600,
    });
  const search = new SearchSettings(path.join(root, 'search.json'), models, client);
  if (legacy)
    await writeFile(
      search.file,
      JSON.stringify({
        version: 1,
        revision: 0,
        checkRevision: 0,
        enabled: true,
        provider: 'deepseek',
        credential: { kind: 'legacy-linked', connection: 'deepseek-official' },
      }),
      { mode: 0o600 },
    );
  if (!legacy)
    await search.configure({
      requestId: 'mock-search-key',
      revision: 0,
      enabled: true,
      provider: 'brave',
      key: 'synthetic-search-key',
    });
  return { models, search, capture: await search.capture() };
}

test('the Host gate is checked after asynchronous search configuration reads before a synthetic supplier runs', async () => {
  const supplier = vi.fn(async () => ({ sources: [], truncated: false }));
  const f = await fixture({ query: supplier });
  const gate = barrier();
  waitingRead.file = f.search.file;
  waitingRead.enter = gate.enter;
  waitingRead.wait = gate.wait;
  let current = true;
  const pending = Reflect.apply(f.search.query, f.search, [
    f.capture,
    'synthetic query',
    undefined,
    5,
    () => {
      if (!current) throw new Fault('UNAUTHORIZED', 403);
    },
  ]);
  const rejected = expect(pending).rejects.toBeDefined();
  await gate.entered;
  current = false;
  gate.release();
  await rejected;
  expect(supplier).not.toHaveBeenCalled();
});

test.each([
  ['resolve', 'brave'],
  ['dial', 'brave'],
  ['resolve', 'duckduckgo'],
  ['dial', 'duckduckgo'],
] as const)(
  'the final gate after %s prevents %s HTTP bytes and closes an acquired socket',
  async (stage, provider) => {
    const gate = barrier();
    const socket = new PassThrough();
    let current = true;
    let sends = 0;
    transport.resolve.mockImplementation(async () => {
      if (stage === 'resolve') {
        gate.enter();
        await gate.wait;
      }
      return [{ address: '8.8.8.8', family: 4 }];
    });
    transport.dial.mockImplementation(async () => {
      if (stage === 'dial') {
        gate.enter();
        await gate.wait;
      }
      return socket;
    });
    transport.request.mockImplementation(
      (_input: unknown, callback: (response: EventEmitter) => unknown) => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
        const request = Object.assign(new EventEmitter(), {
          end: () => {
            sends++;
            callback(response);
            response.emit('data', Buffer.from('{"web":{"results":[]}}'));
            response.emit('end');
          },
          destroy: (error?: Error) => {
            if (error) request.emit('error', error);
          },
        });
        return request;
      },
    );
    const client = new SearchClient();
    const pending = Reflect.apply(client.query, client, [
      provider,
      provider === 'duckduckgo' ? '' : 'synthetic-search-key',
      'synthetic query',
      undefined,
      5,
      () => {
        if (!current) throw new Fault('UNAUTHORIZED', 403);
      },
    ]);
    const rejected = expect(pending).rejects.toBeDefined();
    await gate.entered;
    current = false;
    gate.release();
    await rejected;
    expect(sends).toBe(0);
    if (stage === 'dial') expect(socket.destroyed).toBe(true);
  },
);

test.each(['independent', 'legacy'] as const)(
  'an in-owner %s key change invalidates the transport final gate',
  async (kind) => {
    const gate = barrier();
    let sends = 0;
    const request = async (
      _input: Parameters<typeof fetch>[0],
      _init?: RequestInit,
      beforeSend?: () => unknown,
    ) => {
      gate.enter();
      await gate.wait;
      beforeSend?.();
      sends++;
      return Response.json(kind === 'legacy' ? { results: [] } : { web: { results: [] } });
    };
    const f = await fixture(new SearchClient(request), kind === 'legacy');
    const pending = f.search.query(f.capture, 'synthetic query');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SEARCH_CONFIG_CHANGED' });
    await gate.entered;
    try {
      if (kind === 'legacy') await f.models.save({ apiKey: 'synthetic-rotated-model-key' });
      else
        await f.search.configure({
          requestId: 'mock-rotate-search-key',
          revision: 1,
          enabled: true,
          provider: 'brave',
          key: 'synthetic-rotated-search-key',
        });
    } finally {
      gate.release();
    }
    await rejected;
    expect(sends).toBe(0);
  },
);

test('diagnostic receipt writes do not retire an unchanged search configuration', async () => {
  const gate = barrier();
  let calls = 0;
  const request = async (
    _input: Parameters<typeof fetch>[0],
    _init?: RequestInit,
    beforeSend?: () => unknown,
  ) => {
    if (++calls === 1) {
      gate.enter();
      await gate.wait;
    }
    beforeSend?.();
    return Response.json({ web: { results: [] } });
  };
  const f = await fixture(new SearchClient(request));
  const pending = f.search.query(f.capture, 'synthetic task query');
  await gate.entered;
  try {
    expect(
      await f.search.check({
        requestId: 'mock-diagnostic-during-task',
        revision: 1,
        checkRevision: 0,
      }),
    ).toMatchObject({ phase: 'settled', status: { health: 'empty' } });
  } finally {
    gate.release();
  }
  expect(await pending).toEqual({ sources: [], truncated: false });
  expect(calls).toBe(2);
});
