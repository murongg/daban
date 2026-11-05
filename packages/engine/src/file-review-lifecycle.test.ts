import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReviewCapture } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { FileReviews } from './file-review.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

interface Barrier {
  wait: Promise<unknown>;
  arrived: Promise<unknown>;
  entered(): unknown;
  release(): unknown;
  reject(error: Error): unknown;
}
const io = vi.hoisted(() => ({
  directories: new Map<string, Barrier>(),
  writes: new Map<string, Barrier & { stage: 'report' | 'head' }>(),
}));
vi.mock('./private-files.js', async (original) => {
  const actual = await original<typeof import('./private-files.js')>();
  return {
    ...actual,
    secureDirectory: async (...args: Parameters<typeof actual.secureDirectory>) => {
      const barrier = io.directories.get(args[0]);
      if (barrier) {
        barrier.entered();
        await barrier.wait;
      }
      return actual.secureDirectory(...args);
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const file = args[0];
      if (typeof file === 'string') {
        for (const [directory, barrier] of io.writes) {
          if (
            file.startsWith(directory + path.sep) &&
            path.basename(file).startsWith(barrier.stage === 'report' ? 'report-' : 'head.json.')
          ) {
            barrier.entered();
            await barrier.wait;
          }
        }
      }
      return actual.writeFile(...args);
    },
  };
});

function barrier(): Barrier {
  let release: () => unknown = () => {};
  let reject: (error: Error) => unknown = () => {};
  let entered: () => unknown = () => {};
  const wait = new Promise<unknown>((resolve, fail) => {
    release = () => resolve(undefined);
    reject = fail;
  });
  const arrived = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  return {
    wait,
    arrived,
    entered: () => entered(),
    release: () => release(),
    reject: (error) => reject(error),
  };
}
async function fixture(t: Pick<TestContext, 'onTestFinished'>, pauseInitialization = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-review-lifecycle-'));
  const directory = path.join(root, 'model', 'file-reviews');
  const initialization = barrier();
  const pending: Promise<unknown>[] = [];
  if (pauseInitialization) io.directories.set(directory, initialization);
  const models = new ModelRuns({
    settings: new ModelSettings(path.join(root, 'credentials.json')),
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  });
  const state = { expectedCloseError: undefined as Error | undefined };
  t.onTestFinished(async () => {
    initialization.release();
    io.writes.get(directory)?.release();
    await Promise.allSettled(pending);
    await models.reviews.ready.catch(() => undefined);
    try {
      await models.close();
    } catch (error) {
      if (error !== state.expectedCloseError) throw error;
    } finally {
      io.directories.delete(directory);
      io.writes.delete(directory);
      await rm(root, { recursive: true, force: true });
    }
  });
  const watch = <T>(promise: Promise<T>) => {
    pending.push(promise);
    // Keep the original promise for assertions while the injected IO boundary is held.
    promise.catch(() => undefined);
    return promise;
  };
  return { root, directory, models, initialization, watch, state };
}
const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const roots = { task: { root: '/synthetic/task', canonical: '/synthetic/task' } };
function capture(text: string): ReviewCapture {
  return {
    snapshot: {
      area: 'task',
      capture: 'complete',
      reasons: [],
      omitted: 0,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
    },
    files: [
      {
        area: 'task',
        path: 'mock.txt',
        state: 'present',
        text: true,
        bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
      },
    ],
    texts: [{ area: 'task', path: 'mock.txt', data: Buffer.from(text).toString('base64') }],
  };
}
async function pendingAfterTurn(promise: Promise<unknown>) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<unknown>((resolve) => setImmediate(() => resolve(undefined)));
  expect(settled).toBe(false);
}

test('model shutdown waits for real review-directory initialization before releasing its owner', async (t) => {
  const f = await fixture(t, true);
  await f.models.ready;
  await f.initialization.arrived;
  const closing = f.watch(f.models.close());
  await pendingAfterTurn(closing);
  f.initialization.release();
  await closing;
});

