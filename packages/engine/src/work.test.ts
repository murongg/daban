import assert from 'node:assert/strict';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Work } from './work.js';

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
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-'));
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
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('shared work preserves immutable creation provenance and current progress without representing an Agent run', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write(
      { ...create(), value: { ...fields, title: '  合成共享待办  ' } },
      human,
    );
    assert.equal(first.state, 'complete');
    assert.equal(first.item.title, fields.title);
    assert.equal(first.item.status, 'todo');
    assert.equal(first.item.completedAt, undefined);
    assert.deepEqual(first.item.createdBy, human);
    assert.deepEqual(first.item.updatedBy, human);
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
    assert.equal(edited.item.revision, 2);
    assert.equal(edited.item.progress, 'MOCK VERIFIED PROGRESS');
    assert.deepEqual(edited.item.createdBy, human);
    assert.deepEqual(edited.item.updatedBy, bot);
    assert.equal(edited.item.description, fields.description);
    assert.equal((await f.store.list({ filter: 'open' })).items.length, 1);
    assert.equal((await f.store.status()).revision, 2);
    edited.item.title = 'MOCK MUTATED REPLY';
    assert.equal((await f.store.get(first.item.id)).title, fields.title);
    assert.equal(Object.hasOwn(await f.store.get(first.item.id), 'runId'), false);
  } finally {
    await f.close();
  }
});

test('completion and reopening have stable timestamps, and soft trash keeps exact content for restoration', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write({ ...create(), value: { ...fields, status: 'done' } }, bot);
    assert.equal(first.item.completedAt, first.item.createdAt);
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
    assert.equal(changed.item.completedAt, first.item.completedAt);
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
    assert.equal(reopened.item.completedAt, undefined);
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
    assert.equal(done.item.completedAt, done.item.updatedAt);
    const trashRequest = {
      id: 'mock-trash',
      item: first.item.id,
      revision: 4,
      action: 'trash' as const,
    };
    const trashed = await f.store.write(trashRequest, human);
    assert.equal(trashed.item.deleted, true);
    assert.equal(trashed.item.description, 'MOCK EDITED DESCRIPTION');
    assert.equal((await f.store.list()).items.length, 0);
    assert.equal((await f.store.list({ filter: 'trash' })).items.length, 1);
    await assert.rejects(
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
      /WORK_TRASHED/,
    );
    const restored = await f.store.write(
      { id: 'mock-restore', item: first.item.id, revision: 5, action: 'restore' },
      human,
    );
    assert.equal(restored.item.deleted, false);
    assert.equal(restored.item.status, 'done');
    assert.equal(restored.item.completedAt, done.item.completedAt);
    assert.deepEqual((await f.store.write(trashRequest, human)).item, restored.item);
  } finally {
    await f.close();
  }
});

