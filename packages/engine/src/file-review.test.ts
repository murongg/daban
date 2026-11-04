import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReviewArea, ReviewCapture } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { FileReviews } from './file-review.js';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function mockCapture(text: string, area: ReviewArea = 'task', name = 'input.txt'): ReviewCapture {
  return {
    snapshot: {
      area,
      capture: 'complete',
      reasons: [],
      omitted: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.000Z',
    },
    files: [
      {
        area,
        path: name,
        state: 'present',
        bytes: Buffer.byteLength(text),
        sha256: digest(text),
        text: true,
      },
    ],
    texts: [{ area, path: name, data: Buffer.from(text).toString('base64') }],
  };
}
const roots = {
  task: { root: '/mock/task', canonical: '/mock/task' },
  shared: { root: '/mock/shared', canonical: '/mock/shared' },
};
async function fixture(t: Pick<TestContext, 'onTestFinished'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-file-review-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const reviews = new FileReviews(root);
  await reviews.ready;
  return { root, reviews };
}
test('retains original input bytes and immutable end evidence independently of current files', async (t) => {
  const { reviews } = await fixture(t);
  await reviews.begin(scope);
  await reviews.before(scope, [mockCapture('before\n')], roots);
  const pointer = await reviews.finish(scope, [mockCapture('after\n')]);
  const page = await reviews.read({ scope });
  expect(page).toMatchObject({
    state: 'complete',
    effects: 'partial',
    writers: 'unknown',
    counts: { modified: 1 },
  });
  expect(
    await reviews.read({ scope: { chatRevision: 0, runId: scope.runId, bot: scope.bot } }),
  ).toEqual(page);
  const query = { scope, revision: pointer.revision, area: 'task' as const, path: 'input.txt' };
  const diff = await reviews.diff(query);
  expect(diff).toMatchObject({
    state: 'text',
    lines: [
      { kind: 'remove', text: 'before\n' },
      { kind: 'add', text: 'after\n' },
    ],
  });
  expect(await reviews.current(query, async () => mockCapture('later\n', 'shared'))).toMatchObject({
    state: 'changed',
  });
  expect(await reviews.diff(query)).toEqual(diff);
});
test('rejects forged text digest and does not turn later shared files into authorization', async (t) => {
  const { reviews } = await fixture(t);
  await reviews.begin(scope, ['input.txt']);
  const unknown = mockCapture('before\n', 'shared');
  unknown.files = [{ area: 'shared', path: 'input.txt', state: 'absent' }];
  unknown.texts = [];
  await reviews.before(scope, [unknown, mockCapture('task')], roots);
  const pointer = await reviews.finish(scope, [mockCapture('task')]);
  let reads = 0;
  expect(
    await reviews.current(
      { scope, revision: pointer.revision, area: 'shared', path: 'input.txt' },
      async () => {
        reads++;
        return mockCapture('later', 'shared');
      },
    ),
  ).toMatchObject({ state: 'unknown' });
  expect(reads).toBe(0);
  const forged = mockCapture('forged');
  forged.texts[0].data = Buffer.from('wrong!').toString('base64');
  const other = { ...scope, runId: 'mock-forged' };
  await reviews.begin(other);
  await expect(reviews.before(other, [forged], roots)).rejects.toThrow();
});
test('binds scope and revisions, preserves old pagination and marks active records interrupted on restart', async (t) => {
  const { root, reviews } = await fixture(t);
  await reviews.begin(scope);
  const many = mockCapture('a');
  many.files = [];
  many.texts = [];
  for (let i = 0; i < 201; i++) {
    const entry = mockCapture('a', 'task', `mock-${String(i).padStart(3, '0')}.txt`);
    many.files.push(...entry.files);
    many.texts.push(...entry.texts);
  }
  await reviews.before(scope, [many], roots);
  const first = await reviews.read({ scope });
  expect(first.items).toHaveLength(200);
  expect(first.next).toBeTypeOf('string');
  await reviews.finish(scope, [many]);
  expect((await reviews.read({ scope, cursor: first.next })).revision).toBe(first.revision);
  await expect(
    reviews.read({ scope: { ...scope, bot: 'mock-other' }, cursor: first.next }),
  ).rejects.toThrow();
  await expect(
    reviews.diff({ scope, revision: 99, area: 'task', path: 'input.txt' }),
  ).rejects.toThrow('STALE_FILE_REVIEW');
  const active = { ...scope, runId: 'mock-active' };
  await reviews.begin(active);
  const reopened = new FileReviews(root);
  await reopened.ready;
  expect(await reopened.read({ scope: active })).toMatchObject({ state: 'interrupted' });
});
test('corrupt or expired evidence stays explicit and cleanup never removes active runs', async (t) => {
  const { root } = await fixture(t);
  let now = 1_900_000_000_000;
  const reviews = new FileReviews(root, { now: () => now, maxAge: 10 });
  await reviews.ready;
  await reviews.begin(scope);
  await reviews.before(scope, [mockCapture('before')], roots);
  await reviews.finish(scope, [mockCapture('after')]);
  const key = digest(JSON.stringify(scope));
  const blob = path.join(root, key, digest('before'));
  await writeFile(blob, 'broken', { mode: 0o600 });
  expect(await reviews.read({ scope })).toMatchObject({
    state: 'unavailable',
    reasons: ['corrupt'],
  });
  now += 11;
  await reviews.begin({ ...scope, runId: 'mock-new' });
  expect(await reviews.read({ scope })).toMatchObject({ state: 'expired' });
  expect(
    await readFile(
      path.join(root, digest(JSON.stringify({ ...scope, runId: 'mock-new' })), 'head.json'),
      'utf8',
    ),
  ).toContain('capturing-before');
});

