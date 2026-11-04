import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disconnected, type ReviewCapture } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RuntimeClient } from './client.js';
import { startPrototype } from './server.js';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const capture = (text: string): ReviewCapture => ({
  snapshot: {
    area: 'task',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:00Z',
    capture: 'complete',
    reasons: [],
    omitted: 0,
  },
  files: [
    {
      area: 'task',
      path: 'input.txt',
      state: 'present',
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
      text: true,
    },
  ],
  texts: [{ area: 'task', path: 'input.txt', data: Buffer.from(text).toString('base64') }],
});
test('authenticated review API binds task ownership and only reads saved entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-api-'));
  const app = await startPrototype({
    port: 0,
    computers: true,
    profileDir: path.join(root, 'profile'),
  });
  const post = (action: string, query: unknown, auth = true) =>
    fetch(`${app.url}/api/files/review/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { 'x-prototype-token': app.token } : {}),
      },
      body: JSON.stringify(query),
    });
  try {
    expect.assert(app.models);
    vi.spyOn(app.models, 'fileReviewAvailable', 'get').mockReturnValue(true);
    await app.models.journal.put({
      ...scope,
      kind: 'chat',
      phase: 'completed',
      running: false,
      prompt: 'Synthetic task.',
      result: 'Synthetic answer.',
      error: '',
      trace: [],
    });
    await app.models.reviews.begin(scope);
    await app.models.reviews.before(scope, [capture('before\n')], {});
    const pointer = await app.models.reviews.finish(scope, [capture('after\n')]);
    expect((await post('read', { scope })).status).toBe(200);
    expect((await post('read', { scope }, false)).status).toBe(403);
    expect((await post('read', { scope: { ...scope, bot: 'mock-other' } })).status).toBe(404);
    expect((await post('read', { scope: { ...scope, chatRevision: 1 } })).status).toBe(404);
    expect((await post('read', { scope, restore: true })).status).toBe(400);
    const query = { scope, revision: pointer.revision, area: 'task' as const, path: 'input.txt' };
    expect((await post('diff', query)).status).toBe(200);
    expect((await post('diff', { ...query, revision: 99 })).status).toBe(409);
    expect((await post('diff', { ...query, path: 'unlisted.txt' })).status).toBe(404);
    expect((await post('diff', { ...query, path: '../secret' })).status).toBe(400);
    const client = new RuntimeClient({ origin: app.url, tokenProvider: async () => app.token });
    expect(await client.status()).toMatchObject({ fileReview: { available: true } });
    expect(await client.invoke({ type: 'files.review.read', query: { scope } })).toMatchObject({
      state: 'complete',
      counts: { modified: 1 },
    });
    expect(await client.invoke({ type: 'files.review.diff', query })).toMatchObject({
      state: 'text',
    });
    expect(app.models.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('client freezes queries, requires actual capability and rejects cross-scope responses', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      scope: { ...scope, bot: 'mock-other' },
      revision: 1,
      state: 'matching',
      area: 'task',
      path: 'input.txt',
    }),
  );
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const status = vi.spyOn(client, 'status').mockResolvedValue(disconnected('ready'));
  const query = { scope, revision: 1, area: 'task' as const, path: 'input.txt' };
  await expect(client.invoke({ type: 'files.review.current', query })).rejects.toThrow(
    'FILE_REVIEW_UNSUPPORTED',
  );
  expect(fetcher).not.toHaveBeenCalled();
  status.mockResolvedValue({ ...disconnected('ready'), fileReview: { available: true } });
  await expect(client.invoke({ type: 'files.review.current', query })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
});

test('accepted shared selection cannot mutate while task-start waits for status', async () => {
  let body = '';
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:12345',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (_url, options) => {
      body = String(options?.body);
      return Response.json({
        runId: 'mock-run',
        requestId: 'mock-frozen',
        prompt: 'Synthetic task.',
        phase: 'running',
        running: true,
        result: '',
        error: '',
        chatRevision: 0,
      });
    },
  });
  let release: () => unknown = () => {};
  vi.spyOn(client, 'status').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ...disconnected('ready'),
            protocolVersion: 45,
            fileReview: { available: true },
          });
      }),
  );
  const task = {
    requestId: 'mock-frozen',
    prompt: 'Synthetic task.',
    chatRevision: 0,
    fileReview: { sharedPaths: ['selected.txt'] },
  };
  const pending = client.invoke({ type: 'task.start', bot: scope.bot, task });
  task.fileReview.sharedPaths[0] = 'later.txt';
  release();
  await pending;
  expect(JSON.parse(body)).toMatchObject({
    task: { fileReview: { sharedPaths: ['selected.txt'] } },
  });
});
