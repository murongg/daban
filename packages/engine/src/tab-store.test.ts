import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

interface Registry {
  tabs: { id: string; bot: string; url: string; title: string }[];
  active: Record<string, string>;
}
interface Store {
  ready: Promise<unknown>;
  read(): Promise<Registry | undefined>;
  save(state: Registry): Promise<unknown>;
  claim(id: string, bot: string, signature: string): Promise<'new' | 'claimed' | 'settled'>;
  finish(
    id: string,
    bot: string,
    state: Registry,
    error?: string,
    uncertain?: boolean,
  ): Promise<unknown>;
  receipt(
    id: string,
    bot: string,
  ): Promise<{ phase: 'claimed' | 'settled'; error?: string; uncertain?: boolean } | undefined>;
  close(): Promise<unknown>;
}
const uri = new URL('./tab-store.js', import.meta.url).href;
const load = () =>
  import(uri) as Promise<{ TabStore: new (file: string, bots?: readonly string[]) => Store }>;

test('dynamic tab owners merge their own saved state without erasing disconnected Bot tabs', async () => {
  const { TabStore } = await load();
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-dynamic-tabs-'));
  const file = path.join(root, 'tabs.sqlite');
  let store = new TabStore(file);
  const first: Registry = {
    tabs: [
      {
        id: 'mock-owned-a',
        bot: 'mock-agent-a',
        url: 'https://example.test/saved-a',
        title: 'Synthetic A',
      },
    ],
    active: { 'mock-agent-a': 'mock-owned-a' },
  };
  const second: Registry = {
    tabs: [{ id: 'mock-owned-b', bot: 'mock-agent-b', url: 'about:blank', title: '' }],
    active: { 'mock-agent-b': 'mock-owned-b' },
  };
  try {
    await store.ready;
    await store.save(first);
    await store.save(second);
    await store.claim('mock-human-b', 'mock-agent-b', 'a'.repeat(64));
    second.tabs[0].url = 'https://example.test/saved-b';
    await store.finish('mock-human-b', 'mock-agent-b', second);
    await store.save({ tabs: [], active: {} });
    await store.close();
    store = new TabStore(file);
    await store.ready;
    assert.deepEqual(await store.read(), {
      tabs: [...first.tabs, ...second.tabs],
      active: { ...first.active, ...second.active },
    });
    assert.equal((await store.receipt('mock-human-b', 'mock-agent-b'))?.phase, 'settled');
    assert.equal(await store.receipt('mock-human-b', 'mock-agent-a'), undefined);
    await assert.rejects(store.claim('mock-invalid', '../private', 'b'.repeat(64)), {
      code: 'INVALID_BROWSER_REQUEST',
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dynamic ownership retains the legacy saved a/b registry while a new Bot obtains separate metadata', async () => {
  const { TabStore } = await load();
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-legacy-tab-migration-'));
  const file = path.join(root, 'tabs.sqlite');
  let store = new TabStore(file, ['a', 'b']);
  try {
    await store.ready;
    await store.save(state);
    await store.close();
    store = new TabStore(file);
    await store.ready;
    const added: Registry = {
      tabs: [{ id: 'mock-new-owner-tab', bot: 'mock-new-owner', url: 'about:blank', title: '' }],
      active: { 'mock-new-owner': 'mock-new-owner-tab' },
    };
    await store.save(added);
    assert.deepEqual(await store.read(), {
      tabs: [...state.tabs, ...added.tabs],
      active: { ...state.active, ...added.active },
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
const state: Registry = {
  tabs: [
    { id: 'mock-tab-a', bot: 'a', url: 'https://example.test/account', title: 'Synthetic A' },
    { id: 'mock-tab-b', bot: 'b', url: 'about:blank', title: '' },
  ],
  active: { a: 'mock-tab-a', b: 'mock-tab-b' },
};
test('private tab state and command receipts survive reopening without replaying a claimed effect', async () => {
  const { TabStore } = await load();
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-tab-store-'));
  const file = path.join(root, 'tabs.sqlite');
  let store = new TabStore(file, ['a', 'b']);
  try {
    await store.ready;
    assert.equal(await store.read(), undefined);
    await store.save(state);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await store.claim('mock-claimed', 'a', 'a'.repeat(64)), 'new');
    assert.equal(await store.claim('mock-claimed', 'a', 'a'.repeat(64)), 'claimed');
    await assert.rejects(store.claim('mock-claimed', 'b', 'a'.repeat(64)), {
      code: 'BROWSER_REQUEST_ID_REUSED',
    });
    await assert.rejects(store.claim('mock-claimed', 'a', 'b'.repeat(64)), {
      code: 'BROWSER_REQUEST_ID_REUSED',
    });
    assert.equal(await store.claim('mock-done', 'b', 'c'.repeat(64)), 'new');
    await store.finish('mock-done', 'b', state, 'SYNTHETIC_REFUSAL', false);
    await store.close();
    store = new TabStore(file, ['a', 'b']);
    await store.ready;
    assert.deepEqual(await store.read(), state);
    assert.equal(await store.claim('mock-claimed', 'a', 'a'.repeat(64)), 'claimed');
    assert.equal(await store.claim('mock-done', 'b', 'c'.repeat(64)), 'settled');
    assert.deepEqual(await store.receipt('mock-done', 'b'), {
      phase: 'settled',
      error: 'SYNTHETIC_REFUSAL',
      uncertain: false,
    });
    assert.equal(await store.receipt('mock-done', 'a'), undefined);
    for (let i = 0; i < 140; i++) {
      await store.claim(`mock-old-${i}`, 'a', 'd'.repeat(64));
      await store.finish(`mock-old-${i}`, 'a', state);
    }
    assert.equal(await store.claim('mock-old-0', 'a', 'd'.repeat(64)), 'settled');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('invalid metadata, symlinks and corrupt tab storage fail closed without replacing the saved bytes', async () => {
  const { TabStore } = await load();
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-tab-store-invalid-'));
  let store = new TabStore(path.join(root, 'valid.sqlite'), ['a', 'b']);
  try {
    await store.ready;
    await store.save(state);
    for (const value of [
      { ...state, active: { a: 'mock-tab-b', b: 'mock-tab-b' } },
      { ...state, tabs: [...state.tabs, { ...state.tabs[0] }] },
      { ...state, tabs: [{ ...state.tabs[0], url: 'file:///etc/passwd' }, state.tabs[1]] },
      { ...state, tabs: [{ ...state.tabs[0], bot: 'other-owner' }, state.tabs[1]] },
    ])
      await assert.rejects(store.save(value), { code: 'INVALID_BROWSER_STATE' });
    assert.deepEqual(await store.read(), state);
    await store.close();
    const corrupt = path.join(root, 'corrupt.sqlite');
    await writeFile(corrupt, 'SYNTHETIC-CORRUPT-NOT-A-DATABASE');
    store = new TabStore(corrupt, ['a', 'b']);
    await store.ready;
    await assert.rejects(store.read(), { code: 'BROWSER_STATE_UNAVAILABLE' });
    await store.close();
    assert.equal(await readFile(corrupt, 'utf8'), 'SYNTHETIC-CORRUPT-NOT-A-DATABASE');
    const link = path.join(root, 'link.sqlite');
    await symlink(corrupt, link);
    store = new TabStore(link, ['a', 'b']);
    await store.ready;
    await assert.rejects(store.read(), { code: 'BROWSER_STATE_UNAVAILABLE' });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
