import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isWorkItem, isWorkReceipt, managedProtocol } from '@daban/protocol';
import { Fault } from './control.js';
import { startPrototype } from './server.js';

const request = {
  id: 'mock-human-create',
  item: 'mock-shared-work',
  action: 'create',
  revision: 0,
  value: { title: '  合成共享待办  ', description: 'MOCK DETAIL', progress: '', status: 'todo' },
};
const actor = { kind: 'human' };
function channel(app: Awaited<ReturnType<typeof startPrototype>>) {
  return async (
    action: string,
    input: unknown,
    options: { token?: string; query?: string; method?: string } = {},
  ) => {
    const method = options.method ?? 'POST';
    const response = await fetch(`${app.url}/api/work/${action}${options.query ?? ''}`, {
      method,
      headers: {
        'x-prototype-token': options.token ?? app.token,
        'content-type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
}

test('shared-work HTTP owns human provenance, closes routes and never starts a Bot or screen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = channel(app);
  try {
    assert.equal((await call('write', request, { token: 'mock-denied' })).status, 403);
    for (const action of ['list', 'read', 'write', 'receipt']) {
      assert.equal((await call(action, {}, { method: 'GET' })).status, 405);
      assert.equal((await call(action, {}, { query: '?extra=1' })).status, 400);
    }
    for (const invalid of [
      { ...request, actor: { kind: 'bot', bot: 'mock-forged' } },
      { ...request, value: { ...request.value, createdBy: actor } },
      { ...request, item: '../mock-private' },
    ])
      assert.equal((await call('write', invalid)).status, 400);
    assert.equal((await call('list', { filter: ['all'] })).status, 400);
    assert.equal((await call('read', { id: request.item, bot: 'mock-alpha' })).status, 400);
    assert.deepEqual((await call('receipt', request)).value, { state: 'unknown', request, actor });
    const created = await call('write', request);
    assert.equal(created.status, 200);
    assert.ok(isWorkReceipt(created.value) && created.value.state === 'complete');
    assert.equal(created.value.item.title, request.value.title.trim());
    assert.deepEqual(created.value.item.createdBy, actor);
    assert.deepEqual((await call('read', { id: request.item })).value, created.value.item);
    const listed = await call('list', { filter: 'open', limit: 1 });
    const { description: _description, ...summary } = created.value.item;
    assert.deepEqual(listed.value, {
      query: { filter: 'open', limit: 1 },
      page: { revision: 1, items: [{ ...summary, progressTruncated: false }] },
    });
    const state = await (
      await fetch(`${app.url}/api/state`, {
        headers: {
          'x-prototype-token': app.token,
          'x-daban-client-protocol': String(managedProtocol),
        },
      })
    ).json();
    assert.ok(state.clientProtocol >= 36);
    assert.deepEqual(state.work, { available: true, revision: 1, count: 1 });
    assert.deepEqual(state.bots, {});
    assert.deepEqual(state.computers.items, []);
    assert.equal(app.models?.jobs.size, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP work receipts survive restart and preserve subsequent CAS edits, trash and restore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-restart-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  try {
    let call = channel(app);
    assert.equal((await call('write', request)).status, 200);
    const update = {
      id: 'mock-progress',
      item: request.item,
      action: 'update',
      revision: 1,
      value: { progress: 'MOCK CHECKED RESULT', status: 'done' },
    };
    assert.equal((await call('write', update)).status, 200);
    const stale = await call('write', { ...update, id: 'mock-stale-edit' });
    assert.equal(stale.value.error, 'WORK_CONFLICT');
    assert.equal(
      (await call('write', { ...request, value: { ...request.value, title: '合成不同意图' } }))
        .value.error,
      'WORK_REQUEST_CONFLICT',
    );
    const trashed = await call('write', {
      id: 'mock-trash',
      item: request.item,
      revision: 2,
      action: 'trash',
    });
    assert.ok(isWorkReceipt(trashed.value) && trashed.value.state === 'complete');
    await app.close();
    app = await startPrototype(options);
    call = channel(app);
    for (const action of ['write', 'receipt']) {
      const replay = (await call(action, request)).value;
      assert.ok(isWorkReceipt(replay) && replay.state === 'complete');
      assert.equal(replay.acceptedRevision, 1);
      assert.deepEqual(replay.item, trashed.value.item);
    }
    assert.deepEqual((await call('list', {})).value.page.items, []);
    assert.equal((await call('list', { filter: 'trash' })).value.page.items.length, 1);
    const restored = await call('write', {
      id: 'mock-restore',
      item: request.item,
      revision: 3,
      action: 'restore',
    });
    assert.ok(isWorkReceipt(restored.value) && restored.value.state === 'complete');
    assert.equal(restored.value.item.deleted, false);
    assert.equal(restored.value.item.completedAt, trashed.value.item.completedAt);
    assert.equal(app.models?.jobs.size, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('coordinated recovery permits only work readers and receipt inspection, without reservations or effects', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-recovery-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = channel(app);
  try {
    await call('write', request);
    assert.ok(app.recovery);
    t.mock.method(app.recovery, 'admit', () => false);
    const enter = t.mock.method(app.recovery, 'enter', () => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    assert.equal((await call('list', {})).status, 200);
    assert.ok(isWorkItem((await call('read', { id: request.item })).value));
    assert.equal((await call('receipt', request)).value.state, 'complete');
    assert.equal(enter.mock.callCount(), 0);
    assert.equal(
      (
        await call('write', {
          id: 'mock-recovery-edit',
          item: request.item,
          action: 'update',
          revision: 1,
          value: { title: '合成拒绝修改' },
        })
      ).value.error,
      'RUNTIME_RECOVERY_PENDING',
    );
    assert.equal((await call('read', { id: request.item })).value.revision, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt work storage is reported separately and preserved while ordinary Agent service remains ready', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-corrupt-'));
  const file = path.join(root, 'model/work.sqlite');
  await mkdir(path.dirname(file), { mode: 0o700 });
  const original = Buffer.from('MOCK CORRUPT WORK STORAGE');
  await writeFile(file, original, { mode: 0o600 });
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    const state = await (
      await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.deepEqual(state.work, { available: false, error: 'WORK_CORRUPT' });
    assert.equal(state.mode, 'agent');
    assert.equal((await channel(app)('write', request)).value.error, 'WORK_CORRUPT');
    assert.equal((await channel(app)('list', {})).value.error, 'WORK_CORRUPT');
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual(await app.models?.profiles.list(), []);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime shutdown closes work and later stores even when another data owner fails', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-close-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  assert.ok(app.models);
  const models = app.models;
  const closeKnowledge = models.knowledge.close.bind(models.knowledge);
  const closeChats = t.mock.method(models.chats, 'close', models.chats.close.bind(models.chats));
  t.mock.method(models.knowledge, 'close', async () => {
    await closeKnowledge();
    throw new Fault('MOCK_CLOSE_FAILURE');
  });
  try {
    assert.equal((await models.work.status()).available, true);
    await assert.rejects(app.close(), /MOCK_CLOSE_FAILURE/);
    assert.deepEqual(await models.work.status(), { available: false, error: 'WORK_CLOSED' });
    assert.equal(closeChats.mock.callCount(), 1);
    await assert.rejects(models.work.write(request, actor), /WORK_CLOSED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
