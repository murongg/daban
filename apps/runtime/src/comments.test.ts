import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isWorkCommentReceipt, workKey } from '@daban/protocol';
import { Work } from './work.js';

const human = { kind: 'human' as const };
const bot = { kind: 'bot' as const, bot: 'mock-alpha' };
const fields = {
  title: '合成讨论任务',
  description: 'MOCK DETAIL',
  progress: 'MOCK PROGRESS',
  status: 'todo' as const,
};
const create = {
  id: 'mock-create',
  item: 'mock-card',
  action: 'create' as const,
  revision: 0 as const,
  value: fields,
};
const input = (id = 'mock-comment', revision = 1) => ({
  id,
  item: create.item,
  revision,
  body: '  MOCK COMMENT\n合成讨论内容。  ',
});
async function fixture(legacy = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-comments-')),
    file = path.join(root, 'work.sqlite');
  if (legacy) {
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE work_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,progress TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,completed TEXT,creator TEXT NOT NULL,editor TEXT NOT NULL) STRICT;
      CREATE TABLE work_operations(id TEXT PRIMARY KEY,item TEXT NOT NULL REFERENCES work_items(id),signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;
      CREATE TABLE work_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
      INSERT INTO work_meta VALUES(1,1);PRAGMA user_version=1;`);
    const at = '2026-01-01T00:00:00.000Z';
    db.prepare(
      'INSERT INTO work_items(id,title,description,progress,status,revision,deleted,created,updated,completed,creator,editor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      create.item,
      fields.title,
      fields.description,
      fields.progress,
      'todo',
      1,
      0,
      at,
      at,
      null,
      JSON.stringify(human),
      JSON.stringify(human),
    );
    db.prepare('INSERT INTO work_operations VALUES(?,?,?,?,?)').run(
      create.id,
      create.item,
      createHash('sha256').update(workKey(create, human)).digest('hex'),
      1,
      at,
    );
    db.close();
  }
  let store = new Work(file);
  await store.ready;
  if (!legacy) await store.write(create, human);
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

test('additive migration retains legacy items, fingerprints and accepted receipts', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.store.get(create.item)).revision, 1);
    assert.equal((await f.store.receipt(create, human)).state, 'complete');
    assert.deepEqual(await f.store.comments({ item: create.item }), {
      item: create.item,
      revision: 1,
      comments: [],
    });
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()!.n, 1);
      assert.equal(
        db.prepare('SELECT signature FROM work_operations').get()!.signature,
        createHash('sha256').update(workKey(create, human)).digest('hex'),
      );
      assert.equal(db.prepare('SELECT comments FROM work_meta').get()!.comments, 0);
    } finally {
      db.close();
    }
    await f.store.comment(input(), bot);
    await f.reopen();
    const old = await f.store.receipt(create, human);
    assert.equal(old.state, 'complete');
    if (old.state === 'complete') {
      assert.equal(old.acceptedRevision, 1);
      assert.equal(old.item.revision, 2);
    }
  } finally {
    await f.close();
  }
});

test('comments keep literal text/provenance and touch only current item version, time and editor', async () => {
  const f = await fixture();
  try {
    const request = input();
    const response = await f.store.comment(request, bot);
    assert.equal(isWorkCommentReceipt(response), true);
    assert.equal(response.acceptedRevision, 2);
    assert.equal(response.item.revision, 2);
    assert.equal(response.comment.body, request.body);
    assert.equal(response.comment.id, request.id);
    assert.deepEqual(response.comment.createdBy, bot);
    assert.deepEqual(response.item.updatedBy, bot);
    assert.deepEqual(response.item.createdBy, human);
    for (const key of ['title', 'description', 'progress', 'status'] as const)
      assert.equal(response.item[key], fields[key]);
    assert.equal(response.item.completedAt, undefined);
    assert.equal((await f.store.status()).revision, 2);
    response.comment.body = 'MOCK MUTATED REPLY';
    assert.equal((await f.store.comments({ item: create.item })).comments[0].body, request.body);
    assert.equal(Object.hasOwn(response, 'runId'), false);
    await f.reopen();
    assert.equal((await f.store.comments({ item: create.item })).comments.length, 1);
  } finally {
    await f.close();
  }
});

test('exact current-state receipt precedes CAS/trash across reopen and global operation-ID conflicts', async () => {
  const f = await fixture();
  try {
    const request = input();
    await f.store.comment(request, bot);
    const newer = await f.store.write(
      {
        id: 'mock-edit',
        item: create.item,
        revision: 2,
        action: 'update',
        value: { description: 'MOCK NEWER HUMAN', status: 'done' },
      },
      human,
    );
    await f.store.write(
      { id: 'mock-trash', item: create.item, revision: 3, action: 'trash' },
      human,
    );
    await f.reopen();
    const reply = await f.store.comment(request, bot);
    assert.equal(reply.acceptedRevision, 2);
    assert.equal(reply.item.revision, 4);
    assert.equal(reply.item.deleted, true);
    assert.equal(reply.item.description, newer.item.description);
    assert.equal(reply.item.completedAt, newer.item.completedAt);
    assert.deepEqual(await f.store.commentReceipt(request, bot), reply);
    assert.equal((await f.store.comments({ item: create.item })).comments.length, 1);
    for (const [arg, actor] of [
      [{ ...request, body: 'MOCK CHANGED' }, bot],
      [request, human],
      [{ ...request, item: 'mock-other' }, bot],
    ] as const)
      await assert.rejects(f.store.commentReceipt(arg, actor), { code: 'WORK_REQUEST_CONFLICT' });
    await assert.rejects(f.store.comment({ ...input(create.id), revision: 4 }, human), {
      code: 'WORK_REQUEST_CONFLICT',
    });
    await assert.rejects(
      f.store.write({ id: request.id, item: create.item, revision: 4, action: 'restore' }, bot),
      { code: 'WORK_REQUEST_CONFLICT' },
    );
    await f.store.write(
      { id: 'mock-restore', item: create.item, revision: 4, action: 'restore' },
      human,
    );
    const next = await f.store.comment(input('mock-after-restore', 5), human);
    assert.equal(next.item.status, 'done');
    assert.equal(next.item.completedAt, newer.item.completedAt);
  } finally {
    await f.close();
  }
});

test('two queued writers capture one revision and failed CAS leaves no comment receipt', async () => {
  const f = await fixture();
  try {
    const a = input('mock-first'),
      b = input('mock-second');
    const both = await Promise.allSettled([f.store.comment(a, bot), f.store.comment(b, human)]);
    assert.equal(both[0].status, 'fulfilled');
    assert.equal(both[1].status, 'rejected');
    if (both[1].status === 'rejected') assert.equal(both[1].reason.code, 'WORK_CONFLICT');
    assert.equal((await f.store.commentReceipt(b, human)).state, 'unknown');
    assert.equal((await f.store.get(create.item)).revision, 2);
    await f.store.write(
      { id: 'mock-trash', item: create.item, revision: 2, action: 'trash' },
      human,
    );
    await assert.rejects(f.store.comment(input('mock-trashed', 3), human), {
      code: 'WORK_TRASHED',
    });
    assert.equal((await f.store.commentReceipt(input('mock-trashed', 3), human)).state, 'unknown');
    assert.equal((await f.store.comments({ item: create.item })).comments.length, 1);
  } finally {
    await f.close();
  }
});

test('paging is item-bound, stable under later edits and bounded by count and serialized bytes', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 4; i++)
      await f.store.comment({ ...input(`mock-page-${i}`, i), body: `MOCK ${i}` }, human);
    const first = await f.store.comments({ item: create.item, limit: 2 });
    assert.deepEqual(
      first.comments.map((c) => c.body),
      ['MOCK 4', 'MOCK 3'],
    );
    assert.ok(first.nextBefore);
    await f.store.comment({ ...input('mock-large', 5), body: '\u0001'.repeat(10000) }, bot);
    await f.store.comment({ ...input('mock-large-b', 6), body: '\u0001'.repeat(10000) }, bot);
    await f.store.comment({ ...input('mock-large-c', 7), body: '\u0001'.repeat(10000) }, bot);
    const bounded = await f.store.comments({ item: create.item, limit: 50 });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 128 * 1024);
    assert.ok(bounded.nextBefore);
    assert.ok(bounded.comments.length < 7);
    const next = await f.store.comments({ item: create.item, limit: 2, before: first.nextBefore });
    assert.deepEqual(
      next.comments.map((c) => c.body),
      ['MOCK 2', 'MOCK 1'],
    );
    await f.store.write({ ...create, id: 'mock-other-create', item: 'mock-other' }, human);
    assert.deepEqual(
      (await f.store.comments({ item: 'mock-other', before: first.nextBefore })).comments,
      [],
    );
    await assert.rejects(f.store.comments({ item: 'mock-missing' }), { code: 'WORK_NOT_FOUND' });
  } finally {
    await f.close();
  }
});

test('invalid inputs, cancellation, queued argument mutation and close preserve accepted data', async () => {
  const f = await fixture();
  try {
    for (const value of [
      { ...input(), body: '  ' },
      { ...input(), body: 'x'.repeat(10001) },
      { ...input(), actor: bot },
      { ...input(), revision: 0 },
    ])
      await assert.rejects(f.store.comment(value, human), { code: 'INVALID_WORK_COMMENT' });
    await assert.rejects(f.store.comment(input(), { kind: 'human', bot: 'mock-spoof' }), {
      code: 'INVALID_WORK_ACTOR',
    });
    await assert.rejects(f.store.comments({ item: create.item, limit: 51 }), {
      code: 'INVALID_WORK_QUERY',
    });
    const abort = new AbortController();
    abort.abort(new Error('MOCK CANCELLED'));
    await assert.rejects(
      f.store.comment(input('mock-cancel'), human, abort.signal),
      /MOCK CANCELLED/,
    );
    assert.equal((await f.store.commentReceipt(input('mock-cancel'), human)).state, 'unknown');
    const mutable = input('mock-captured');
    const saved = mutable.body;
    const pending = f.store.comment(mutable, human);
    mutable.body = 'MOCK MUTATED CALL';
    assert.equal((await pending).comment.body, saved);
    await f.store.close();
    await assert.rejects(f.store.comment(input('mock-closed', 2), human), { code: 'WORK_CLOSED' });
  } finally {
    await f.close();
  }
});

test('comments and legacy writes share one retained operation capacity', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      const add = db.prepare('INSERT INTO work_operations VALUES(?,?,?,?,?)');
      db.exec('BEGIN');
      for (let i = 0; i < 9998; i++)
        add.run(`mock-padding-${i}`, create.item, '0'.repeat(64), 1, '2026-01-01T00:00:00.000Z');
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    await f.store.comment(input(), human);
    await assert.rejects(f.store.comment(input('mock-over', 2), human), {
      code: 'WORK_OPERATION_LIMIT',
    });
    await assert.rejects(
      f.store.write(
        {
          id: 'mock-over-write',
          item: create.item,
          revision: 2,
          action: 'update',
          value: { progress: 'MOCK' },
        },
        human,
      ),
      { code: 'WORK_OPERATION_LIMIT' },
    );
    assert.equal((await f.store.get(create.item)).revision, 2);
  } finally {
    await f.close();
  }
});

test('comment corruption and missing append-only authority are not silently adopted', async () => {
  for (const sql of [
    "UPDATE work_comments SET body='MOCK TAMPER'",
    'DELETE FROM work_comments',
    'UPDATE work_meta SET comments=0',
    'UPDATE work_meta SET revision=1',
  ]) {
    const f = await fixture();
    try {
      await f.store.comment(input(), human);
      await f.store.close();
      const db = new DatabaseSync(f.file);
      db.exec(sql);
      db.close();
      await assert.rejects(f.reopen(), { code: 'WORK_CORRUPT' });
      assert.deepEqual(await f.store.status(), { available: false, error: 'WORK_CORRUPT' });
    } finally {
      await f.close();
    }
  }
});

test('a comment transaction rollback does not publish text, version or authority', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.file);
    db.exec(
      "CREATE TRIGGER mock_comment_abort BEFORE INSERT ON work_comments BEGIN SELECT RAISE(ABORT,'MOCK ROLLBACK'); END;",
    );
    db.close();
    await assert.rejects(f.store.comment(input(), human), /MOCK ROLLBACK/);
    assert.equal((await f.store.get(create.item)).revision, 1);
    assert.equal((await f.store.status()).revision, 1);
    assert.equal((await f.store.commentReceipt(input(), human)).state, 'unknown');
    assert.equal((await f.store.comments({ item: create.item })).comments.length, 0);
  } finally {
    await f.close();
  }
});

test('initialization and schema1 migration publish comments and version atomically', async () => {
  for (const legacy of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-comment-migrate-'));
    const file = path.join(root, 'work.sqlite');
    if (legacy) {
      const initial = new Work(file);
      await initial.ready;
      await initial.write(create, human);
      await initial.close();
      const db = new DatabaseSync(file);
      db.exec(
        'DROP TABLE work_comments;ALTER TABLE work_meta DROP COLUMN comments;ALTER TABLE work_items DROP COLUMN priority;ALTER TABLE work_items DROP COLUMN assignee;PRAGMA user_version=1;',
      );
      db.close();
    }
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
      const result = original.call(this, sql);
      if (/CREATE TABLE work_comments\b/.test(sql)) {
        injected = true;
        throw Error('MOCK SCHEMA FAILURE');
      }
      return result;
    };
    let broken: Work | undefined;
    try {
      broken = new Work(file);
      await assert.rejects(broken.ready, { code: 'WORK_CORRUPT' });
    } finally {
      DatabaseSync.prototype.exec = original;
      await broken?.close();
    }
    try {
      assert.equal(injected, true);
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, legacy ? 1 : 0);
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='work_comments'").get()!.n,
          0,
        );
        if (legacy) {
          assert.deepEqual(
            db
              .prepare('PRAGMA table_info(work_meta)')
              .all()
              .map((row) => row.name),
            ['id', 'revision'],
          );
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_items').get()!.n, 1);
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_operations').get()!.n, 1);
        } else
          assert.equal(
            db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()!.n,
            0,
          );
      } finally {
        db.close();
      }
      const retry = new Work(file);
      await retry.ready;
      try {
        if (legacy) assert.equal((await retry.receipt(create, human)).state, 'complete');
      } finally {
        await retry.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('unknown schemas and malformed legacy rows are retained without migration', async () => {
  for (const mutation of [
    'PRAGMA user_version=99',
    'CREATE TABLE mock_foreign(value TEXT)',
    "UPDATE work_items SET creator='MOCK INVALID JSON'",
    'UPDATE work_meta SET revision=0',
    'DELETE FROM work_operations',
  ]) {
    const f = await fixture();
    try {
      await f.store.close();
      const db = new DatabaseSync(f.file);
      db.exec(
        'DROP TABLE work_comments;ALTER TABLE work_meta DROP COLUMN comments;ALTER TABLE work_items DROP COLUMN priority;ALTER TABLE work_items DROP COLUMN assignee;PRAGMA user_version=1;',
      );
      db.exec(mutation);
      db.close();
      await assert.rejects(f.reopen(), { code: 'WORK_CORRUPT' });
      const check = new DatabaseSync(f.file, { readOnly: true });
      try {
        assert.equal(
          check.prepare('PRAGMA user_version').get()!.user_version,
          mutation.includes('99') ? 99 : 1,
        );
        assert.equal(
          check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='work_comments'").get()!
            .n,
          0,
        );
        assert.deepEqual(
          check
            .prepare('PRAGMA table_info(work_meta)')
            .all()
            .map((row) => row.name),
          ['id', 'revision'],
        );
      } finally {
        check.close();
      }
    } finally {
      await f.close();
    }
  }
});

test('valid-shaped but rewound or inflated authority cannot publish a comment', async () => {
  for (const revision of [0, 10000]) {
    const f = await fixture();
    try {
      const db = new DatabaseSync(f.file);
      db.prepare('UPDATE work_meta SET revision=?').run(revision);
      db.close();
      await assert.rejects(f.store.comment(input(), human), { code: 'WORK_CORRUPT' });
      assert.equal((await f.store.get(create.item)).revision, 1);
      assert.deepEqual(await f.store.status(), { available: false, error: 'WORK_CORRUPT' });
    } finally {
      await f.close();
    }
  }
});

test('immediate close drains schema initialization without misclassifying the store as corrupt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-comment-close-'));
  const file = path.join(root, 'work.sqlite');
  const store = new Work(file);
  try {
    await store.close();
    assert.deepEqual(await store.status(), { available: false, error: 'WORK_CLOSED' });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
    } finally {
      db.close();
    }
    const reopened = new Work(file);
    await reopened.ready;
    try {
      assert.deepEqual(await reopened.status(), { available: true, revision: 0, count: 0 });
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a legacy edit after clock rollback cannot make accepted discussion history unreadable', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE work_items SET updated=? WHERE id=?').run(
      '2099-01-01T00:00:00.000Z',
      create.item,
    );
    db.close();
    const accepted = await f.store.comment(input(), bot);
    const edited = await f.store.write(
      {
        id: 'mock-after-clock',
        item: create.item,
        revision: 2,
        action: 'update',
        value: { progress: 'MOCK AFTER CLOCK CHANGE' },
      },
      human,
    );
    assert.ok(Date.parse(edited.item.updatedAt) >= Date.parse(accepted.acceptedAt));
    await f.reopen();
    assert.equal((await f.store.comments({ item: create.item })).comments.length, 1);
    assert.equal((await f.store.commentReceipt(input(), bot)).state, 'complete');
  } finally {
    await f.close();
  }
});