test('shutdown drains all writes accepted during initialization, including a failed write and its successors', async (t) => {
  const f = await fixture(t, true);
  await f.models.ready;
  await f.initialization.arrived;
  const begun = f.watch(f.models.reviews.begin(scope));
  const forged = capture('SYNTHETIC FORGED');
  forged.texts[0].data = Buffer.from('SYNTHETIC MISMATCH').toString('base64');
  const rejected = f.watch(f.models.reviews.before(scope, [forged], roots));
  const before = f.watch(f.models.reviews.before(scope, [capture('SYNTHETIC BEFORE')], roots));
  const after = f.watch(f.models.reviews.finish(scope, [capture('SYNTHETIC AFTER')]));
  const closing = f.watch(f.models.close());
  await pendingAfterTurn(closing);
  f.initialization.release();
  await begun;
  await expect(rejected).rejects.toThrow();
  await Promise.all([before, after, closing]);
  const reopened = new FileReviews(f.directory);
  expect(await reopened.read({ scope })).toMatchObject({
    state: 'complete',
    counts: { modified: 1 },
  });
});

test('an accepted read-time expiration cannot outlive shutdown or lose its authorization store', async (t) => {
  const f = await fixture(t);
  await f.models.ready;
  await f.models.reviews.begin(scope);
  await f.models.reviews.before(scope, [capture('SYNTHETIC BEFORE')], roots);
  await f.models.reviews.finish(scope, [capture('SYNTHETIC AFTER')]);
  const [run] = await readdir(f.directory);
  const head = path.join(f.directory, run, 'head.json');
  const saved: object = JSON.parse(await readFile(head, 'utf8'));
  await writeFile(head, JSON.stringify({ ...saved, terminalAt: 0 }), { mode: 0o600 });
  const writing = Object.assign(barrier(), { stage: 'head' as const });
  io.writes.set(f.directory, writing);
  const reading = f.watch(f.models.reviews.read({ scope }));
  await writing.arrived;
  const projectsClosed = vi.spyOn(f.models.projects, 'close');
  const closing = f.watch(f.models.close());
  await pendingAfterTurn(closing);
  expect(projectsClosed).not.toHaveBeenCalled();
  writing.release();
  expect(await reading).toMatchObject({ state: 'expired' });
  await closing;
  expect(projectsClosed).toHaveBeenCalledOnce();
});

test('closed review owners refuse new writes and reads without recreating deleted evidence', async (t) => {
  const f = await fixture(t);
  await f.models.ready;
  await f.models.reviews.ready;
  await f.models.close();
  await rm(f.directory, { recursive: true, force: true });
  await expect(f.models.reviews.begin(scope)).rejects.toMatchObject({ code: 'FILE_REVIEW_CLOSED' });
  await expect(f.models.reviews.read({ scope })).rejects.toMatchObject({
    code: 'FILE_REVIEW_CLOSED',
  });
  await expect(readdir(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await f.models.close();
});

test('close seals admission immediately while an accepted publication is still held', async (t) => {
  const f = await fixture(t);
  await f.models.ready;
  await f.models.reviews.ready;
  const writing = Object.assign(barrier(), { stage: 'report' as const });
  io.writes.set(f.directory, writing);
  const publication = f.watch(f.models.reviews.begin(scope));
  await writing.arrived;
  const closing = f.watch(f.models.reviews.close());
  await expect(f.models.reviews.begin({ ...scope, runId: 'mock-late' })).rejects.toMatchObject({
    code: 'FILE_REVIEW_CLOSED',
  });
  await expect(f.models.reviews.read({ scope })).rejects.toMatchObject({
    code: 'FILE_REVIEW_CLOSED',
  });
  await pendingAfterTurn(closing);
  writing.release();
  await Promise.all([publication, closing]);
});

test('review initialization failure is preserved while all later model stores still close', async (t) => {
  const f = await fixture(t, true);
  await f.models.ready;
  await f.initialization.arrived;
  const error = new Error('SYNTHETIC REVIEW INITIALIZATION FAILURE');
  f.state.expectedCloseError = error;
  const projectsClosed = vi.spyOn(f.models.projects, 'close');
  const chatsClosed = vi.spyOn(f.models.chats, 'close');
  const closing = f.watch(f.models.close());
  f.initialization.reject(error);
  await expect(closing).rejects.toBe(error);
  expect(projectsClosed).toHaveBeenCalledOnce();
  expect(chatsClosed).toHaveBeenCalledOnce();
});
