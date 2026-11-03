import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isGroupCopyReceipt, managedProtocol } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { startPrototype } from './server.js';

const source = {
  id: 'mock-api-source-group',
  name: '合成原群聊',
  members: ['mock-api-alpha', 'mock-api-beta'],
};
const request = { id: 'mock-api-copy-group', group: source.id, revision: 1, name: '合成群聊副本' };
async function members(app: Awaited<ReturnType<typeof startPrototype>>) {
  expect.assert(app.models && app.groups);
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
    expect.assert(app.models && app.groups);
    expect((await call('copy', request, source.id, 'mock-denied')).status).toBe(403);
    expect((await call('copy-receipt')).value).toStrictEqual({ request, state: 'unknown' });
    expect((await app.groups.status()).items.length).toBe(1);
    expect((await call('copy', request, 'mock-foreign-source')).status).toBe(400);
    expect((await call('copy', { ...request, members: source.members })).status).toBe(400);
    expect((await call('copy', request, source.id, app.token, '?unexpected=1')).status).toBe(400);
    const copied = await call('copy');
    expect(copied.status).toBe(200);
    expect.assert(isGroupCopyReceipt(copied.value) && copied.value.state === 'complete');
    expect(copied.value.group.id).toBe(request.id);
    expect(copied.value.group.members).toStrictEqual(source.members);
    expect((await call('copy-receipt')).value).toStrictEqual(copied.value);
    const page = await app.groups.read(request.id);
    expect(page.messages).toStrictEqual([]);
    expect(page.deliveries).toStrictEqual([]);
    expect(app.models.jobs.size).toBe(0);
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
    expect(state.clientProtocol).toBe(managedProtocol);
    expect.assert(state.clientProtocol >= 35);
    expect(state.groups.items.find((item: { id: string }) => item.id === request.id).archived).toBe(
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
      expect(response.groups.items.some((item: { id: string }) => item.id === request.id)).toBe(
        version === '28' || version === String(managedProtocol),
      );
    }
    expect(state.bots).toStrictEqual({});
    expect(state.computers.items).toStrictEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('group copy receipt stays read-only during coordinated recovery while creation is fenced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-copy-recovery-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    await members(app);
    expect.assert(app.groups && app.recovery);
    vi.spyOn(app.recovery, 'admit').mockImplementation(() => false);
    const enter = vi.spyOn(app.recovery, 'enter').mockImplementation(() => {
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
    expect(await call('copy-receipt')).toStrictEqual({
      status: 200,
      value: { request, state: 'unknown' },
    });
    expect(enter.mock.calls.length).toBe(0);
    expect((await call('copy')).value.error).toBe('RUNTIME_RECOVERY_PENDING');
    expect((await app.groups.status()).items.length).toBe(1);
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
    expect.assert(app.groups);
    expect((await call('copy')).status).toBe(200);
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
      expect(await call(action)).toStrictEqual({
        status: 200,
        value: { request, state: 'complete', group: archived.group },
      });
    expect((await app.groups!.status()).items.length).toBe(2);
    expect(app.models!.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
