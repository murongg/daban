import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBotCopyReceipt, managedProtocol } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
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
    expect.assert(app.models && app.groups);
    const original = await app.models.profiles.register(source);
    expect((await call('copy', input, source.id, 'mock-denied')).status).toBe(403);
    expect((await call('copy-receipt')).value).toStrictEqual({ request: input, state: 'unknown' });
    expect((await app.models.profiles.list()).length).toBe(1);
    expect((await call('copy', input, 'mock-foreign')).status).toBe(400);
    expect((await call('copy', { ...input, allowComputer: true })).status).toBe(400);
    expect((await call('copy', input, source.id, app.token, '?unexpected=1')).status).toBe(400);
    const result = await call('copy');
    expect(result.status).toBe(200);
    expect.assert(isBotCopyReceipt(result.value) && result.value.state === 'complete');
    expect(result.value.profile.id).toBe(input.id);
    expect(result.value.profile.model).toBe(source.model);
    expect(result.value.profile.memory).toBe(source.memory);
    expect((await call('copy-receipt')).value).toStrictEqual(result.value);
    expect(await app.models.profiles.get(source.id)).toStrictEqual(original);
    expect(app.models.jobs.size).toBe(0);
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
    expect(state.clientProtocol).toBe(managedProtocol);
    expect(state.groups.items.find((item: { id: string }) => item.id === group.id).archived).toBe(
      true,
    );
    expect(state.bots).toStrictEqual({});
    expect(state.computers.items).toStrictEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('copy receipt remains read-only while recovery fences mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-copy-recovery-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    expect.assert(app.models && app.recovery);
    await app.models.profiles.register(source);
    vi.spyOn(app.recovery, 'admit').mockImplementation(() => false);
    const enter = vi.spyOn(app.recovery, 'enter').mockImplementation(() => {
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
    expect(await call('copy-receipt')).toStrictEqual({
      status: 200,
      value: { request: input, state: 'unknown' },
    });
    expect(enter.mock.calls.length).toBe(0);
    expect((await call('copy')).value.error).toBe('RUNTIME_RECOVERY_PENDING');
    expect(await app.models.profiles.get(input.id)).toBe(undefined);
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
    expect.assert(app.models);
    await app.models.profiles.register(source);
    const first = await call('copy');
    expect(first.status).toBe(200);
    const edited = await app.models.profiles.update(input.id, 1, { name: '合成人工后续编辑' });
    await app.models.profiles.update(source.id, 1, { instructions: 'MOCK-CHANGED' });
    await app.close();
    app = await startPrototype(options);
    for (const action of ['copy-receipt', 'copy']) {
      const result = await call(action);
      expect(result.status).toBe(200);
      expect(result.value).toStrictEqual({ request: input, state: 'complete', profile: edited });
    }
    expect((await app.models!.profiles.list()).length).toBe(2);
    expect(app.models!.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
