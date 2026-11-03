import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

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
    expect(await store.read()).toStrictEqual({
      tabs: [...first.tabs, ...second.tabs],
      active: { ...first.active, ...second.active },
    });
    expect((await store.receipt('mock-human-b', 'mock-agent-b'))?.phase).toBe('settled');
    expect(await store.receipt('mock-human-b', 'mock-agent-a')).toBe(undefined);
    await expect(store.claim('mock-invalid', '../private', 'b'.repeat(64))).rejects.toMatchObject({
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
    expect(await store.read()).toStrictEqual({
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
    expect(await store.read()).toBe(undefined);
    await store.save(state);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.claim('mock-claimed', 'a', 'a'.repeat(64))).toBe('new');
    expect(await store.claim('mock-claimed', 'a', 'a'.repeat(64))).toBe('claimed');
    await expect(store.claim('mock-claimed', 'b', 'a'.repeat(64))).rejects.toMatchObject({
      code: 'BROWSER_REQUEST_ID_REUSED',
    });
    await expect(store.claim('mock-claimed', 'a', 'b'.repeat(64))).rejects.toMatchObject({
      code: 'BROWSER_REQUEST_ID_REUSED',
    });
    expect(await store.claim('mock-done', 'b', 'c'.repeat(64))).toBe('new');
    await store.finish('mock-done', 'b', state, 'SYNTHETIC_REFUSAL', false);
    await store.close();
    store = new TabStore(file, ['a', 'b']);
    await store.ready;
    expect(await store.read()).toStrictEqual(state);
    expect(await store.claim('mock-claimed', 'a', 'a'.repeat(64))).toBe('claimed');
    expect(await store.claim('mock-done', 'b', 'c'.repeat(64))).toBe('settled');
    expect(await store.receipt('mock-done', 'b')).toStrictEqual({
      phase: 'settled',
      error: 'SYNTHETIC_REFUSAL',
      uncertain: false,
    });
    expect(await store.receipt('mock-done', 'a')).toBe(undefined);
    for (let i = 0; i < 140; i++) {
      await store.claim(`mock-old-${i}`, 'a', 'd'.repeat(64));
      await store.finish(`mock-old-${i}`, 'a', state);
    }
    expect(await store.claim('mock-old-0', 'a', 'd'.repeat(64))).toBe('settled');
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
      await expect(store.save(value)).rejects.toMatchObject({ code: 'INVALID_BROWSER_STATE' });
    expect(await store.read()).toStrictEqual(state);
    await store.close();
    const corrupt = path.join(root, 'corrupt.sqlite');
    await writeFile(corrupt, 'SYNTHETIC-CORRUPT-NOT-A-DATABASE');
    store = new TabStore(corrupt, ['a', 'b']);
    await store.ready;
    await expect(store.read()).rejects.toMatchObject({ code: 'BROWSER_STATE_UNAVAILABLE' });
    await store.close();
    expect(await readFile(corrupt, 'utf8')).toBe('SYNTHETIC-CORRUPT-NOT-A-DATABASE');
    const link = path.join(root, 'link.sqlite');
    await symlink(corrupt, link);
    store = new TabStore(link, ['a', 'b']);
    await store.ready;
    await expect(store.read()).rejects.toMatchObject({ code: 'BROWSER_STATE_UNAVAILABLE' });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('a pre-ORM version 1 tab file keeps saved tabs and receipts after the schema baseline', async () => {
  const { TabStore } = await load();
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-pre-orm-tabs-'));
  const file = path.join(root, 'tabs.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE browser_tabs(id TEXT PRIMARY KEY,bot TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,position INTEGER NOT NULL) STRICT;
    CREATE TABLE browser_active(bot TEXT PRIMARY KEY,tab TEXT NOT NULL) STRICT;
    CREATE TABLE browser_commands(id TEXT PRIMARY KEY,bot TEXT NOT NULL,signature TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,uncertain INTEGER) STRICT;
    CREATE TABLE browser_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
    INSERT INTO browser_meta VALUES(1,3);PRAGMA user_version=1;`);
  for (const [position, tab] of state.tabs.entries())
    old
      .prepare('INSERT INTO browser_tabs VALUES(?,?,?,?,?)')
      .run(tab.id, tab.bot, tab.url, tab.title, position);
  for (const [bot, tab] of Object.entries(state.active))
    old.prepare('INSERT INTO browser_active VALUES(?,?)').run(bot, tab);
  old
    .prepare("INSERT INTO browser_commands VALUES(?,?,?,'settled','SYNTHETIC_REFUSAL',1)")
    .run('mock-old-command', 'a', 'e'.repeat(64));
  old.close();
  let store = new TabStore(file, ['a', 'b']);
  try {
    await store.ready;
    expect(await store.read()).toStrictEqual(state);
    expect(await store.receipt('mock-old-command', 'a')).toStrictEqual({
      phase: 'settled',
      error: 'SYNTHETIC_REFUSAL',
      uncertain: true,
    });
    expect(await store.claim('mock-old-command', 'a', 'e'.repeat(64))).toBe('settled');
    const changed: Registry = {
      ...state,
      tabs: [{ ...state.tabs[0], title: 'Synthetic Changed' }, state.tabs[1]],
    };
    await store.save(changed);
    await store.close();
    store = new TabStore(file, ['a', 'b']);
    await store.ready;
    expect(await store.read()).toStrictEqual(changed);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('unversioned, newer or foreign tab files stay unavailable and unchanged', async () => {
  const { TabStore } = await load();
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-foreign-tabs-'));
  try {
    for (const [name, schema] of [
      [
        'unversioned',
        'CREATE TABLE browser_meta(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);',
      ],
      [
        'newer',
        'CREATE TABLE browser_meta(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);PRAGMA user_version=2;',
      ],
      ['foreign', 'CREATE TABLE mock_existing(value TEXT);PRAGMA user_version=1;'],
    ]) {
      const file = path.join(root, `${name}.sqlite`),
        old = new DatabaseSync(file);
      old.exec(schema);
      old.close();
      const bytes = await readFile(file),
        store = new TabStore(file, ['a', 'b']);
      await store.ready;
      await expect(store.read()).rejects.toMatchObject({ code: 'BROWSER_STATE_UNAVAILABLE' });
      await store.close();
      expect(await readFile(file)).toStrictEqual(bytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
