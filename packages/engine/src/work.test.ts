import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { workKey } from '@daban/protocol';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test, vi } from 'vitest';
import { errorCode } from './control.js';
import { tables } from './database.js';
import { secureDirectory } from './private-files.js';
import { Work } from './work.js';
import { workItems, workMeta, workOperations } from './work-schema.js';

const human = { kind: 'human' as const };
const bot = { kind: 'bot' as const, bot: 'mock-alpha' };
const fields = {
  title: '合成共享待办',
  description: 'MOCK DESCRIPTION',
  progress: '',
  status: 'todo' as const,
};
const create = (item = 'mock-item', id = 'mock-create') => ({
  id,
  item,
  revision: 0,
  action: 'create' as const,
  value: { ...fields },
});
async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-work-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const file = path.join(root, 'work.sqlite');
  let store = new Work(file);
  await store.ready;
  return {
    root,
    file,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = new Work(file);
      await store.ready;
    },
    async close(observe?: (phase: 'close.store' | 'close.remove' | 'close.complete') => unknown) {
      observe?.('close.store');
      await store.close();
      observe?.('close.remove');
      await rm(temporary, { recursive: true, force: true });
      observe?.('close.complete');
    },
  };
}

test('a pre-ORM schema3 work file keeps items, receipts and authority after the schema baseline', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-work-legacy-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const file = path.join(root, 'work.sqlite');
  const at = '2026-01-01T00:00:00.000Z';
  const input = { ...create(), revision: 0 as const };
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE work_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,progress TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,completed TEXT,creator TEXT NOT NULL,editor TEXT NOT NULL,priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),assignee TEXT) STRICT;
    CREATE TABLE work_operations(id TEXT PRIMARY KEY,item TEXT NOT NULL REFERENCES work_items(id),signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;
    CREATE TABLE work_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,comments INTEGER NOT NULL DEFAULT 0 CHECK(comments>=0)) STRICT;
    CREATE TABLE work_comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,item TEXT NOT NULL REFERENCES work_items(id),body TEXT NOT NULL,creator TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;
    INSERT INTO work_meta VALUES(1,1,0);
    PRAGMA user_version=3;`);
  old
    .prepare(
      'INSERT INTO work_items(id,title,description,progress,status,revision,deleted,created,updated,completed,creator,editor,priority,assignee) VALUES(?,?,?,?,?,1,0,?,?,NULL,?,?,?,?)',
    )
    .run(
      input.item,
      fields.title,
      fields.description,
      fields.progress,
      'review',
      at,
      at,
      JSON.stringify(human),
      JSON.stringify(human),
      'high',
      bot.bot,
    );
  old
    .prepare('INSERT INTO work_operations VALUES(?,?,?,?,?)')
    .run(
      input.id,
      input.item,
      createHash('sha256').update(workKey(input, human)).digest('hex'),
      1,
      at,
    );
  old.close();
  let store = new Work(file);
  try {
    await store.ready;
    const receipt = await store.receipt(input, human);
    expect.assert(receipt.state === 'complete');
    expect(receipt.acceptedAt).toBe(at);
    expect(receipt.item).toMatchObject({
      status: 'review',
      priority: 'high',
      assignee: bot.bot,
      revision: 1,
      createdBy: human,
    });
    expect(await store.status()).toStrictEqual({ available: true, revision: 1, count: 1 });
    const edited = await store.write(
      {
        id: 'mock-after-baseline',
        item: input.item,
        revision: 1,
        action: 'update',
        value: { status: 'done' },
      },
      bot,
    );
    expect(edited.item.revision).toBe(2);
    const comment = { id: 'mock-after-comment', item: input.item, revision: 2, body: 'MOCK' };
    expect((await store.comment(comment, bot)).item.revision).toBe(3);
    await store.close();
    store = new Work(file);
    await store.ready;
    expect((await store.commentReceipt(comment, bot)).state).toBe('complete');
    expect(await store.status()).toStrictEqual({ available: true, revision: 3, count: 1 });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(tables(db)).toStrictEqual([
        'work_comments',
        'work_items',
        'work_meta',
        'work_operations',
      ]);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('shared work preserves immutable creation provenance and current progress without representing an Agent run', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write(
      { ...create(), value: { ...fields, title: '  合成共享待办  ' } },
      human,
    );
    expect(first.state).toBe('complete');
    expect(first.item.title).toBe(fields.title);
    expect(first.item.status).toBe('todo');
    expect(first.item.completedAt).toBe(undefined);
    expect(first.item.createdBy).toStrictEqual(human);
    expect(first.item.updatedBy).toStrictEqual(human);
    const edited = await f.store.write(
      {
        id: 'mock-update',
        item: first.item.id,
        revision: 1,
        action: 'update',
        value: { status: 'doing', progress: 'MOCK VERIFIED PROGRESS' },
      },
      bot,
    );
    expect(edited.item.revision).toBe(2);
    expect(edited.item.progress).toBe('MOCK VERIFIED PROGRESS');
    expect(edited.item.createdBy).toStrictEqual(human);
    expect(edited.item.updatedBy).toStrictEqual(bot);
    expect(edited.item.description).toBe(fields.description);
    expect((await f.store.list({ filter: 'open' })).items.length).toBe(1);
    expect((await f.store.status()).revision).toBe(2);
    edited.item.title = 'MOCK MUTATED REPLY';
    expect((await f.store.get(first.item.id)).title).toBe(fields.title);
    expect(Object.hasOwn(await f.store.get(first.item.id), 'runId')).toBe(false);
  } finally {
    await f.close();
  }
});

test('completion and reopening have stable timestamps, and soft trash keeps exact content for restoration', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write({ ...create(), value: { ...fields, status: 'done' } }, bot);
    expect(first.item.completedAt).toBe(first.item.createdAt);
    const changed = await f.store.write(
      {
        id: 'mock-done-edit',
        item: first.item.id,
        revision: 1,
        action: 'update',
        value: { description: 'MOCK EDITED DESCRIPTION' },
      },
      human,
    );
    expect(changed.item.completedAt).toBe(first.item.completedAt);
    const reopened = await f.store.write(
      {
        id: 'mock-reopen',
        item: first.item.id,
        revision: 2,
        action: 'update',
        value: { status: 'todo' },
      },
      human,
    );
    expect(reopened.item.completedAt).toBe(undefined);
    const done = await f.store.write(
      {
        id: 'mock-done',
        item: first.item.id,
        revision: 3,
        action: 'update',
        value: { status: 'done' },
      },
      bot,
    );
    expect(done.item.completedAt).toBe(done.item.updatedAt);
    const trashRequest = {
      id: 'mock-trash',
      item: first.item.id,
      revision: 4,
      action: 'trash' as const,
    };
    const trashed = await f.store.write(trashRequest, human);
    expect(trashed.item.deleted).toBe(true);
    expect(trashed.item.description).toBe('MOCK EDITED DESCRIPTION');
    expect((await f.store.list()).items.length).toBe(0);
    expect((await f.store.list({ filter: 'trash' })).items.length).toBe(1);
    await expect(
      f.store.write(
        {
          id: 'mock-trash-edit',
          item: first.item.id,
          revision: 5,
          action: 'update',
          value: { title: 'MOCK WRONG EDIT' },
        },
        bot,
      ),
    ).rejects.toThrowError(/WORK_TRASHED/);
    const restored = await f.store.write(
      { id: 'mock-restore', item: first.item.id, revision: 5, action: 'restore' },
      human,
    );
    expect(restored.item.deleted).toBe(false);
    expect(restored.item.status).toBe('done');
    expect(restored.item.completedAt).toBe(done.item.completedAt);
    expect((await f.store.write(trashRequest, human)).item).toStrictEqual(restored.item);
  } finally {
    await f.close();
  }
});

test('accepted operations survive restart and return later state without overwriting a human edit', async () => {
  const f = await fixture();
  const input = create();
  try {
    expect(await f.store.receipt(input, bot)).toStrictEqual({
      state: 'unknown',
      request: input,
      actor: bot,
    });
    const first = await f.store.write(input, bot);
    const edited = await f.store.write(
      {
        id: 'mock-human-edit',
        item: input.item,
        revision: 1,
        action: 'update',
        value: { title: '合成人工后续修改', progress: 'MOCK LATER PROGRESS' },
      },
      human,
    );
    await f.reopen();
    for (const read of [await f.store.receipt(input, bot), await f.store.write(input, bot)]) {
      expect.assert(read.state === 'complete');
      expect(read.acceptedRevision).toBe(1);
      expect(read.acceptedAt).toBe(first.acceptedAt);
      expect(read.item).toStrictEqual(edited.item);
    }
    expect((await f.store.list({ filter: 'all' })).items.length).toBe(1);
  } finally {
    await f.close();
  }
});

test('CAS writes serialize and caller mutations cannot alter a queued operation or actor', async () => {
  const f = await fixture();
  try {
    const input = create(),
      by = { ...bot };
    const pending = f.store.write(input, by);
    input.value.title = 'MOCK LATE INPUT';
    by.bot = 'mock-other';
    const first = await pending;
    expect(first.item.title).toBe(fields.title);
    expect(first.item.createdBy).toStrictEqual(bot);
    const writes = await Promise.allSettled([
      f.store.write(
        {
          id: 'mock-race-one',
          item: input.item,
          revision: 1,
          action: 'update',
          value: { title: '合成并发甲' },
        },
        human,
      ),
      f.store.write(
        {
          id: 'mock-race-two',
          item: input.item,
          revision: 1,
          action: 'update',
          value: { title: '合成并发乙' },
        },
        bot,
      ),
    ]);
    expect(writes.filter((row) => row.status === 'fulfilled').length).toBe(1);
    const rejected = writes.find((row) => row.status === 'rejected');
    expect.assert(rejected?.status === 'rejected');
    expect(String(rejected.reason)).toMatch(/WORK_CONFLICT/);
    expect((await f.store.get(input.item)).revision).toBe(2);
    const original = create();
    const read = f.store.receipt(original, { ...bot });
    original.value.title = 'MOCK LATE READ';
    const receipt = await read;
    expect.assert(receipt.state === 'complete');
    expect.assert(receipt.request.action === 'create');
    expect(receipt.request.value.title).toBe(fields.title);
  } finally {
    await f.close();
  }
});

test('operation identity binds actor and exact fields while equivalent patch key order stays retryable', async () => {
  const f = await fixture();
  try {
    const input = create();
    await f.store.write(input, bot);
    await expect(
      f.store.write({ ...input, value: { ...fields, title: '合成不同请求' } }, bot),
    ).rejects.toThrowError(/WORK_REQUEST_CONFLICT/);
    await expect(f.store.receipt(input, human)).rejects.toThrowError(/WORK_REQUEST_CONFLICT/);
    await expect(
      f.store.write({ ...create(input.item, 'mock-occupied') }, human),
    ).rejects.toThrowError(/WORK_ID_CONFLICT/);
    const edit = {
      id: 'mock-ordered-patch',
      item: input.item,
      revision: 1,
      action: 'update' as const,
      value: { title: '合成稳定补丁', description: '' },
    };
    const first = await f.store.write(edit, human);
    const again = await f.store.write(
      { ...edit, value: { description: '', title: '合成稳定补丁' } },
      human,
    );
    expect(again).toStrictEqual(first);
    expect(
      await f.store.receipt({ ...create('mock-missing', 'mock-unknown') }, human),
    ).toStrictEqual({
      state: 'unknown',
      request: create('mock-missing', 'mock-unknown'),
      actor: human,
    });
  } finally {
    await f.close();
  }
});

test('no-op updates create an operation receipt without inventing edits, authorship or notifications', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write(create(), human);
    const current = await f.store.status();
    const noop = await f.store.write(
      {
        id: 'mock-noop',
        item: first.item.id,
        revision: 1,
        action: 'update',
        value: { title: fields.title },
      },
      bot,
    );
    expect(noop.item).toStrictEqual(first.item);
    expect(noop.acceptedRevision).toBe(1);
    expect((await f.store.status()).revision).toBe(current.revision);
    const restored = await f.store.write(
      { id: 'mock-already-restored', item: first.item.id, revision: 1, action: 'restore' },
      human,
    );
    expect(restored.item).toStrictEqual(first.item);
  } finally {
    await f.close();
  }
});

test('item, operation receipt and global revision commit atomically and cancellation writes nothing', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.file);
  try {
    const controller = new AbortController();
    const cancelled = f.store.write(create(), human, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrowError(/abort/i);
    expect((await f.store.status()).count).toBe(0);
    db.exec(
      "CREATE TRIGGER mock_abort_work BEFORE INSERT ON work_operations BEGIN SELECT RAISE(ABORT,'MOCK_COMMIT_FAILURE'); END",
    );
    await expect(f.store.write(create(), human)).rejects.toThrowError(/MOCK_COMMIT_FAILURE/);
    expect((await f.store.status()).count).toBe(0);
    expect((await f.store.status()).revision).toBe(0);
    expect((await f.store.receipt(create(), human)).state).toBe('unknown');
    db.exec('DROP TRIGGER mock_abort_work');
    await f.store.write(create(), human);
    expect((await f.store.status()).count).toBe(1);
  } finally {
    db.close();
    await f.close();
  }
});

test('stable bounded pages retain old items through edits, literal search and the retained-item quota', async (t) => {
  const started = performance.now();
  let phase = 'fixture',
    writes = 0,
    pages = 0,
    lastError: string | undefined;
  let before: number | undefined;
  let quotaReceiptState: string | undefined;
  const report = (event: string) => {
    process.stderr.write(
      `[work-bounds-phase] ${JSON.stringify({ event, phase, elapsedMs: Math.round(performance.now() - started), writes, pages, cursor: before, quotaReceiptState, lastError, aborted: t.signal.aborted })}\n`,
    );
  };
  const mark = (value: string) => {
    phase = value;
    report('phase');
  };
  // Observe the runner's existing deadline without cancelling or shortening the real write loop.
  const aborted = () => report('test.abort');
  t.signal.addEventListener('abort', aborted, { once: true });
  mark('fixture');
  const f = await fixture();
  try {
    mark('seed');
    for (let index = 0; index < 1000; index++) {
      await f.store.write(
        {
          ...create(`mock-item-${index}`, `mock-create-${index}`),
          value: {
            ...fields,
            title: index === 0 ? 'MOCK_100% LITERAL' : `合成待办 ${index}`,
            progress: '合'.repeat(4000),
          },
        },
        human,
      );
      writes++;
      if (writes === 100 || writes === 500 || writes === 1000) report('seed.progress');
    }
    mark('first-page');
    const first = await f.store.list({ filter: 'all', limit: 50 });
    pages++;
    expect(first.items.length).toBe(50);
    expect.assert(first.nextBefore);
    expect(first.items[0].progress.length).toBe(200);
    expect(first.items[0].progressTruncated).toBe(true);
    expect(Object.hasOwn(first.items[0], 'description')).toBe(false);
    mark('oldest-edit');
    await f.store.write(
      {
        id: 'mock-edit-oldest',
        item: 'mock-item-0',
        revision: 1,
        action: 'update',
        value: { status: 'doing' },
      },
      bot,
    );
    const ids = first.items.map((row) => row.id);
    before = first.nextBefore;
    mark('paging');
    while (before) {
      const next = await f.store.list({ filter: 'all', limit: 50, before });
      pages++;
      ids.push(...next.items.map((row) => row.id));
      before = next.nextBefore;
    }
    expect(ids.length).toBe(1000);
    expect(new Set(ids).size).toBe(1000);
    expect.assert(ids.includes('mock-item-0'));
    mark('literal-search');
    expect((await f.store.list({ text: '_100%' })).items.map((row) => row.id)).toStrictEqual([
      'mock-item-0',
    ]);
    mark('quota');
    await expect(
      f.store.write(create('mock-over-limit', 'mock-over-operation'), human),
    ).rejects.toThrowError(/WORK_LIMIT/);
    mark('quota-receipt');
    const receipt = await f.store.receipt(create('mock-over-limit', 'mock-over-operation'), human);
    quotaReceiptState = receipt.state;
    report('quota.receipt');
    expect(receipt.state).toBe('unknown');
    mark('verified');
  } catch (error) {
    const code = errorCode(error);
    lastError = code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'UNCLASSIFIED';
    report('error');
    throw error;
  } finally {
    mark('close');
    try {
      await f.close(mark).catch((error: unknown) => {
        const code = errorCode(error);
        lastError = code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'UNCLASSIFIED';
        report('error');
        throw error;
      });
      mark('closed');
    } finally {
      t.signal.removeEventListener('abort', aborted);
      report('test.finished');
    }
  }
});

test('closed input validation refuses forged provenance, malformed queries and accidental creates in update paths', async () => {
  const f = await fixture();
  try {
    for (const input of [
      null,
      {},
      { ...create(), actor: bot },
      { ...create(), revision: 1 },
      { ...create(), value: { ...fields, title: '' } },
      { ...create(), value: { ...fields, title: 'x'.repeat(501) } },
      { ...create(), value: { ...fields, status: 'running' } },
      { ...create(), value: { ...fields, description: 'x'.repeat(4001) } },
      {
        id: 'mock-update',
        item: 'mock-missing',
        revision: 0,
        action: 'update',
        value: { title: '合成名称' },
      },
    ])
      await expect(f.store.write(input, human)).rejects.toThrowError(/INVALID_WORK_WRITE/);
    await expect(f.store.write(create(), { kind: 'bot', bot: '../mock' })).rejects.toThrowError(
      /INVALID_WORK_ACTOR/,
    );
    await expect(
      f.store.write(create(), { kind: 'human', bot: 'mock-forged' }),
    ).rejects.toThrowError(/INVALID_WORK_ACTOR/);
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { before: 0 },
      { text: 'x\0' },
      { filter: 'unknown' },
      { bot: 'mock-other' },
    ])
      await expect(f.store.list(query)).rejects.toThrowError(/INVALID_WORK_QUERY/);
    await expect(
      f.store.write(
        {
          id: 'mock-update',
          item: 'mock-missing',
          revision: 1,
          action: 'update',
          value: { title: '合成名称' },
        },
        human,
      ),
    ).rejects.toThrowError(/WORK_NOT_FOUND/);
    expect((await f.store.status()).count).toBe(0);
  } finally {
    await f.close();
  }
});

test('corrupt or linked storage is preserved and closed stores cannot admit new mutations', async () => {
  const f = await fixture();
  try {
    await f.store.write(create(), human);
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE work_items SET status=? WHERE id=?').run('MOCK CORRUPT STATUS', 'mock-item');
    db.close();
    await expect(f.store.get('mock-item')).rejects.toThrowError(/WORK_CORRUPT/);
    await f.reopen().then(
      () => expect.unreachable('corrupt store admitted'),
      () => {},
    );
    expect((await f.store.status()).available).toBe(false);
  } finally {
    await f.close();
  }
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-work-path-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  try {
    const original = path.join(root, 'original');
    await writeFile(original, 'MOCK ORIGINAL BYTES');
    await symlink(original, path.join(root, 'link'));
    await link(original, path.join(root, 'hard'));
    for (const name of ['link', 'hard']) {
      const store = new Work(path.join(root, name));
      await expect(store.ready).rejects.toThrowError(/WORK_CORRUPT/);
      await store.close();
    }
    expect(await readFile(original, 'utf8')).toBe('MOCK ORIGINAL BYTES');
    expect((await lstat(original)).nlink).toBe(2);
    const closed = new Work(path.join(root, 'closed.sqlite'));
    await closed.ready;
    await closed.close();
    await expect(closed.write(create(), human)).rejects.toThrowError(/WORK_CLOSED/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('query filters and author/request shapes cannot be forged through arrays or inherited properties', async () => {
  const f = await fixture();
  try {
    for (const filter of [['all'], { toString: () => 'all' }])
      await expect(f.store.list({ filter })).rejects.toThrowError(/INVALID_WORK_QUERY/);
    await expect(f.store.write(Object.create(create()), human)).rejects.toThrowError(
      /INVALID_WORK_WRITE/,
    );
    await expect(f.store.write(create(), Object.create(human))).rejects.toThrowError(
      /INVALID_WORK_ACTOR/,
    );
    expect((await f.store.status()).count).toBe(0);
  } finally {
    await f.close();
  }
});

test('a malformed private receipt is corruption rather than a different user request and is retained across reopening', async () => {
  const f = await fixture();
  try {
    await f.store.write(create(), human);
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE work_operations SET signature=? WHERE id=?').run(
      'MOCK CORRUPT SIGNATURE',
      'mock-create',
    );
    db.close();
    await expect(f.store.receipt(create(), human)).rejects.toThrowError(/WORK_CORRUPT/);
    await expect(f.reopen()).rejects.toThrowError(/WORK_CORRUPT/);
    expect((await f.store.status()).available).toBe(false);
  } finally {
    await f.close();
  }
});

test('an existing database cannot silently reset a missing global revision authority', async () => {
  const f = await fixture();
  try {
    await f.store.write(create(), human);
    const db = new DatabaseSync(f.file);
    db.exec('DELETE FROM work_meta');
    db.close();
    await expect(f.reopen()).rejects.toThrowError(/WORK_CORRUPT/);
    const inspect = drizzle({ client: new DatabaseSync(f.file, { readOnly: true }) });
    try {
      expect(inspect.select({ n: count() }).from(workItems).get()!.n).toBe(1);
      expect(inspect.select({ n: count() }).from(workMeta).get()!.n).toBe(0);
    } finally {
      inspect.$client.close();
    }
  } finally {
    await f.close();
  }
});

test('loss of revision authority during service life cannot publish an untracked mutation', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.file);
  try {
    await f.store.write(create(), human);
    db.exec('DELETE FROM work_meta');
    await expect(
      f.store.write(
        {
          id: 'mock-untracked',
          item: 'mock-item',
          revision: 1,
          action: 'update',
          value: { status: 'doing' },
        },
        bot,
      ),
    ).rejects.toThrowError(/WORK_CORRUPT/);
    const orm = drizzle({ client: db });
    expect(
      orm
        .select({ status: workItems.status })
        .from(workItems)
        .where(eq(workItems.id, 'mock-item'))
        .get()!.status,
    ).toBe('todo');
    expect(orm.select({ n: count() }).from(workOperations).get()!.n).toBe(1);
  } finally {
    db.close();
    await f.close();
  }
});

test('a storage failure during initial schema creation leaves no partially published authority', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-work-init-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const file = path.join(root, 'work.sqlite');
  const prepare = DatabaseSync.prototype.prepare;
  let injected = false;
  // The baseline migration runs each statement through prepare().
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!injected && /CREATE TABLE `work_operations`/.test(sql)) {
      injected = true;
      return prepare.call(
        this,
        sql.replace(/CREATE TABLE `work_operations`/, 'MOCK_STORAGE_REFUSAL `work_operations`'),
      );
    }
    return prepare.call(this, sql);
  });
  const failed = new Work(file);
  try {
    await expect(failed.ready).rejects.toThrowError(/WORK_CORRUPT/);
    await failed.close();
    expect(injected).toBe(true);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all(),
      ).toStrictEqual([]);
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(0);
    } finally {
      db.close();
    }
    vi.restoreAllMocks();
    const recovered = new Work(file);
    await recovered.ready;
    expect((await recovered.status()).count).toBe(0);
    await recovered.close();
  } finally {
    vi.restoreAllMocks();
    await failed.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
