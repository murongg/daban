import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isWorkItem, isWorkReceipt, managedProtocol } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
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
    expect((await call('write', request, { token: 'mock-denied' })).status).toBe(403);
    for (const action of ['list', 'read', 'write', 'receipt']) {
      expect((await call(action, {}, { method: 'GET' })).status).toBe(405);
      expect((await call(action, {}, { query: '?extra=1' })).status).toBe(400);
    }
    for (const invalid of [
      { ...request, actor: { kind: 'bot', bot: 'mock-forged' } },
      { ...request, value: { ...request.value, createdBy: actor } },
      { ...request, item: '../mock-private' },
    ])
      expect((await call('write', invalid)).status).toBe(400);
    expect((await call('list', { filter: ['all'] })).status).toBe(400);
    expect((await call('read', { id: request.item, bot: 'mock-alpha' })).status).toBe(400);
    expect((await call('receipt', request)).value).toStrictEqual({
      state: 'unknown',
      request,
      actor,
    });
    const created = await call('write', request);
    expect(created.status).toBe(200);
    expect.assert(isWorkReceipt(created.value) && created.value.state === 'complete');
    expect(created.value.item.title).toBe(request.value.title.trim());
    expect(created.value.item.createdBy).toStrictEqual(actor);
    expect((await call('read', { id: request.item })).value).toStrictEqual(created.value.item);
    const listed = await call('list', { filter: 'open', limit: 1 });
    const { description: _description, ...summary } = created.value.item;
    expect(listed.value).toStrictEqual({
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
    expect.assert(state.clientProtocol >= 36);
    expect(state.work).toStrictEqual({ available: true, revision: 1, count: 1 });
    expect(state.bots).toStrictEqual({});
    expect(state.computers.items).toStrictEqual([]);
    expect(app.models?.jobs.size).toBe(0);
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
    expect((await call('write', request)).status).toBe(200);
    const update = {
      id: 'mock-progress',
      item: request.item,
      action: 'update',
      revision: 1,
      value: { progress: 'MOCK CHECKED RESULT', status: 'done' },
    };
    expect((await call('write', update)).status).toBe(200);
    const stale = await call('write', { ...update, id: 'mock-stale-edit' });
    expect(stale.value.error).toBe('WORK_CONFLICT');
    expect(
      (await call('write', { ...request, value: { ...request.value, title: '合成不同意图' } }))
        .value.error,
    ).toBe('WORK_REQUEST_CONFLICT');
    const trashed = await call('write', {
      id: 'mock-trash',
      item: request.item,
      revision: 2,
      action: 'trash',
    });
    expect.assert(isWorkReceipt(trashed.value) && trashed.value.state === 'complete');
    await app.close();
    app = await startPrototype(options);
    call = channel(app);
    for (const action of ['write', 'receipt']) {
      const replay = (await call(action, request)).value;
      expect.assert(isWorkReceipt(replay) && replay.state === 'complete');
      expect(replay.acceptedRevision).toBe(1);
      expect(replay.item).toStrictEqual(trashed.value.item);
    }
    expect((await call('list', {})).value.page.items).toStrictEqual([]);
    expect((await call('list', { filter: 'trash' })).value.page.items.length).toBe(1);
    const restored = await call('write', {
      id: 'mock-restore',
      item: request.item,
      revision: 3,
      action: 'restore',
    });
    expect.assert(isWorkReceipt(restored.value) && restored.value.state === 'complete');
    expect(restored.value.item.deleted).toBe(false);
    expect(restored.value.item.completedAt).toBe(trashed.value.item.completedAt);
    expect(app.models?.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('coordinated recovery permits only work readers and receipt inspection, without reservations or effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-recovery-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = channel(app);
  try {
    await call('write', request);
    expect.assert(app.recovery);
    vi.spyOn(app.recovery, 'admit').mockImplementation(() => false);
    const enter = vi.spyOn(app.recovery, 'enter').mockImplementation(() => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    expect((await call('list', {})).status).toBe(200);
    expect.assert(isWorkItem((await call('read', { id: request.item })).value));
    expect((await call('receipt', request)).value.state).toBe('complete');
    expect(enter.mock.calls.length).toBe(0);
    expect(
      (
        await call('write', {
          id: 'mock-recovery-edit',
          item: request.item,
          action: 'update',
          revision: 1,
          value: { title: '合成拒绝修改' },
        })
      ).value.error,
    ).toBe('RUNTIME_RECOVERY_PENDING');
    expect((await call('read', { id: request.item })).value.revision).toBe(1);
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
    expect(state.work).toStrictEqual({ available: false, error: 'WORK_CORRUPT' });
    expect(state.mode).toBe('agent');
    expect((await channel(app)('write', request)).value.error).toBe('WORK_CORRUPT');
    expect((await channel(app)('list', {})).value.error).toBe('WORK_CORRUPT');
    expect(await readFile(file)).toStrictEqual(original);
    expect(await app.models?.profiles.list()).toStrictEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime shutdown closes work and later stores even when another data owner fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-close-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  expect.assert(app.models);
  const models = app.models;
  const closeKnowledge = models.knowledge.close.bind(models.knowledge);
  const closeChats = vi.spyOn(models.chats, 'close');
  vi.spyOn(models.knowledge, 'close').mockImplementation(async () => {
    await closeKnowledge();
    throw new Fault('MOCK_CLOSE_FAILURE');
  });
  try {
    expect((await models.work.status()).available).toBe(true);
    await expect(app.close()).rejects.toThrowError(/MOCK_CLOSE_FAILURE/);
    expect(await models.work.status()).toStrictEqual({ available: false, error: 'WORK_CLOSED' });
    expect(closeChats.mock.calls.length).toBe(1);
    await expect(models.work.write(request, actor)).rejects.toThrowError(/WORK_CLOSED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
