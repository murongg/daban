import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type TestContext, test } from 'vitest';
import { Connections } from './connections.js';

async function fixture(t: TestContext, limit = 2) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-connections-'));
  const options = { file: path.join(root, 'computers.sqlite'), limit, boot: 'mock-kernel-boot-a' };
  let store = new Connections(options);
  t.onTestFinished(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.ready;
  return {
    root,
    options,
    get store() {
      return store;
    },
    reopen: async (boot = options.boot) => {
      await store.close();
      store = new Connections({ ...options, boot });
      await store.ready;
      return store;
    },
  };
}

test('computer claims preserve logical IDs, reserve one slot and settle exact-ID retries without replay', async (t) => {
  const { store } = await fixture(t);
  const request = {
    id: 'mock-connect-first',
    bot: 'mock-agent-47',
    action: 'connect' as const,
    revision: 0,
  };
  const claimed = store.claim(request);
  expect(claimed.fresh).toBe(true);
  expect(claimed.slot).toBe(0);
  expect(claimed.state.bot).toBe(request.bot);
  expect(claimed.state.phase).toBe('connecting');
  expect(store.claim(request).fresh).toBe(false);
  expect(store.receipt(request.id, request.bot).phase).toBe('claimed');
  expect(() => store.claim({ ...request, bot: 'mock-other' })).toThrowError(
    expect.objectContaining({
      code: 'COMPUTER_REQUEST_ID_REUSED',
    }),
  );
  store.finish(request.id, { phase: 'connected', instance: 'mock-native-instance-a' });
  expect(store.get(request.bot).phase).toBe('connected');
  expect(store.get(request.bot).desired).toBe(true);
  expect(store.get(request.bot).reserved).toBe(true);
  const settled = store.claim(request);
  expect(settled.fresh).toBe(false);
  expect(settled.receipt.phase).toBe('settled');
  expect(store.snapshot().items.length).toBe(1);
});