test('accepted operations survive restart and return later state without overwriting a human edit', async () => {
  const f = await fixture();
  const input = create();
  try {
    assert.deepEqual(await f.store.receipt(input, bot), {
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
      assert.ok(read.state === 'complete');
      assert.equal(read.acceptedRevision, 1);
      assert.equal(read.acceptedAt, first.acceptedAt);
      assert.deepEqual(read.item, edited.item);
    }
    assert.equal((await f.store.list({ filter: 'all' })).items.length, 1);
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
    assert.equal(first.item.title, fields.title);
    assert.deepEqual(first.item.createdBy, bot);
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
    assert.equal(writes.filter((row) => row.status === 'fulfilled').length, 1);
    const rejected = writes.find((row) => row.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.match(String(rejected.reason), /WORK_CONFLICT/);
    assert.equal((await f.store.get(input.item)).revision, 2);
    const original = create();
    const read = f.store.receipt(original, { ...bot });
    original.value.title = 'MOCK LATE READ';
    const receipt = await read;
    assert.ok(receipt.state === 'complete');
    assert.ok(receipt.request.action === 'create');
    assert.equal(receipt.request.value.title, fields.title);
  } finally {
    await f.close();
  }
});

test('operation identity binds actor and exact fields while equivalent patch key order stays retryable', async () => {
  const f = await fixture();
  try {
    const input = create();
    await f.store.write(input, bot);
    await assert.rejects(
      f.store.write({ ...input, value: { ...fields, title: '合成不同请求' } }, bot),
      /WORK_REQUEST_CONFLICT/,
    );
    await assert.rejects(f.store.receipt(input, human), /WORK_REQUEST_CONFLICT/);
    await assert.rejects(
      f.store.write({ ...create(input.item, 'mock-occupied') }, human),
      /WORK_ID_CONFLICT/,
    );
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
    assert.deepEqual(again, first);
    assert.deepEqual(await f.store.receipt({ ...create('mock-missing', 'mock-unknown') }, human), {
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
    assert.deepEqual(noop.item, first.item);
    assert.equal(noop.acceptedRevision, 1);
    assert.equal((await f.store.status()).revision, current.revision);
    const restored = await f.store.write(
      { id: 'mock-already-restored', item: first.item.id, revision: 1, action: 'restore' },
      human,
    );
    assert.deepEqual(restored.item, first.item);
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
    await assert.rejects(cancelled, /abort/i);
    assert.equal((await f.store.status()).count, 0);
    db.exec(
      "CREATE TRIGGER mock_abort_work BEFORE INSERT ON work_operations BEGIN SELECT RAISE(ABORT,'MOCK_COMMIT_FAILURE'); END",
    );
    await assert.rejects(f.store.write(create(), human), /MOCK_COMMIT_FAILURE/);
    assert.equal((await f.store.status()).count, 0);
    assert.equal((await f.store.status()).revision, 0);
    assert.equal((await f.store.receipt(create(), human)).state, 'unknown');
    db.exec('DROP TRIGGER mock_abort_work');
    await f.store.write(create(), human);
    assert.equal((await f.store.status()).count, 1);
  } finally {
    db.close();
    await f.close();
  }
});

test('stable bounded pages retain old items through edits, literal search and the retained-item quota', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 1000; index++)
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
    const first = await f.store.list({ filter: 'all', limit: 50 });
    assert.equal(first.items.length, 50);
    assert.ok(first.nextBefore);
    assert.equal(first.items[0].progress.length, 200);
    assert.equal(first.items[0].progressTruncated, true);
    assert.equal(Object.hasOwn(first.items[0], 'description'), false);
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
    let before: number | undefined = first.nextBefore;
    while (before) {
      const next = await f.store.list({ filter: 'all', limit: 50, before });
      ids.push(...next.items.map((row) => row.id));
      before = next.nextBefore;
    }
    assert.equal(ids.length, 1000);
    assert.equal(new Set(ids).size, 1000);
    assert.ok(ids.includes('mock-item-0'));
    assert.deepEqual(
      (await f.store.list({ text: '_100%' })).items.map((row) => row.id),
      ['mock-item-0'],
    );
    await assert.rejects(
      f.store.write(create('mock-over-limit', 'mock-over-operation'), human),
      /WORK_LIMIT/,
    );
    assert.equal(
      (await f.store.receipt(create('mock-over-limit', 'mock-over-operation'), human)).state,
      'unknown',
    );
  } finally {
    await f.close();
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
      await assert.rejects(f.store.write(input, human), /INVALID_WORK_WRITE/);
    await assert.rejects(
      f.store.write(create(), { kind: 'bot', bot: '../mock' }),
      /INVALID_WORK_ACTOR/,
    );
    await assert.rejects(
      f.store.write(create(), { kind: 'human', bot: 'mock-forged' }),
      /INVALID_WORK_ACTOR/,
    );
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { before: 0 },
      { text: 'x\0' },
      { filter: 'unknown' },
      { bot: 'mock-other' },
    ])
      await assert.rejects(f.store.list(query), /INVALID_WORK_QUERY/);
    await assert.rejects(
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
      /WORK_NOT_FOUND/,
    );
    assert.equal((await f.store.status()).count, 0);
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
    await assert.rejects(f.store.get('mock-item'), /WORK_CORRUPT/);
    await f.reopen().then(
      () => assert.fail('corrupt store admitted'),
      () => {},
    );
    assert.equal((await f.store.status()).available, false);
  } finally {
    await f.close();
  }
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-path-'));
  try {
    const original = path.join(root, 'original');
    await writeFile(original, 'MOCK ORIGINAL BYTES');
    await symlink(original, path.join(root, 'link'));
    await link(original, path.join(root, 'hard'));
    for (const name of ['link', 'hard']) {
      const store = new Work(path.join(root, name));
      await assert.rejects(store.ready, /WORK_CORRUPT/);
      await store.close();
    }
    assert.equal(await readFile(original, 'utf8'), 'MOCK ORIGINAL BYTES');
    assert.equal((await lstat(original)).nlink, 2);
    const closed = new Work(path.join(root, 'closed.sqlite'));
    await closed.ready;
    await closed.close();
    await assert.rejects(closed.write(create(), human), /WORK_CLOSED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('query filters and author/request shapes cannot be forged through arrays or inherited properties', async () => {
  const f = await fixture();
  try {
    for (const filter of [['all'], { toString: () => 'all' }])
      await assert.rejects(f.store.list({ filter }), /INVALID_WORK_QUERY/);
    await assert.rejects(f.store.write(Object.create(create()), human), /INVALID_WORK_WRITE/);
    await assert.rejects(f.store.write(create(), Object.create(human)), /INVALID_WORK_ACTOR/);
    assert.equal((await f.store.status()).count, 0);
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
    await assert.rejects(f.store.receipt(create(), human), /WORK_CORRUPT/);
    await assert.rejects(f.reopen(), /WORK_CORRUPT/);
    assert.equal((await f.store.status()).available, false);
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
    await assert.rejects(f.reopen(), /WORK_CORRUPT/);
    const inspect = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM work_items').get()!.count, 1);
      assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM work_meta').get()!.count, 0);
    } finally {
      inspect.close();
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
    await assert.rejects(
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
      /WORK_CORRUPT/,
    );
    assert.equal(
      db.prepare('SELECT status FROM work_items WHERE id=?').get('mock-item')!.status,
      'todo',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_operations').get()!.count, 1);
  } finally {
    db.close();
    await f.close();
  }
});

test('a storage failure during initial schema creation leaves no partially published authority', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-init-'));
  const file = path.join(root, 'work.sqlite');
  const execute = DatabaseSync.prototype.exec;
  let injected = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (!injected && /CREATE TABLE(?: IF NOT EXISTS)? work_operations/.test(sql)) {
      injected = true;
      return execute.call(
        this,
        sql.replace(
          /CREATE TABLE(?: IF NOT EXISTS)? work_operations/,
          'MOCK_STORAGE_REFUSAL work_operations',
        ),
      );
    }
    return execute.call(this, sql);
  });
  const failed = new Work(file);
  try {
    await assert.rejects(failed.ready, /WORK_CORRUPT/);
    await failed.close();
    assert.equal(injected, true);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all(),
        [],
      );
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
    } finally {
      db.close();
    }
    t.mock.restoreAll();
    const recovered = new Work(file);
    await recovered.ready;
    assert.equal((await recovered.status()).count, 0);
    await recovered.close();
  } finally {
    t.mock.restoreAll();
    await failed.close();
    await rm(root, { recursive: true, force: true });
  }
});
