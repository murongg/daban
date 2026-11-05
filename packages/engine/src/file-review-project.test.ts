import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectScope, ReviewCapture, ReviewFileQuery } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

async function fixture(t: Pick<TestContext, 'onTestFinished'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-review-'));
  const events: string[] = [];
  let pause: (() => Promise<unknown>) | undefined;
  // Capture is the platform boundary: task ownership, project mirrors and RPC guards remain real.
  vi.spyOn(WorkspaceFiles.prototype, 'reviewAvailable', 'get').mockReturnValue(true);
  vi.spyOn(WorkspaceFiles.prototype, 'captureReview').mockImplementation(async function (
    this: WorkspaceFiles,
    paths?: string[],
    signal?: AbortSignal,
  ): Promise<ReviewCapture> {
    signal?.throwIfAborted();
    await this.base();
    events.push(`capture:${this.root}:${paths ? 'shared' : 'task'}`);
    const area = paths ? 'shared' : 'task';
    const at = new Date().toISOString();
    const files: ReviewCapture['files'] = [];
    const texts: ReviewCapture['texts'] = [];
    for (const name of paths ?? (await readdir(this.root))) {
      const bytes = await readFile(path.join(this.root, name));
      files.push({
        area,
        path: name,
        state: 'present',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        text: true,
      });
      texts.push({ area, path: name, data: bytes.toString('base64') });
    }
    await pause?.();
    signal?.throwIfAborted();
    return {
      snapshot: { area, capture: 'complete', startedAt: at, endedAt: at, reasons: [], omitted: 0 },
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      texts: texts.sort((a, b) => a.path.localeCompare(b.path)),
    };
  });
  let service = await startExecutor({
    directory: path.join(root, 'guest'),
    port: 0,
    boot: 'mock-boot',
  });
  const token = (await readFile(path.join(root, 'guest/token'), 'utf8')).trim();
  const execution = new RemoteExecutor({ url: `${service.origin}/exec`, token });
  await execution.ready;
  let sharedRoot = '';
  let models: ModelRuns;
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-session') {
      return {
        id,
        run: async () => {
          events.push('execute');
          await writeFile(
            path.join(models.jobs.get('mock-bot')!.workdir, 'same.txt'),
            'TASK AFTER\n',
          );
          await writeFile(path.join(sharedRoot, 'same.txt'), 'SHARED AFTER\n');
          return { sessionId: id, finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const settings = new ModelSettings(path.join(root, 'settings.json'));
  models = new ModelRuns({
    settings,
    execution,
    dir: path.join(root, 'model'),
    origin: service.origin,
    Harness,
  });
  t.onTestFinished(async () => {
    pause = undefined;
    await models.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await models.ready;
  await settings.save({ apiKey: 'synthetic-review-model-key' });
  await models.profiles.register({
    id: 'mock-bot',
    name: 'SYNTHETIC',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const scopes = ['mock-alpha', 'mock-beta'].map((projectId) => ({ projectId, revision: 1 }));
  for (const scope of scopes) {
    await models.projects.write({
      action: 'create',
      requestId: `create-${scope.projectId}`,
      projectId: scope.projectId,
      expectedRevision: 0,
      value: { name: scope.projectId, grants: [{ bot: 'mock-bot', content: 'write' }] },
    });
    const files = models.filesFor({ project: scope });
    await writeFile(
      path.join(await files.base(), 'same.txt'),
      `${scope.projectId} SHARED BEFORE\n`,
    );
  }
  const legacy = await execution.call<string>('workspace.base', {});
  await writeFile(path.join(legacy, 'same.txt'), 'LEGACY SHARED BEFORE\n');
  for (const method of ['open', 'drain'] as const) {
    const original = models.tools[method].bind(models.tools);
    vi.spyOn(models.tools, method).mockImplementation(async (job) => {
      events.push(method);
      return original(job);
    });
  }
  const start = async (project?: ProjectScope) => {
    sharedRoot = project ? await models.filesFor({ project }).base() : legacy;
    await models.start('mock-bot', {
      requestId: `review-${project?.projectId ?? 'legacy'}`,
      prompt: 'SYNTHETIC REVIEW',
      ...(project ? { project } : {}),
      files: [{ name: 'same.txt', content: 'TASK BEFORE\n' }],
      fileReview: { sharedPaths: ['same.txt'] },
    });
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    const scope = { bot: job.bot, runId: job.id, chatRevision: 0 };
    const page = await models.fileReview({ scope });
    return {
      job,
      scope,
      page,
      query: {
        scope,
        revision: page.revision,
        area: 'shared',
        path: 'same.txt',
      } satisfies ReviewFileQuery,
    };
  };
  const restart = async () => {
    const port = Number(new URL(service.origin).port);
    await service.close();
    service = await startExecutor({
      directory: path.join(root, 'guest'),
      port,
      boot: 'mock-new-boot',
    });
    const nextToken = (await readFile(path.join(root, 'guest/token'), 'utf8')).trim();
    return new RemoteExecutor({ url: `${service.origin}/exec`, token: nextToken });
  };
  return {
    root,
    models,
    execution,
    service,
    token,
    events,
    scopes,
    legacy,
    start,
    restart,
    pause: (next?: () => Promise<unknown>) => {
      pause = next;
    },
  };
}

test('real accepted tasks review two project roots and legacy without aliasing logical task directories', async (t) => {
  const f = await fixture(t);
  for (const project of [...f.scopes, undefined]) {
    f.events.length = 0;
    const { job, page, query } = await f.start(project);
    expect(page.counts).toMatchObject({ modified: 2, unknown: 0 });
    expect(job.executionId).not.toBe(job.id);
    const diff = await f.models.fileReviewDiff(query);
    expect(JSON.stringify(diff)).toContain(
      project ? `${project.projectId} SHARED BEFORE` : 'LEGACY SHARED BEFORE',
    );
    expect(JSON.stringify(diff)).toContain('SHARED AFTER');
    expect(await f.models.fileReviewCurrent(query)).toMatchObject({ state: 'matching' });
    expect(await f.models.fileReviewCurrent({ ...query, area: 'task' })).toMatchObject({
      state: 'matching',
    });
    const captures = f.events.filter((event) => event.startsWith('capture:'));
    expect(captures[0]).toContain(':shared');
    expect(captures[1]).toBe(`capture:${job.workdir}:task`);
    expect(f.events.indexOf(captures[1])).toBeLessThan(f.events.indexOf('open'));
    expect(f.events.indexOf('drain')).toBeLessThan(f.events.lastIndexOf(captures[2]));
    if (project)
      expect(captures.slice(0, 4).every((value) => !value.includes(f.legacy))).toBe(true);
  }
});

test('Stop fences a late project baseline while bounded final observation retains the same owner', async (t) => {
  const f = await fixture(t);
  let arrived: () => unknown = () => {};
  let release: () => unknown = () => {};
  const waiting = new Promise<unknown>((resolve) => {
    arrived = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  f.pause(async () => {
    if (f.events.filter((event) => event.startsWith('capture:')).length === 2) {
      arrived();
      await gate;
    }
  });
  const starting = f.models.start('mock-bot', {
    requestId: 'mock-project-stop',
    prompt: 'SYNTHETIC',
    project: f.scopes[0],
    files: [{ name: 'same.txt', content: 'SYNTHETIC INPUT' }],
    fileReview: { sharedPaths: ['same.txt'] },
  });
  starting.catch(() => undefined);
  await waiting;
  try {
    await f.models.stop('mock-bot');
  } finally {
    release();
  }
  await expect(starting).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
  const job = f.models.jobs.get('mock-bot')!;
  const scope = { bot: job.bot, runId: job.id, chatRevision: 0 };
  const page = await f.models.fileReview({ scope });
  expect(page.before?.find((item) => item.area === 'task')).toMatchObject({
    capture: 'unknown',
    reasons: ['cancelled'],
  });
  expect(page.after?.find((item) => item.area === 'task')).toMatchObject({ capture: 'complete' });
  expect(f.events).not.toContain('execute');
  expect(f.events.every((event) => !event.includes(f.legacy))).toBe(true);
  expect(await f.models.fileReview({ scope })).toEqual(page);
});

test.for(['revision', 'revoke', 'archive'] as const)(
  'review reads retain the original project and deny %s changes',
  async (kind, t) => {
    const f = await fixture(t);
    const { query } = await f.start(f.scopes[0]);
    await f.models.projects.write({
      action: kind === 'archive' ? 'archive' : 'update',
      requestId: `change-${kind}`,
      projectId: 'mock-alpha',
      expectedRevision: 1,
      ...(kind === 'archive'
        ? {}
        : {
            value: {
              name: 'SYNTHETIC CHANGED',
              grants: kind === 'revoke' ? [] : [{ bot: 'mock-bot', content: 'write' as const }],
            },
          }),
    });
    for (const read of [
      () => f.models.fileReview({ scope: query.scope }),
      () => f.models.fileReviewDiff(query),
      () => f.models.fileReviewCurrent(query),
    ])
      await expect(read()).rejects.toMatchObject({ code: 'FILE_REVIEW_NOT_FOUND' });
  },
);

test('authorization is checked again after an awaited current capture', async (t) => {
  const f = await fixture(t);
  const { query } = await f.start(f.scopes[0]);
  let release: () => unknown = () => {};
  let arrived: () => unknown = () => {};
  const waiting = new Promise<unknown>((resolve) => {
    arrived = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  f.pause(async () => {
    arrived();
    await gate;
  });
  const reading = f.models.fileReviewCurrent(query);
  reading.catch(() => undefined);
  await waiting;
  try {
    await f.models.projects.write({
      action: 'update',
      requestId: 'mock-revoke-await',
      projectId: 'mock-alpha',
      expectedRevision: 1,
      value: { name: 'SYNTHETIC REVOKED', grants: [] },
    });
  } finally {
    release();
  }
  await expect(reading).rejects.toMatchObject({ code: 'FILE_REVIEW_NOT_FOUND' });
});

test.for(['read', 'diff'] as const)(
  'authorization is checked again after awaited evidence %s',
  async (method, t) => {
    const f = await fixture(t);
    const { query } = await f.start(f.scopes[0]);
    let release: () => unknown = () => {};
    let arrived: () => unknown = () => {};
    const waiting = new Promise<unknown>((resolve) => {
      arrived = () => resolve(undefined);
    });
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    const delayed = async <T>(value: T) => {
      arrived();
      await gate;
      return value;
    };
    if (method === 'read') {
      const original = f.models.reviews.read.bind(f.models.reviews);
      vi.spyOn(f.models.reviews, 'read').mockImplementation(async (input) =>
        delayed(await original(input)),
      );
    } else {
      const original = f.models.reviews.diff.bind(f.models.reviews);
      vi.spyOn(f.models.reviews, 'diff').mockImplementation(async (input) =>
        delayed(await original(input)),
      );
    }
    const reading =
      method === 'read'
        ? f.models.fileReview({ scope: query.scope })
        : f.models.fileReviewDiff(query);
    reading.catch(() => undefined);
    await waiting;
    try {
      await f.models.projects.write({
        action: 'archive',
        requestId: 'mock-archive-await',
        projectId: 'mock-alpha',
        expectedRevision: 1,
      });
    } finally {
      release();
    }
    await expect(reading).rejects.toMatchObject({ code: 'FILE_REVIEW_NOT_FOUND' });
  },
);

test('guest reconnect rejects the old lease and never substitutes legacy current content', async (t) => {
  const f = await fixture(t);
  const { query, job } = await f.start(f.scopes[0]);
  const before = await f.models.fileReview({ scope: query.scope });
  const current = await f.restart();
  await current.ready;
  await expect(
    f.execution.call('workspace.review.capture', {
      project: { ...f.models.projects.assertScope('mock-bot', f.scopes[0], 'read'), runId: job.id },
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_INVALID_RESPONSE' });
  expect(await f.models.fileReviewCurrent(query)).toMatchObject({ state: 'unknown' });
  expect(await f.models.fileReview({ scope: query.scope })).toEqual(before);
  const reference = {
    ...f.models.projects.assertScope('mock-bot', f.scopes[0], 'read'),
    runId: job.id,
  };
  expect(await current.call('workspace.review.capture', { project: reference })).toMatchObject({
    snapshot: { capture: 'complete' },
  });
});

test('project capture RPC rejects other resources, physical attempt roots, escape paths and old guest leases', async (t) => {
  const f = await fixture(t);
  const { job } = await f.start(f.scopes[0]);
  const binding = f.models.projects.assertScope('mock-bot', f.scopes[0], 'read');
  const project = { ...binding, runId: job.id };
  const capture = (params: Record<string, unknown>) =>
    f.execution.call('workspace.review.capture', params);
  await expect(
    capture({ project, root: job.workdir, canonical: job.canonicalRoot }),
  ).resolves.toMatchObject({ snapshot: { capture: 'complete' } });
  await expect(
    capture({
      project: { ...project, resourceId: f.models.projects.resources('mock-beta').files },
      root: job.workdir,
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' });
  await expect(
    capture({ project: { ...project, runId: job.executionId }, root: job.workdir }),
  ).rejects.toMatchObject({ code: 'EXECUTION_WORKSPACE_SCOPE' });
  await expect(capture({ project, root: f.legacy })).rejects.toMatchObject({
    code: 'EXECUTION_WORKSPACE_SCOPE',
  });
  await expect(capture({ project, paths: ['../same.txt'] })).rejects.toMatchObject({
    code: 'EXECUTION_INVALID_REQUEST',
  });
  const response = await fetch(`${f.service.origin}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-daban-execution-token': f.token },
    body: JSON.stringify({
      role: 'executor',
      version: 1,
      id: 'mock-old-lease',
      boot: 'mock-boot',
      nonce: 'mock-retired-nonce',
      method: 'workspace.review.capture',
      params: { project },
    }),
  });
  expect(await response.json()).toMatchObject({ ok: false, error: 'EXECUTION_GUEST_RESTARTED' });
});
