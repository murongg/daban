import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteKeys, RemoteStore } from '@daban/engine/remote';
import type { RemoteRpcRequest } from '@daban/protocol';
import { afterEach, expect, it } from 'vitest';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-remote-store-synthetic-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const keys = await RemoteKeys.open(path.join(root, 'keys'), 'Synthetic controller');
  const file = path.join(root, 'remote.sqlite');
  const options = { file, host: 'a'.repeat(64), workspace: 'synthetic-workspace' };
  const store = new RemoteStore(options);
  await store.ready;
  cleanup.push(async () => store.close());
  const request: RemoteRpcRequest = {
    type: 'request',
    id: 'synthetic-operation',
    host: options.host,
    workspace: options.workspace,
    method: 'task.start',
    params: {
      bot: 'synthetic-bot',
      task: { prompt: 'synthetic-private-prompt', requestId: 'synthetic-task' },
    },
  };
  return { root, file, options, store, keys, request };
}

it('persists paired devices and requires the matching device and workspace', async () => {
  const f = await fixture();
  await expect(
    f.store.run(f.keys.identity.id, f.request, async () => 'unexpected'),
  ).rejects.toThrow('REMOTE_UNAUTHORIZED');
  f.store.pair(f.keys.identity, 'controller');
  const result = await f.store.run(f.keys.identity.id, f.request, async () => ({
    run: 'synthetic-run',
  }));
  expect(result).toEqual({ run: 'synthetic-run' });
  await expect(
    f.store.run(
      f.keys.identity.id,
      { ...f.request, id: 'wrong-target', workspace: 'another-workspace' },
      async () => 'unexpected',
    ),
  ).rejects.toThrow('REMOTE_WRONG_TARGET');
  f.store.close();
  const next = new RemoteStore(f.options);
  await next.ready;
  cleanup.push(async () => next.close());
  expect(next.devices('controller').map((item) => item.identity.id)).toEqual([f.keys.identity.id]);
  next.revoke(f.keys.identity.id);
  await expect(next.run(f.keys.identity.id, f.request, async () => 'unexpected')).rejects.toThrow(
    'REMOTE_UNAUTHORIZED',
  );
});

it('deduplicates concurrent and completed mutations without storing request secrets', async () => {
  const f = await fixture();
  f.store.pair(f.keys.identity, 'controller');
  let count = 0;
  let release: () => unknown = () => {};
  const waiting = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const execute = async () => {
    count++;
    await waiting;
    return { run: 'synthetic-run' };
  };
  const first = f.store.run(f.keys.identity.id, f.request, execute);
  const second = f.store.run(f.keys.identity.id, f.request, execute);
  release();
  expect(await first).toEqual(await second);
  expect(await f.store.run(f.keys.identity.id, f.request, execute)).toEqual({
    run: 'synthetic-run',
  });
  expect(count).toBe(1);
  await expect(
    f.store.run(
      f.keys.identity.id,
      { ...f.request, params: { ...f.request.params, bot: 'other-bot' } },
      execute,
    ),
  ).rejects.toThrow('REMOTE_REQUEST_CONFLICT');
  f.store.close();
  expect((await readFile(f.file)).includes(Buffer.from('synthetic-private-prompt'))).toBe(false);
});

it('never replays an action whose result became uncertain', async () => {
  const f = await fixture();
  f.store.pair(f.keys.identity, 'controller');
  await expect(
    f.store.run(f.keys.identity.id, f.request, async () => {
      throw Error('synthetic-transport-failed');
    }),
  ).rejects.toThrow();
  f.store.close();
  const next = new RemoteStore(f.options);
  await next.ready;
  cleanup.push(async () => next.close());
  let repeated = false;
  await expect(
    next.run(f.keys.identity.id, f.request, async () => {
      repeated = true;
    }),
  ).rejects.toThrow('REMOTE_OUTCOME_UNKNOWN');
  expect(repeated).toBe(false);
});

it('takes fresh observations instead of persisting and replaying cached screens', async () => {
  const f = await fixture();
  f.store.pair(f.keys.identity, 'controller');
  const request = {
    ...f.request,
    method: 'frame',
    params: { bot: 'synthetic-bot', surface: 'desktop', instance: 'synthetic-instance', epoch: 0 },
  };
  let frame = 0;
  expect(await f.store.run(f.keys.identity.id, request, async () => ++frame)).toBe(1);
  expect(await f.store.run(f.keys.identity.id, request, async () => ++frame)).toBe(2);
});

it('rechecks every preflight observation with the same RPC id after Host expiry or lost authority', async () => {
  const f = await fixture();
  f.store.pair(f.keys.identity, 'controller');
  for (const method of [
    'preflight.options',
    'preflight.inspect',
    'preflight.preview',
    'preflight.export',
  ]) {
    const query =
      method === 'preflight.options'
        ? { bot: 'mock-bot' }
        : method === 'preflight.inspect'
          ? {
              id: 'mock-report',
              bot: 'mock-bot',
              requirements: [{ kind: 'model', tools: false, vision: false }],
            }
          : { id: 'mock-report', digest: 'a'.repeat(64) };
    const request = { ...f.request, id: method.replace('.', '-'), method, params: { query } };
    let calls = 0;
    const dispatch = async () => {
      if (++calls > 1) throw Error('PREFLIGHT_REPORT_EXPIRED');
      return { synthetic: 'first-observation' };
    };
    await expect(f.store.run(f.keys.identity.id, request, dispatch)).resolves.toEqual({
      synthetic: 'first-observation',
    });
    await expect(f.store.run(f.keys.identity.id, request, dispatch)).rejects.toThrow(
      'PREFLIGHT_REPORT_EXPIRED',
    );
    expect(calls).toBe(2);
  }
});
