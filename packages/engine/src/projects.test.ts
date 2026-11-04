import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Projects } from './projects.js';
import { startPrototype } from './server.js';
import { TaskJournal, validateTask } from './tasks.js';

test('host task validation preserves an explicit project and rejects malformed authority', () => {
  const legacy = { requestId: 'mock-task', prompt: 'SYNTHETIC TASK' };
  const task = { ...legacy, project: { projectId: 'mock-project', revision: 1 } };
  expect(validateTask(task)).toStrictEqual(task);
  expect(validateTask(legacy)).toStrictEqual(legacy);
  for (const project of [
    null,
    {},
    { projectId: '../other', revision: 1 },
    { projectId: 'mock-project', revision: 0 },
    { projectId: 'mock-project', revision: 1.5 },
    { projectId: 'mock-project', revision: 1, human: true },
  ])
    expect(() => validateTask({ ...legacy, project })).toThrow();
});

test('an unavailable project database refuses scoped work while legacy task receipts remain queryable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-unavailable-'));
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'model/projects.sqlite'), 'SYNTHETIC NOT A DATABASE', {
    mode: 0o600,
  });
  const journal = new TaskJournal(path.join(root, 'model/task-journal'));
  await journal.load();
  await journal.put({
    bot: 'mock-bot',
    runId: 'mock-run',
    requestId: 'mock-request',
    prompt: 'SYNTHETIC',
    result: 'SYNTHETIC RESULT',
    phase: 'completed',
    running: false,
    error: '',
    trace: [],
  });
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  t.onTestFinished(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  expect(app.models!.findRequest('mock-bot', 'mock-request')).toMatchObject({
    phase: 'completed',
    result: 'SYNTHETIC RESULT',
  });
  const response = await fetch(`${app.url}/api/projects/list`, {
    method: 'POST',
    headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'PROJECT_STORE_UNAVAILABLE' });
});

