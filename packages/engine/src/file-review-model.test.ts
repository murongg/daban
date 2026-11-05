import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReviewCapture } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { FileReviews } from './file-review.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

async function fixture(
  t: Pick<TestContext, 'onTestFinished'>,
  options: {
    prepareFail?: boolean;
    stop?: boolean;
    captureFail?: boolean;
    stageFail?: boolean;
    pauseBefore?: Promise<unknown>;
    pauseBase?: Promise<unknown>;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-model-'));
  const events: string[] = [];
  const phases: string[] = [];
  let models: ModelRuns;
  class Workspace extends WorkspaceFiles {
    get reviewAvailable() {
      return true;
    }
    async base() {
      if (
        options.pauseBase &&
        models?.jobs.get('a')?.running &&
        this.root === path.join(root, 'shared')
      ) {
        events.push('base');
        await options.pauseBase;
      }
      return super.base();
    }
    scope(root: string, canonical?: string) {
      return new Workspace(root, canonical);
    }
    async create(parts: string[]) {
      const directory = await super.create(parts);
      if (!options.stageFail) return directory;
      vi.spyOn(directory, 'write').mockRejectedValue(new Error('MOCK_STAGE_FAILURE'));
      return directory;
    }
    async captureReview(paths?: string[], signal?: AbortSignal): Promise<ReviewCapture> {
      events.push(paths ? 'shared' : 'task');
      const job = models.jobs.get('a');
      if (job)
        phases.push(
          (await models.reviews.read({ scope: { bot: 'a', runId: job.id, chatRevision: 0 } }))
            .state,
        );
      if (options.captureFail && events.filter((event) => event === 'task').length === 1)
        throw Error('MOCK_CAPTURE_FAILED');
      if (options.pauseBefore && events.filter((event) => event === 'task').length === 1)
        await options.pauseBefore;
      expect(signal?.aborted).toBe(false);
      const area = paths ? 'shared' : 'task';
      const name = paths?.[0] ?? 'input.txt';
      const data = await readFile(path.join(this.root, name)).catch(() => undefined);
      const at = new Date().toISOString();
      return {
        snapshot: {
          area,
          capture: 'complete',
          reasons: [],
          omitted: 0,
          startedAt: at,
          endedAt: at,
        },
        files: data
          ? [
              {
                area,
                path: name,
                state: 'present',
                bytes: data.length,
                sha256: createHash('sha256').update(data).digest('hex'),
                text: true,
              },
            ]
          : [],
        texts: data ? [{ area, path: name, data: data.toString('base64') }] : [],
      };
    }
  }
  const settings = new ModelSettings(path.join(root, 'settings.json'));
  await settings.save({ apiKey: 'mock-review-key-0123456789' });
  class Harness {
    async start() {
      if (options.prepareFail) throw new Error('MOCK_START_FAILURE');
    }
    async close() {}
    session(id = 'mock-session') {
      return {
        id,
        run: async () => {
          events.push('execute');
          if (options.stop)
            await new Promise((resolve) => {
              models.jobs.get('a')!.abort.signal.addEventListener('abort', resolve, { once: true });
            });
          else await writeFile(path.join(models.jobs.get('a')!.workdir, 'input.txt'), 'after\n');
          return { sessionId: id, finalResponse: 'Synthetic result.' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  models = new ModelRuns({
    settings,
    workspace: new Workspace(path.join(root, 'shared')),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  t.onTestFinished(async () => {
    await models.close();
    await rm(root, { recursive: true, force: true });
  });
  await models.ready;
  await writeFile(path.join(root, 'shared', 'selected.txt'), 'shared-before\n');
  const open = models.tools.open.bind(models.tools);
  vi.spyOn(models.tools, 'open').mockImplementation(async (job) => {
    events.push('open');
    return open(job);
  });
  const drain = models.tools.drain.bind(models.tools);
  vi.spyOn(models.tools, 'drain').mockImplementation(async (job) => {
    events.push('drain');
    return drain(job);
  });
  return { models, root, events, phases };
}
test('captures shared then staged inputs before tools open and after drain without attributing writers', async (t) => {
  const { models, events, phases } = await fixture(t);
  const task = {
    requestId: 'mock-request',
    prompt: 'Synthetic work.',
    files: [{ name: 'input.txt', content: 'before\n' }],
  };
  await models.start('a', task);
  await models.jobs.get('a')!.done;
  expect(events).toEqual(['task', 'open', 'execute', 'drain', 'task']);
  expect(phases).toEqual(['capturing-before', 'capturing-after']);
});

test('Stop fences a late baseline even when an adapter ignores its abort signal', async (t) => {
  let release: () => unknown = () => {};
  const pauseBefore = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const { models, events } = await fixture(t, { pauseBefore });
  const starting = models
    .start('a', {
      requestId: 'mock-late-baseline',
      prompt: 'Synthetic work.',
      files: [{ name: 'input.txt', content: 'before\n' }],
    })
    .catch((error: unknown) => error);
  await expect.poll(() => events.includes('task')).toBe(true);
  const stopping = models.stop('a');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    stopping.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  if (timer) clearTimeout(timer);
  release();
  await starting;
  await stopping;
  expect(early).toBe(true);
  const job = models.jobs.get('a')!;
  const page = await models.fileReview({ scope: { bot: 'a', runId: job.id, chatRevision: 0 } });
  expect(page.before?.[0]).toMatchObject({ capture: 'unknown', reasons: ['cancelled'] });
  expect(events).not.toContain('open');
});

test('capture failure preserves task completion while a preparation failure preserves its original error', async (t) => {
  const good = await fixture(t, { captureFail: true });
  await good.models.start('a', {
    requestId: 'mock-capture-failure',
    prompt: 'Synthetic work.',
    files: [{ name: 'input.txt', content: 'before\n' }],
  });
  const job = good.models.jobs.get('a')!;
  await job.done;
  expect(job.phase).toBe('completed');
  expect(
    await good.models.fileReview({ scope: { bot: 'a', runId: job.id, chatRevision: 0 } }),
  ).toMatchObject({ counts: { unknown: 1 } });
  const failed = await fixture(t, { stageFail: true });
  await expect(
    failed.models.start('a', {
      requestId: 'mock-prepare-failure',
      prompt: 'Synthetic work.',
      files: [{ name: 'input.txt', content: 'before\n' }],
    }),
  ).rejects.toThrow('MOCK_STAGE_FAILURE');
  const failedJob = failed.models.jobs.get('a')!;
  expect(failedJob.phase).toBe('failed');
  expect(failedJob.error).toBe('MODEL_START_FAILED');
  expect(failed.events).toEqual(['drain', 'task']);
  expect(
    await failed.models.fileReview({ scope: { bot: 'a', runId: failedJob.id, chatRevision: 0 } }),
  ).toMatchObject({ state: 'complete', reasons: expect.arrayContaining(['baseline-missing']) });
});
test('a stopped run still attempts final capture with a fresh signal', async (t) => {
  const { models, events } = await fixture(t, { stop: true });
  await models.start('a', {
    requestId: 'mock-stop',
    prompt: 'Synthetic work.',
    files: [{ name: 'input.txt', content: 'before\n' }],
  });
  await expect.poll(() => events.includes('execute')).toBe(true);
  await models.stop('a');
  expect(events.filter((event) => event === 'task')).toHaveLength(2);
});

test('host shutdown preserves the stopped task end observation before closing review admission', async (t) => {
  const { models, events } = await fixture(t, { stop: true });
  await models.start('a', {
    requestId: 'mock-shutdown-review',
    prompt: 'Synthetic work.',
    files: [{ name: 'input.txt', content: 'SYNTHETIC INPUT' }],
  });
  await expect.poll(() => events.includes('execute')).toBe(true);
  const job = models.jobs.get('a')!;
  await models.close();
  expect(job.phase).toBe('stopped');
  expect(events.indexOf('drain')).toBeLessThan(events.lastIndexOf('task'));
  const reopened = new FileReviews(models.reviews.directory);
  const page = await reopened.read({ scope: { bot: 'a', runId: job.id, chatRevision: 0 } });
  expect(page).toMatchObject({ state: 'complete' });
  expect(page.after?.find((entry) => entry.area === 'task')).toMatchObject({ capture: 'complete' });
});
test('shared selection is request identity and cannot be silently replaced on duplicate admission', async (t) => {
  const { models, events } = await fixture(t);
  const task = {
    requestId: 'mock-shared',
    prompt: 'Synthetic work.',
    fileReview: { sharedPaths: ['selected.txt'] },
  };
  await models.start('a', task);
  await models.jobs.get('a')!.done;
  expect(events[0]).toBe('shared');
  await expect(
    models.start('a', { ...task, fileReview: { sharedPaths: ['other.txt'] } }),
  ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
});

test('storage exhaustion is explicit without changing the successful task outcome', async (t) => {
  const { models } = await fixture(t);
  models.reviews.options.maxBytes = 6000;
  await models.start('a', {
    requestId: 'mock-storage-limit',
    prompt: 'Synthetic work.',
    files: [{ name: 'input.txt', content: 'x'.repeat(6000) }],
  });
  const job = models.jobs.get('a')!;
  await job.done;
  expect(job.phase).toBe('completed');
  expect(
    await models.fileReview({ scope: { bot: 'a', runId: job.id, chatRevision: 0 } }),
  ).toMatchObject({
    state: 'unavailable',
    reasons: expect.arrayContaining(['storage-limit']),
  });
});

test('initial report quota exhaustion preserves a successful task and the durable storage-limit reason', async (t) => {
  const { models } = await fixture(t);
  models.reviews.options.maxBytes = 2000;
  await models.start('a', { requestId: 'mock-initial-storage-limit', prompt: 'Synthetic work.' });
  const job = models.jobs.get('a')!;
  await job.done;
  expect(job.phase).toBe('completed');
  expect(
    await models.fileReview({ scope: { bot: 'a', runId: job.id, chatRevision: 0 } }),
  ).toMatchObject({
    state: 'unavailable',
    reasons: expect.arrayContaining(['storage-limit']),
    items: [],
  });
  expect((await models.journal.read('a', job.id))?.fileReview).toMatchObject({
    state: 'unavailable',
  });
});

test('Stop also fences a stalled shared root lookup before capture is dispatched', async (t) => {
  let release: () => unknown = () => {};
  const pauseBase = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const { models, events } = await fixture(t, { pauseBase });
  const starting = models
    .start('a', {
      requestId: 'mock-stalled-base',
      prompt: 'Synthetic work.',
      fileReview: { sharedPaths: ['selected.txt'] },
    })
    .catch((error: unknown) => error);
  await expect.poll(() => events.includes('base')).toBe(true);
  const stopping = models.stop('a');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    stopping.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  if (timer) clearTimeout(timer);
  release();
  await starting;
  await stopping;
  expect(early).toBe(true);
  expect(events).not.toContain('open');
  expect(events).not.toContain('shared');
});
