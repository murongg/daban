import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disconnected, parseRuntimeCommand, type RuntimeSnapshot } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RuntimeClient } from './client.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };

test('a retained Goal target read freezes its owner and validates the published response', async () => {
  let release = () => {};
  const token = new Promise<string>((resolve) => {
    release = () => resolve('a'.repeat(64));
  });
  const owner = { bot: scope.bot, chatRevision: 0 };
  const target = {
    owner: { ...owner },
    sessionId: 'mock-session',
    goalId: 'mock-goal',
    goalRevision: 2,
    humanEpoch: 3,
  };
  const fetcher = vi.fn(async () => Response.json(target));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: () => token,
    fetcher,
  });
  const command = parseRuntimeCommand({ type: 'goal.target', owner });
  const pending = client.invoke(command);
  owner.bot = 'mock-retargeted';
  release();
  expect(await pending).toEqual(target);
  expect(fetcher).toHaveBeenCalledWith(
    'http://127.0.0.1:12345/api/goals/target',
    expect.objectContaining({ body: JSON.stringify({ owner: target.owner }) }),
  );
});

test('keyless Search stays usable through the canonical client with the current public status DTO', async () => {
  const status = {
    revision: 1,
    checkRevision: 0,
    enabled: true,
    provider: 'duckduckgo',
    credentialConfigured: false,
    credentialSource: 'none',
    health: 'unchecked',
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => Response.json(status),
  });
  vi.spyOn(client, 'status').mockResolvedValue({ ...disconnected('ready'), searchSettings: true });
  expect(await client.invoke({ type: 'search.status' })).toEqual(status);
});

test('Goal target reads refuse a different owner and only a missing endpoint has the legacy null fallback', async () => {
  const owner = { bot: scope.bot, chatRevision: 0 };
  let response = Response.json({
    owner: { ...owner, bot: 'mock-foreign' },
    sessionId: 'mock-session',
    goalId: 'mock-goal',
    goalRevision: 1,
    humanEpoch: 0,
  });
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => response,
  });
  const command = parseRuntimeCommand({ type: 'goal.target', owner });
  await expect(client.invoke(command)).rejects.toThrow('INVALID_GOAL_TARGET');
  response = Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  expect(await client.invoke(command)).toBeNull();
  response = Response.json({ error: 'GOAL_TARGET_UNAVAILABLE' }, { status: 503 });
  await expect(client.invoke(command)).rejects.toThrow('GOAL_TARGET_UNAVAILABLE');
});

test('consumer formatting is immutable per invoke and cannot leak between concurrent peers', async () => {
  const headers: (string | null)[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (_url, options) => {
      headers.push(new Headers(options?.headers).get('x-daban-automation'));
      await Promise.resolve();
      return Response.json([]);
    },
  });
  await Promise.all([
    client.invoke({ type: 'files.list' }, 1),
    client.invoke({ type: 'files.list' }, 2),
  ]);
  expect(headers.sort()).toEqual([null, 'schedule-automation-v1'].sort());
});

test('real Host state normalization retains capability and reads legacy records without starting work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-client-'));
  // A private TEMP ACL alone does not register a trusted Windows authentication root.
  await secureDirectory(root);
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  try {
    expect.assert(app.models);
    await app.models.journal.put({
      ...scope,
      kind: 'chat',
      phase: 'completed',
      running: false,
      prompt: 'SYNTHETIC REQUEST',
      result: 'SYNTHETIC RESULT',
      error: '',
      trace: [],
    });
    const client = new RuntimeClient({ origin: app.url, tokenProvider: async () => app.token });
    expect(await client.status()).toMatchObject({ phase: 'ready', contextInspector: 1 });
    expect(await client.invoke({ type: 'context.inspect', query: { scope } })).toEqual({
      scope,
      state: 'unavailable',
      reason: 'legacy',
    });
    expect(app.models.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('missing capability sends no query even on a high protocol; requests freeze scope before status yields', async () => {
  let body = '';
  let reply: unknown = { scope, state: 'unavailable', reason: 'legacy' };
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    body = String(options?.body);
    return Response.json(reply);
  });
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const status = vi
    .spyOn(client, 'status')
    .mockResolvedValue({ ...disconnected('ready'), protocolVersion: 999 });
  await expect(client.invoke({ type: 'context.inspect', query: { scope } })).rejects.toThrow(
    'CONTEXT_UNSUPPORTED',
  );
  expect(fetcher).not.toHaveBeenCalled();
  let resolve: (state: RuntimeSnapshot) => unknown = () => {};
  status.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const query = { scope: { ...scope } };
  const pending = client.invoke({ type: 'context.inspect', query });
  query.scope.runId = 'mock-mutated';
  resolve({ ...disconnected('ready'), contextInspector: 1 });
  expect(await pending).toEqual(reply);
  expect(JSON.parse(body)).toEqual({ scope });
  status.mockResolvedValue({ ...disconnected('ready'), contextInspector: 1 });
  reply = { scope: { ...scope, bot: 'mock-other' }, state: 'unavailable', reason: 'legacy' };
  await expect(client.invoke({ type: 'context.inspect', query: { scope } })).rejects.toThrow(
    'INVALID_CONTEXT_VIEW',
  );
  reply = { ...scope, seq: 2, offset: 0, total: 0, text: '' };
  await expect(
    client.invoke({
      type: 'context.source',
      query: { scope, revision: 1, ref: { scope, seq: 1 } },
    }),
  ).rejects.toThrow('INVALID_CONTEXT_SOURCE');
});