test('capacity and revision checks happen before effects and stopped slots may be explicitly reallocated', async (t) => {
  const { store } = await fixture(t, 1);
  store.claim({ id: 'mock-connect-a', bot: 'mock-a', action: 'connect', revision: 0 });
  store.finish('mock-connect-a', { phase: 'connected', instance: 'mock-instance-a' });
  expect(() =>
    store.claim({ id: 'mock-connect-b', bot: 'mock-b', action: 'connect', revision: 0 }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_CAPACITY' }));
  const current = store.get('mock-a');
  expect(() =>
    store.claim({
      id: 'mock-stale-stop',
      bot: 'mock-a',
      action: 'stop',
      revision: 0,
      instance: current.instance,
      confirmation: 'close-apps',
    }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_CONFLICT' }));
  expect(() =>
    store.claim({
      id: 'mock-unconfirmed-stop',
      bot: 'mock-a',
      action: 'stop',
      revision: current.revision,
      instance: current.instance,
    }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_CONFIRM_REQUIRED' }));
  store.claim({
    id: 'mock-stop-a',
    bot: 'mock-a',
    action: 'stop',
    revision: current.revision,
    instance: current.instance,
    confirmation: 'close-apps',
  });
  store.finish('mock-stop-a', { phase: 'disconnected' });
  expect(store.get('mock-a').desired).toBe(false);
  expect(
    store.claim({ id: 'mock-connect-b', bot: 'mock-b', action: 'connect', revision: 0 }).slot,
  ).toBe(0);
});

test('failed cleanup keeps its reservation and a failed but confirmed-clean start releases it', async (t) => {
  const { store } = await fixture(t, 1);
  store.claim({ id: 'mock-start-failed', bot: 'mock-a', action: 'connect', revision: 0 });
  store.finish('mock-start-failed', {
    phase: 'failed',
    error: 'COMPUTER_START_FAILED',
    reserved: true,
    recovery: 'restart',
  });
  expect(store.get('mock-a').reserved).toBe(true);
  expect(() =>
    store.claim({ id: 'mock-start-b', bot: 'mock-b', action: 'connect', revision: 0 }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_CAPACITY' }));
  expect(() =>
    store.claim({
      id: 'mock-retry-a',
      bot: 'mock-a',
      action: 'connect',
      revision: store.get('mock-a').revision,
    }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_STOP_REQUIRED' }));
  store.claim({
    id: 'mock-stop-a',
    bot: 'mock-a',
    action: 'stop',
    revision: store.get('mock-a').revision,
    confirmation: 'close-apps',
  });
  store.finish('mock-stop-a', { phase: 'disconnected' });
  store.claim({ id: 'mock-start-b', bot: 'mock-b', action: 'connect', revision: 0 });
  store.finish('mock-start-b', {
    phase: 'failed',
    error: 'COMPUTER_START_FAILED',
    reserved: false,
  });
  expect(store.get('mock-b').reserved).toBe(false);
  expect(
    store.claim({ id: 'mock-start-c', bot: 'mock-c', action: 'connect', revision: 0 }).slot,
  ).toBe(0);
});

test('same-boot reconstruction reports interrupted claims and never treats a lost owner as confirmed stopped', async (t) => {
  const state = await fixture(t, 1),
    request = { id: 'mock-lost-start', bot: 'mock-a', action: 'connect' as const, revision: 0 };
  state.store.claim(request);
  const restored = await state.reopen();
  expect(restored.get('mock-a').phase).toBe('interrupted');
  expect(restored.get('mock-a').reserved).toBe(true);
  expect(restored.get('mock-a').recovery).toBe('restart');
  expect(restored.claim(request).fresh).toBe(false);
  expect(restored.receipt(request.id, request.bot).phase).toBe('interrupted');
  expect(() =>
    restored.claim({ id: 'mock-new-b', bot: 'mock-b', action: 'connect', revision: 0 }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_CAPACITY' }));
});

test('a changed kernel boot frees abandoned slots without replaying the original operation', async (t) => {
  const state = await fixture(t, 1),
    request = { id: 'mock-old-boot-start', bot: 'mock-a', action: 'connect' as const, revision: 0 };
  state.store.claim(request);
  const restored = await state.reopen('mock-kernel-boot-b');
  expect(restored.get('mock-a').reserved).toBe(false);
  expect(restored.get('mock-a').desired).toBe(true);
  expect(restored.get('mock-a').phase).toBe('suspended');
  expect(restored.claim(request).fresh).toBe(false);
  expect(restored.receipt(request.id, request.bot).phase).toBe('interrupted');
  expect(
    restored.claim({
      id: 'mock-new-start',
      bot: 'mock-a',
      action: 'connect',
      revision: restored.get('mock-a').revision,
    }).fresh,
  ).toBe(true);
});

test('graceful suspension retains intent and data identity while every reconnect receives a new native instance', async (t) => {
  const state = await fixture(t);
  state.store.claim({ id: 'mock-first', bot: 'mock-stable', action: 'connect', revision: 0 });
  state.store.finish('mock-first', { phase: 'connected', instance: 'mock-instance-before' });
  state.store.suspend('mock-stable');
  const restored = await state.reopen();
  const saved = restored.get('mock-stable');
  expect(saved.phase).toBe('suspended');
  expect(saved.desired).toBe(true);
  expect(saved.reserved).toBe(false);
  expect(saved.instance).toBe(undefined);
  restored.claim({
    id: 'mock-reconnect',
    bot: saved.bot,
    action: 'connect',
    revision: saved.revision,
  });
  restored.finish('mock-reconnect', { phase: 'connected', instance: 'mock-instance-after' });
  expect(restored.get(saved.bot).bot).toBe('mock-stable');
  expect(restored.get(saved.bot).instance).toBe('mock-instance-after');
});

test('corrupt computer storage is retained and reports unavailable instead of resetting it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-corrupt-connections-'));
  const file = path.join(root, 'computers.sqlite'),
    contents = Buffer.from('SYNTHETIC-CORRUPT-STORE');
  await writeFile(file, contents);
  const store = new Connections({ file, limit: 2, boot: 'mock-boot' });
  t.onTestFinished(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.ready;
  expect(store.snapshot().available).toBe(false);
  expect(() =>
    store.claim({ id: 'mock-request', bot: 'mock-bot', action: 'connect', revision: 0 }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_STORE_UNAVAILABLE' }));
  expect(await readFile(file)).toStrictEqual(contents);
});

test('a committed state that cannot be safely reconciled disables further computer mutations', async (t) => {
  const { store, options } = await fixture(t);
  const database = new DatabaseSync(options.file);
  database.prepare('UPDATE computer_meta SET revision=? WHERE id=1').run(-2);
  database.close();
  expect(() =>
    store.claim({ id: 'mock-overflow-claim', bot: 'mock-bot', action: 'connect', revision: 0 }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_STORE_UNAVAILABLE' }));
  expect(store.snapshot().available).toBe(false);
  expect(() =>
    store.claim({
      id: 'mock-no-second-effect',
      bot: 'mock-other',
      action: 'connect',
      revision: 0,
    }),
  ).toThrowError(expect.objectContaining({ code: 'COMPUTER_STORE_UNAVAILABLE' }));
});
