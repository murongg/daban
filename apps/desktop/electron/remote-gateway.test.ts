import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteGateway, RemoteKeys, RemoteStore } from '@daban/engine/remote';
import { afterEach, expect, it } from 'vitest';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-gateway-synthetic-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const keys = await RemoteKeys.open(path.join(root, 'keys'), 'Synthetic peer');
  const store = new RemoteStore({
    file: path.join(root, 'remote.sqlite'),
    host: 'a'.repeat(64),
    workspace: 'synthetic-workspace',
  });
  await store.ready;
  cleanups.push(async () => store.close());
  store.pair(keys.identity, 'controller');
  const invoked: unknown[] = [];
  const gateway = new RemoteGateway(store, async (command) => {
    invoked.push(command);
    if (command.type === 'control') return { owner: command.owner, epoch: command.epoch + 1 };
    return { accepted: true };
  });
  const request = {
    type: 'request' as const,
    id: 'synthetic-request',
    host: 'a'.repeat(64),
    workspace: 'synthetic-workspace',
    method: 'task.start',
    params: {
      bot: 'synthetic-bot',
      task: { prompt: 'Synthetic task', requestId: 'synthetic-task-request' },
    },
  };
  return { keys, store, gateway, invoked, request };
}

it('validates the real command before dispatch and refuses authority-bearing or injected fields', async () => {
  const f = await fixture();
  await expect(
    f.gateway.invoke(f.keys.identity.id, 'synthetic-session', {
      ...f.request,
      method: 'task.start',
      params: { bot: '../other', task: { prompt: 'Synthetic task' } },
    }),
  ).rejects.toThrow();
  await expect(
    f.gateway.invoke(f.keys.identity.id, 'synthetic-session', {
      ...f.request,
      params: { type: 'setup.start' },
    }),
  ).rejects.toThrow();
  await expect(
    f.gateway.invoke(f.keys.identity.id, 'synthetic-session', {
      ...f.request,
      method: 'agent.upgrade',
      params: { confirmed: true },
    }),
  ).rejects.toThrow();
  expect(f.invoked).toEqual([]);
  await expect(
    f.gateway.invoke(f.keys.identity.id, 'synthetic-session', f.request),
  ).resolves.toEqual({ accepted: true });
  expect(f.invoked).toEqual([{ type: 'task.start', ...f.request.params }]);
});

it('rejects replayed input within a live control lease without journaling mouse movement', async () => {
  const f = await fixture();
  await f.gateway.invoke(f.keys.identity.id, 'synthetic-session', {
    ...f.request,
    id: 'synthetic-control',
    method: 'control',
    params: { bot: 'synthetic-bot', epoch: 2, owner: 'human', instance: 'synthetic-desktop' },
  });
  const request = {
    ...f.request,
    method: 'input',
    sequence: 1,
    params: {
      bot: 'synthetic-bot',
      epoch: 3,
      instance: 'synthetic-desktop',
      input: { type: 'click', x: 30, y: 40 },
    },
  };
  await f.gateway.invoke(f.keys.identity.id, 'synthetic-session', request);
  await expect(f.gateway.invoke(f.keys.identity.id, 'synthetic-session', request)).rejects.toThrow(
    'REMOTE_INPUT_REPLAY',
  );
  await f.gateway.invoke(f.keys.identity.id, 'synthetic-session', {
    ...request,
    id: 'synthetic-next',
    sequence: 2,
  });
  expect(f.invoked).toHaveLength(3);
});

it('binds human input to the controlling device session and releases its keys on disconnect', async () => {
  const f = await fixture();
  const control = {
    ...f.request,
    id: 'synthetic-control',
    method: 'control',
    params: { bot: 'synthetic-bot', epoch: 2, owner: 'human', instance: 'synthetic-desktop' },
  };
  await f.gateway.invoke(f.keys.identity.id, 'synthetic-controller-a', control);
  const input = {
    ...f.request,
    method: 'input',
    sequence: 1,
    params: {
      bot: 'synthetic-bot',
      epoch: 3,
      instance: 'synthetic-desktop',
      input: { type: 'click', x: 30, y: 40 },
    },
  };
  await expect(
    f.gateway.invoke(f.keys.identity.id, 'synthetic-controller-b', input),
  ).rejects.toThrow('REMOTE_CONTROL_NOT_OWNED');
  await f.gateway.invoke(f.keys.identity.id, 'synthetic-controller-a', input);
  await f.gateway.disconnect(f.keys.identity.id, 'synthetic-controller-a');
  expect(f.invoked.at(-1)).toEqual({
    type: 'input',
    bot: 'synthetic-bot',
    epoch: 3,
    instance: 'synthetic-desktop',
    input: { type: 'release' },
  });
  await expect(
    f.gateway.invoke(f.keys.identity.id, 'synthetic-controller-a', { ...input, sequence: 2 }),
  ).rejects.toThrow();
});

it('requires a host-side authorization callback before native desktop access', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    method: 'local.connect',
    params: {
      id: 'synthetic-consent',
      bot: 'synthetic-bot',
      model: 'synthetic-model',
      modelRevision: 1,
    },
  };
  await expect(f.gateway.invoke(f.keys.identity.id, 'synthetic-session', request)).rejects.toThrow(
    'REMOTE_NATIVE_AUTH_REQUIRED',
  );
  expect(f.invoked).toEqual([]);
  let authorized = false;
  const gateway = new RemoteGateway(
    f.store,
    async () => ({ accepted: true }),
    async (device, command) => {
      expect(device).toBe(f.keys.identity.id);
      expect(command.type).toBe('local.connect');
      authorized = true;
    },
  );
  await expect(
    gateway.invoke(f.keys.identity.id, 'synthetic-session', {
      ...request,
      id: 'synthetic-authorized',
    }),
  ).resolves.toEqual({ accepted: true });
  expect(authorized).toBe(true);
});