test('retention expires on read without needing another task to trigger cleanup', async (t) => {
  const { root } = await fixture(t);
  let now = 1_900_000_000_000;
  const reviews = new FileReviews(root, { now: () => now, maxAge: 10 });
  await reviews.begin(scope);
  await reviews.before(scope, [mockCapture('before')], roots);
  const pointer = await reviews.finish(scope, [mockCapture('after')]);
  now += 11;
  expect(await reviews.read({ scope })).toMatchObject({ state: 'expired' });
  await expect(
    reviews.diff({ scope, revision: pointer.revision, area: 'task', path: 'input.txt' }),
  ).rejects.toThrow('STALE_FILE_REVIEW');
});

test('restart skips an unpublished orphan number without making that report readable', async (t) => {
  const { root, reviews } = await fixture(t);
  const pointer = await reviews.begin(scope);
  const directory = path.join(root, digest(JSON.stringify(scope)));
  const data = JSON.parse(
    await readFile(path.join(directory, `report-${pointer.revision}.json`), 'utf8'),
  ) as Record<string, unknown>;
  await writeFile(
    path.join(directory, `report-${pointer.revision + 1}.json`),
    JSON.stringify({ ...data, revision: pointer.revision + 1 }),
    { mode: 0o600 },
  );
  const reopened = new FileReviews(root);
  await reopened.ready;
  expect(await reopened.read({ scope })).toMatchObject({
    state: 'interrupted',
    revision: pointer.revision + 2,
  });
  await expect(
    reopened.diff({ scope, revision: pointer.revision + 1, area: 'task', path: 'input.txt' }),
  ).rejects.toThrow('STALE_FILE_REVIEW');
});

test('missing retained text under a text budget is not mislabeled as binary content', async (t) => {
  const { reviews } = await fixture(t);
  const before = mockCapture('a'.repeat(300 * 1024));
  const after = mockCapture('b'.repeat(300 * 1024));
  for (const capture of [before, after]) {
    for (const file of capture.files) if (file.state === 'present') file.text = false;
    capture.texts = [];
    capture.snapshot.capture = 'partial';
    capture.snapshot.reasons = ['text-limit'];
  }
  await reviews.begin(scope);
  await reviews.before(scope, [before], roots);
  const pointer = await reviews.finish(scope, [after]);
  expect(
    await reviews.diff({ scope, revision: pointer.revision, area: 'task', path: 'input.txt' }),
  ).toMatchObject({ state: 'unavailable', reason: 'text-limit' });
});
