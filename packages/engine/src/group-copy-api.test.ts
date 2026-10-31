import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isGroupCopyReceipt, managedProtocol } from '@daban/protocol';
import { Fault } from './control.js';
import { startPrototype } from './server.js';

const source = {
  id: 'mock-api-source-group',
  name: '合成原群聊',
  members: ['mock-api-alpha', 'mock-api-beta'],
};
const request = { id: 'mock-api-copy-group', group: source.id, revision: 1, name: '合成群聊副本' };
async function members(app: Awaited<ReturnType<typeof startPrototype>>) {
  assert.ok(app.models && app.groups);
  for (const id of source.members)
    await app.models.profiles.register({
      id,
      name: `合成 ${id}`,
      instructions: 'MOCK-ROLE',
      memory: '',
      color: 'mint',
    });
  return app.groups.register(source);
}

test('group copy HTTP binds the authenticated source and returns an empty independent group without jobs or computers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-copy-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = async (
    action: string,
    body: unknown = request,
    group = source.id,
    token = app.token,
    query = '',
  ) => {
    const response = await fetch(`${app.url}/api/groups/${group}/${action}${query}`, {
      method: 'POST',
      headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    await members(app);
    assert.ok(app.models && app.groups);
    assert.equal((await call('copy', request, source.id, 'mock-denied')).status, 403);
    assert.deepEqual((await call('copy-receipt')).value, { request, state: 'unknown' });
    assert.equal((await app.groups.status()).items.length, 1);
    assert.equal((await call('copy', request, 'mock-foreign-source')).status, 400);
    assert.equal((await call('copy', { ...request, members: source.members })).status, 400);
    assert.equal((await call('copy', request, source.id, app.token, '?unexpected=1')).status, 400);
    const copied = await call('copy');
    assert.equal(copied.status, 200);
    assert.ok(isGroupCopyReceipt(copied.value) && copied.value.state === 'complete');
    assert.equal(copied.value.group.id, request.id);
    assert.deepEqual(copied.value.group.members, source.members);
    assert.deepEqual((await call('copy-receipt')).value, copied.value);
    const page = await app.groups.read(request.id);
    assert.deepEqual(page.messages, []);
    assert.deepEqual(page.deliveries, []);
    assert.equal(app.models.jobs.size, 0);
    await app.groups.action({
      id: 'mock-copy-archive',
      group: request.id,
      action: 'archive',
      revision: 1,
    });
    const state = await (
      await fetch(`${app.url}/api/state`, {
        headers: {
          'x-prototype-token': app.token,
          'x-daban-client-protocol': String(managedProtocol),
        },
      })
    ).json();
    assert.equal(state.clientProtocol, managedProtocol);
    assert.ok(state.clientProtocol >= 35);
    assert.equal(
      state.groups.items.find((item: { id: string }) => item.id === request.id).archived,
      true,
    );
    for (const version of [
      '28',
      String(managedProtocol),
      '27',
      String(managedProtocol + 1),
      '028',
      `${managedProtocol}.0`,
    ]) {
      const response = await (
        await fetch(`${app.url}/api/state`, {
          headers: { 'x-prototype-token': app.token, 'x-daban-client-protocol': version },
        })
      ).json();
      assert.equal(
        response.groups.items.some((item: { id: string }) => item.id === request.id),
        version === '28' || version === String(managedProtocol),
      );
    }
    assert.deepEqual(state.bots, {});
    assert.deepEqual(state.computers.items, []);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('group copy receipt stays read-only during coordinated recovery while creation is fenced', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-copy-recovery-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    await members(app);
    assert.ok(app.groups && app.recovery);
    t.mock.method(app.recovery, 'admit', () => false);
    const enter = t.mock.method(app.recovery, 'enter', () => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    const call = async (action: string) => {
      const response = await fetch(`${app.url}/api/groups/${source.id}/${action}`, {
        method: 'POST',
        headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      return { status: response.status, value: await response.json() };
    };
    assert.deepEqual(await call('copy-receipt'), {
      status: 200,
      value: { request, state: 'unknown' },
    });
    assert.equal(enter.mock.callCount(), 0);
    assert.equal((await call('copy')).value.error, 'RUNTIME_RECOVERY_PENDING');
    assert.equal((await app.groups.status()).items.length, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('group HTTP copy replay after restart preserves later target membership/name/archive and never creates a second context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-copy-restart-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  const call = async (action: string) => {
    const response = await fetch(`${app.url}/api/groups/${source.id}/${action}`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    await members(app);
    assert.ok(app.groups);
    assert.equal((await call('copy')).status, 200);
    const edited = await app.groups.update(request.id, 1, {
      name: '合成后续编辑',
      members: [...source.members].reverse(),
    });
    const archived = await app.groups.action({
      id: 'mock-restart-archive',
      group: request.id,
      action: 'archive',
      revision: edited.revision,
    });
    await app.groups.action({
      id: 'mock-source-archive',
      group: source.id,
      action: 'archive',
      revision: 1,
    });
    await app.close();
    app = await startPrototype(options);
    for (const action of ['copy-receipt', 'copy'])
      assert.deepEqual(await call(action), {
        status: 200,
        value: { request, state: 'complete', group: archived.group },
      });
    assert.equal((await app.groups!.status()).items.length, 2);
    assert.equal(app.models!.jobs.size, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
