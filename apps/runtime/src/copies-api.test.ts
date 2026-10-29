import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBotCopyReceipt } from '@daban/protocol';
import { Fault } from './control.js';
import { startPrototype } from './server.js';

const source = {
  id: 'mock-api-source',
  name: '合成复制原件',
  instructions: 'MOCK-ROLE',
  memory: 'MOCK-PREFERENCE',
  color: 'mint' as const,
  model: 'deepseek-v4-pro' as const,
};
const input = {
  id: 'mock-api-target',
  bot: source.id,
  revision: 1,
  name: '合成复制结果',
  memory: true,
};

test('copy HTTP endpoints authenticate, bind the source, preserve metadata and allocate no computer or model task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = async (
    action: string,
    body: unknown = input,
    bot = source.id,
    token = app.token,
    query = '',
  ) => {
    const response = await fetch(`${app.url}/api/bots/${bot}/${action}${query}`, {
      method: 'POST',
      headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.ok(app.models && app.groups);
    const original = await app.models.profiles.register(source);
    assert.equal((await call('copy', input, source.id, 'mock-denied')).status, 403);
    assert.deepEqual((await call('copy-receipt')).value, { request: input, state: 'unknown' });
    assert.equal((await app.models.profiles.list()).length, 1);
    assert.equal((await call('copy', input, 'mock-foreign')).status, 400);
    assert.equal((await call('copy', { ...input, allowComputer: true })).status, 400);
    assert.equal((await call('copy', input, source.id, app.token, '?unexpected=1')).status, 400);
    const result = await call('copy');
    assert.equal(result.status, 200);
    assert.ok(isBotCopyReceipt(result.value) && result.value.state === 'complete');
    assert.equal(result.value.profile.id, input.id);
    assert.equal(result.value.profile.model, source.model);
    assert.equal(result.value.profile.memory, source.memory);
    assert.deepEqual((await call('copy-receipt')).value, result.value);
    assert.deepEqual(await app.models.profiles.get(source.id), original);
    assert.equal(app.models.jobs.size, 0);
    const group = await app.groups.register({
      id: 'mock-copy-group',
      name: '合成归档组',
      members: [source.id, input.id],
    });
    await app.groups.action({
      id: 'mock-copy-archive',
      group: group.id,
      action: 'archive',
      revision: group.revision,
    });
    const state = await (
      await fetch(`${app.url}/api/state`, {
        headers: { 'x-prototype-token': app.token, 'x-daban-client-protocol': '34' },
      })
    ).json();
    assert.equal(state.clientProtocol, 34);
    assert.equal(
      state.groups.items.find((item: { id: string }) => item.id === group.id).archived,
      true,
    );
    assert.deepEqual(state.bots, {});
    assert.deepEqual(state.computers.items, []);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('copy receipt remains read-only while recovery fences mutation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-recovery-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    assert.ok(app.models && app.recovery);
    await app.models.profiles.register(source);
    t.mock.method(app.recovery, 'admit', () => false);
    const enter = t.mock.method(app.recovery, 'enter', () => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    const call = async (action: string) => {
      const response = await fetch(`${app.url}/api/bots/${source.id}/${action}`, {
        method: 'POST',
        headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: response.status, value: await response.json() };
    };
    assert.deepEqual(await call('copy-receipt'), {
      status: 200,
      value: { request: input, state: 'unknown' },
    });
    assert.equal(enter.mock.callCount(), 0);
    assert.equal((await call('copy')).value.error, 'RUNTIME_RECOVERY_PENDING');
    assert.equal(await app.models.profiles.get(input.id), undefined);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP reconciliation and retry preserve later target edits across service restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-http-restart-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  const call = async (action: string) => {
    const response = await fetch(`${app.url}/api/bots/${source.id}/${action}`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.ok(app.models);
    await app.models.profiles.register(source);
    const first = await call('copy');
    assert.equal(first.status, 200);
    const edited = await app.models.profiles.update(input.id, 1, { name: '合成人工后续编辑' });
    await app.models.profiles.update(source.id, 1, { instructions: 'MOCK-CHANGED' });
    await app.close();
    app = await startPrototype(options);
    for (const action of ['copy-receipt', 'copy']) {
      const result = await call(action);
      assert.equal(result.status, 200);
      assert.deepEqual(result.value, { request: input, state: 'complete', profile: edited });
    }
    assert.equal((await app.models!.profiles.list()).length, 2);
    assert.equal(app.models!.jobs.size, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