test('authenticated project creation keeps content and browser grants independent and receipts durable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-projects-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  t.onTestFinished(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const id of ['mock-reader', 'mock-writer'])
    await app.models!.profiles.register({
      id,
      name: id,
      instructions: '',
      memory: '',
      color: 'mint',
    });
  const request = {
    requestId: 'mock-create',
    projectId: 'mock-project',
    action: 'create',
    expectedRevision: 0,
    value: {
      name: 'SYNTHETIC PROJECT',
      grants: [{ bot: 'mock-reader' }, { bot: 'mock-writer', content: 'write', browser: true }],
    },
  };
  const call = async (route: string, value: unknown, token = app.token) => {
    const response = await fetch(`${app.url}/api/projects/${route}`, {
      method: 'POST',
      headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    const result: unknown = await response.json();
    return { status: response.status, value: result };
  };
  expect((await call('write', { request }, 'mock-denied')).status).toBe(403);
  const created = await call('write', { request });
  expect(created).toMatchObject({
    status: 200,
    value: {
      state: 'complete',
      project: {
        id: 'mock-project',
        revision: 1,
        status: 'active',
        environment: { files: 'project', browser: 'private' },
        grants: [
          { bot: 'mock-reader', content: 'read', browser: false },
          { bot: 'mock-writer', content: 'write', browser: true },
        ],
      },
    },
  });
  expect(await call('write', { request })).toStrictEqual(created);
  expect(
    (await call('write', { request: { ...request, value: { ...request.value, name: 'OTHER' } } }))
      .value,
  ).toMatchObject({ error: 'PROJECT_REQUEST_REUSED' });
  expect((await call('write', { request, actor: 'human' })).status).toBe(400);
  await app.close();
  app = await startPrototype(options);
  expect(await call('receipt', { requestId: request.requestId })).toStrictEqual(created);
});

test('the project owner rejects stale, nonmember and independent browser access and commits reductions while busy', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-access-'));
  let busy = false;
  const owner = new Projects(path.join(root, 'projects.sqlite'), { busy: () => busy });
  t.onTestFinished(async () => {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  await owner.ready;
  const value = {
    name: 'SYNTHETIC',
    grants: [
      { bot: 'mock-reader' },
      { bot: 'mock-writer', content: 'write' as const, browser: true },
    ],
  };
  await owner.write({
    action: 'create',
    requestId: 'mock-create',
    projectId: 'mock-project',
    expectedRevision: 0,
    value,
  });
  const scope = { projectId: 'mock-project', revision: 1 };
  expect(owner.assertScope('mock-reader', scope, 'read').resourceId).toBeTruthy();
  for (const [bot, access] of [
    ['mock-reader', 'write'],
    ['mock-reader', 'browser'],
    ['mock-outsider', 'read'],
  ] as const)
    expect(() => owner.assertScope(bot, scope, access)).toThrow(
      expect.objectContaining({ code: 'PROJECT_ACCESS_DENIED' }),
    );
  expect(owner.assertScope('mock-writer', scope, 'read').resourceId).toBe(
    owner.assertScope('mock-writer', scope, 'write').resourceId,
  );
  busy = true;
  await expect(
    owner.write({
      action: 'update',
      requestId: 'mock-rename-busy',
      projectId: scope.projectId,
      expectedRevision: 1,
      value: { ...value, name: 'SYNTHETIC RENAMED' },
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await expect(
    owner.write({
      action: 'update',
      requestId: 'mock-busy',
      projectId: scope.projectId,
      expectedRevision: 1,
      value: { ...value, browser: 'project' },
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  await owner.write({
    action: 'update',
    requestId: 'mock-revoke',
    projectId: scope.projectId,
    expectedRevision: 1,
    value: { name: value.name, grants: [{ bot: 'mock-reader' }] },
  });
  expect(() => owner.assertScope('mock-writer', scope, 'read')).toThrow(
    expect.objectContaining({ code: 'PROJECT_SCOPE_STALE' }),
  );
  expect(() => owner.assertScope('mock-writer', { ...scope, revision: 2 }, 'read')).toThrow(
    expect.objectContaining({ code: 'PROJECT_ACCESS_DENIED' }),
  );
  busy = false;
  await owner.write({
    action: 'archive',
    requestId: 'mock-archive',
    projectId: scope.projectId,
    expectedRevision: 2,
  });
  expect(() => owner.assertHumanScope({ ...scope, revision: 3 })).toThrow(
    expect.objectContaining({ code: 'PROJECT_ARCHIVED' }),
  );
  expect((await owner.receipt('mock-create')).state).toBe('complete');
});

test('an unknown resource preparation keeps its receipt and prevents a competing binding', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-preparation-'));
  let offline = true;
  const prepared: string[] = [];
  const owner = new Projects(path.join(root, 'projects.sqlite'), {
    prepare: async (resources) => {
      prepared.push(resources.files);
      if (offline) throw Error('MOCK OFFLINE');
    },
  });
  t.onTestFinished(async () => {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  await owner.ready;
  const request = {
    action: 'create',
    requestId: 'mock-create',
    projectId: 'mock-project',
    expectedRevision: 0,
    value: { name: 'SYNTHETIC', grants: [] },
  };
  expect(await owner.write(request)).toMatchObject({ state: 'preparing' });
  expect(owner.list()).toStrictEqual([]);
  await expect(owner.write({ ...request, requestId: 'mock-competing' })).rejects.toMatchObject({
    code: 'PROJECT_BUSY',
  });
  offline = false;
  expect(await owner.resume('mock-create')).toMatchObject({ state: 'complete' });
  expect(prepared).toHaveLength(2);
  expect(new Set(prepared).size).toBe(1);
  await owner.resume('mock-create');
  expect(prepared).toHaveLength(2);
});

test('offline revocations supersede older preparations and recovery never restores a revoked grant', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-offline-'));
  let offline = false;
  const file = path.join(root, 'projects.sqlite');
  let owner = new Projects(file, {
    prepare: async () => {
      if (offline) throw Error('MOCK OFFLINE');
    },
  });
  t.onTestFinished(async () => {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  await owner.ready;
  const value = { name: 'SYNTHETIC', grants: [{ bot: 'mock-a' }, { bot: 'mock-b' }] };
  await owner.write({
    action: 'create',
    requestId: 'mock-create',
    projectId: 'mock-project',
    expectedRevision: 0,
    value,
  });
  offline = true;
  await owner.write({
    action: 'update',
    requestId: 'mock-revoke-a',
    projectId: 'mock-project',
    expectedRevision: 1,
    value: { ...value, grants: [{ bot: 'mock-b' }] },
  });
  expect(() =>
    owner.assertScope('mock-a', { projectId: 'mock-project', revision: 2 }, 'read'),
  ).toThrow();
  expect(
    await owner.write({
      action: 'update',
      requestId: 'mock-revoke-b',
      projectId: 'mock-project',
      expectedRevision: 2,
      value: { ...value, grants: [] },
    }),
  ).toMatchObject({ state: 'preparing' });
  await owner.close();
  offline = false;
  owner = new Projects(file);
  await owner.ready;
  expect(owner.get('mock-project')).toMatchObject({ revision: 3, grants: [] });
  expect(await owner.receipt('mock-revoke-a')).toMatchObject({ state: 'failed' });
  expect(await owner.receipt('mock-revoke-b')).toMatchObject({ state: 'complete' });
});
