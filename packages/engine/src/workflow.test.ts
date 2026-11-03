import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkAuthor } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Fault } from './control.js';
import { Work } from './work.js';

const human = { kind: 'human' as const };
const bot = { kind: 'bot' as const, bot: 'mock-beta' };
const fields = {
  title: '合成协调任务',
  description: 'MOCK TASK DATA',
  progress: '',
  status: 'todo' as const,
};
const create = (id = 'mock-card', value: object = {}) => ({
  id: `mock-create-${id}`,
  item: id,
  revision: 0,
  action: 'create',
  value: { ...fields, ...value },
});
async function fixture(admit?: (actor: WorkAuthor) => undefined) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workflow-'));
  const file = path.join(root, 'work.sqlite');
  let store = new Work(file, admit);
  await store.ready;
  return {
    root,
    file,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = new Work(file, admit);
      await store.ready;
    },
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('work metadata persists without replacing unrelated fields and omission differs from explicit reset', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write(
      create('mock-card', { priority: 'high', assignee: 'mock-beta' }),
      human,
    );
    expect(first.item.priority).toBe('high');
    expect(first.item.assignee).toBe('mock-beta');
    const changed = await f.store.write(
      {
        id: 'mock-title',
        item: first.item.id,
        revision: 1,
        action: 'update',
        value: { title: '合成保留负责人' },
      },
      human,
    );
    expect(changed.item.assignee).toBe('mock-beta');
    expect(changed.item.priority).toBe('high');
    await f.reopen();
    expect(await f.store.get(first.item.id)).toStrictEqual(changed.item);
    const reset = await f.store.write(
      {
        id: 'mock-reset',
        item: first.item.id,
        revision: 2,
        action: 'update',
        value: { priority: 'normal', assignee: null },
      },
      human,
    );
    expect(reset.item.priority ?? 'normal').toBe('normal');
    expect(reset.item.assignee ?? null).toBe(null);
    expect(reset.item.title).toBe(changed.item.title);
    await expect(
      f.store.write(
        {
          id: 'mock-stale',
          item: first.item.id,
          revision: 1,
          action: 'update',
          value: { priority: 'urgent' },
        },
        human,
      ),
    ).rejects.toMatchObject({ message: 'WORK_CONFLICT' });
  } finally {
    await f.close();
  }
});

test('assignee admission is checked inside the queued effect, while accepted retries and unrelated human edits stay available', async () => {
  const active = new Set(['mock-beta']);
  const f = await fixture((actor) => {
    if (actor.kind === 'bot' && !active.has(actor.bot)) throw new Fault('UNKNOWN_BOT', 404);
  });
  try {
    const request = create('mock-assigned', { assignee: 'mock-beta' });
    const first = await f.store.write(request, human);
    active.clear();
    expect((await f.store.write(request, human)).item).toStrictEqual(first.item);
    const edited = await f.store.write(
      {
        id: 'mock-human-edit',
        item: first.item.id,
        revision: 1,
        action: 'update',
        value: { description: 'MOCK HUMAN EDIT AFTER ARCHIVE' },
      },
      human,
    );
    expect(edited.item.assignee).toBe('mock-beta');
    const pending = f.store.write(create('mock-queued', { assignee: 'mock-gone' }), human);
    await expect(pending).rejects.toMatchObject({ message: 'UNKNOWN_BOT' });
    await expect(f.store.get('mock-queued')).rejects.toMatchObject({ message: 'WORK_NOT_FOUND' });
    expect(await f.store.get(first.item.id)).toStrictEqual(edited.item);
  } finally {
    await f.close();
  }
});

test('six workflow states preserve completion time, and closed requires an explicit human reopen', async () => {
  const f = await fixture();
  try {
    let item = (await f.store.write(create(), human)).item;
    for (const status of ['review', 'blocked', 'doing', 'done', 'closed']) {
      const old = item;
      item = (
        await f.store.write(
          {
            id: `mock-state-${status}`,
            item: item.id,
            revision: item.revision,
            action: 'update',
            value: { status },
          },
          human,
        )
      ).item;
      if (status === 'done' || status === 'closed') expect.assert(item.completedAt);
      else expect(item.completedAt).toBe(undefined);
      if (status === 'closed') expect(item.completedAt).toBe(old.completedAt);
    }
    await expect(
      f.store.write(
        {
          id: 'mock-silent-reopen',
          item: item.id,
          revision: item.revision,
          action: 'update',
          value: { status: 'todo' },
        },
        human,
      ),
    ).rejects.toMatchObject({ message: 'WORK_REOPEN_REQUIRED' });
    const reopen = {
      id: 'mock-human-reopen',
      item: item.id,
      revision: item.revision,
      action: 'reopen',
    };
    await expect(f.store.write(reopen, bot)).rejects.toMatchObject({
      message: 'WORK_REOPEN_FORBIDDEN',
    });
    const opened = await f.store.write(reopen, human);
    expect(opened.item.status).toBe('todo');
    expect(opened.item.completedAt).toBe(undefined);
    const closed = await f.store.write(
      {
        id: 'mock-reclose',
        item: item.id,
        revision: opened.item.revision,
        action: 'update',
        value: { status: 'closed' },
      },
      human,
    );
    const retried = await f.store.write(reopen, human);
    expect(retried.acceptedRevision).toBe(opened.acceptedRevision);
    expect(retried.item).toStrictEqual(closed.item);
  } finally {
    await f.close();
  }
});

test('filtered pages bind priority, responsible Bot and workflow while retaining the stable creation cursor', async () => {
  const f = await fixture();
  try {
    for (const [id, status, priority, assignee] of [
      ['mock-a', 'review', 'urgent', 'mock-beta'],
      ['mock-b', 'blocked', 'low', 'mock-beta'],
      ['mock-c', 'done', 'normal', null],
      ['mock-d', 'closed', 'high', null],
    ] as const)
      await f.store.write(create(id, { status, priority, assignee }), human);
    expect((await f.store.list({ filter: 'open' })).items.length).toBe(2);
    expect((await f.store.list({ filter: 'done' })).items.length).toBe(2);
    const page = await f.store.list({ filter: 'all', limit: 2 });
    expect.assert(page.nextBefore);
    const first = await f.store.get('mock-a');
    await f.store.write(
      {
        id: 'mock-priority-edit',
        item: first.id,
        revision: first.revision,
        action: 'update',
        value: { priority: 'high' },
      },
      human,
    );
    const filtered = await f.store.list({
      status: 'review',
      priority: 'high',
      assignee: 'mock-beta',
    });
    expect(filtered.items.map((x) => x.id)).toStrictEqual(['mock-a']);
    expect((await f.store.list({ assignee: null })).items.map((x) => x.id)).toStrictEqual([
      'mock-d',
      'mock-c',
    ]);
    expect(
      (await f.store.list({ filter: 'all', before: page.nextBefore })).items.map((x) => x.id),
    ).toStrictEqual(['mock-b', 'mock-a']);
  } finally {
    await f.close();
  }
});

test('schema3 validates stored assignees instead of adopting an invalid private path', async () => {
  const f = await fixture();
  try {
    await f.store.write(create('mock-corrupt', { priority: 'high', assignee: 'mock-beta' }), human);
    await f.store.close();
    const db = new DatabaseSync(f.file);
    db.prepare("UPDATE work_items SET assignee='../mock-private' WHERE id='mock-corrupt'").run();
    db.close();
    const bad = new Work(f.file);
    await expect(bad.ready).rejects.toMatchObject({ message: 'WORK_CORRUPT' });
    await bad.close();
  } finally {
    await f.close();
  }
});

async function legacyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workflow-legacy-'));
  const file = path.join(root, 'work.sqlite');
  const db = new DatabaseSync(file);
  const at = '2026-01-01T00:00:00.000Z';
  const request = create('mock-legacy');
  const comment = {
    id: 'mock-legacy-comment',
    item: request.item,
    revision: 1,
    body: 'MOCK LEGACY DISCUSSION',
  };
  const { createHash } = await import('node:crypto');
  const { workKey, workCommentKey, isWorkWrite } = await import('@daban/protocol');
  expect.assert(isWorkWrite(request));
  db.exec(`
    CREATE TABLE work_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,progress TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,completed TEXT,creator TEXT NOT NULL,editor TEXT NOT NULL) STRICT;
    CREATE TABLE work_operations(id TEXT PRIMARY KEY,item TEXT NOT NULL REFERENCES work_items(id),signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;
    CREATE TABLE work_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,comments INTEGER NOT NULL DEFAULT 0 CHECK(comments>=0)) STRICT;
    CREATE TABLE work_comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,item TEXT NOT NULL REFERENCES work_items(id),body TEXT NOT NULL,creator TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;
    INSERT INTO work_meta VALUES(1,2,1);
    PRAGMA user_version=2;
  `);
  const author = JSON.stringify(human);
  db.prepare(
    'INSERT INTO work_items(id,title,description,progress,status,revision,deleted,created,updated,completed,creator,editor) VALUES(?,?,?,?,?,2,0,?,?,NULL,?,?)',
  ).run(request.item, fields.title, fields.description, '', 'todo', at, at, author, author);
  db.prepare('INSERT INTO work_operations VALUES(?,?,?,?,?)').run(
    request.id,
    request.item,
    createHash('sha256').update(workKey(request, human)).digest('hex'),
    1,
    at,
  );
  db.prepare(
    'INSERT INTO work_comments(id,item,body,creator,signature,revision,at) VALUES(?,?,?,?,?,2,?)',
  ).run(
    comment.id,
    comment.item,
    comment.body,
    author,
    createHash('sha256').update(workCommentKey(comment, human)).digest('hex'),
    at,
  );
  db.close();
  return { root, file, request, comment };
}

test('schema2 migration preserves literal comments, old receipts and all old row fields', async () => {
  const f = await legacyFixture();
  const before = new DatabaseSync(f.file, { readOnly: true });
  const columns = before
    .prepare('PRAGMA table_info(work_items)')
    .all()
    .map((row) => String(row.name));
  const oldRows = before.prepare('SELECT * FROM work_items').all();
  const oldComments = before.prepare('SELECT * FROM work_comments').all();
  const oldOperations = before.prepare('SELECT * FROM work_operations').all();
  before.close();
  const store = new Work(f.file);
  try {
    await store.ready;
    const after = new DatabaseSync(f.file, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(after.prepare(`SELECT ${columns.join(',')} FROM work_items`).all()).toStrictEqual(
      oldRows,
    );
    expect(after.prepare('SELECT * FROM work_comments').all()).toStrictEqual(oldComments);
    expect(after.prepare('SELECT * FROM work_operations').all()).toStrictEqual(oldOperations);
    after.close();
    const receipt = await store.write(f.request, human);
    expect(receipt.acceptedRevision).toBe(1);
    expect(receipt.item.revision).toBe(2);
    const changed = await store.write(
      {
        id: 'mock-new-metadata',
        item: f.request.item,
        revision: 2,
        action: 'update',
        value: { priority: 'urgent', assignee: 'mock-beta' },
      },
      human,
    );
    const comment = await store.commentReceipt(f.comment, human);
    expect(comment.state).toBe('complete');
    if (comment.state === 'complete') {
      expect(comment.acceptedRevision).toBe(2);
      expect(comment.item).toStrictEqual(changed.item);
    }
    expect(
      (await store.comments({ item: f.request.item })).comments.map((row) => row.body),
    ).toStrictEqual([f.comment.body]);
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('invalid schema2 workflow rows are refused before any migration is committed', async () => {
  const f = await legacyFixture();
  const db = new DatabaseSync(f.file);
  db.exec("UPDATE work_items SET status='review'");
  db.close();
  const store = new Work(f.file);
  try {
    await expect(store.ready).rejects.toMatchObject({ message: 'WORK_CORRUPT' });
    const after = new DatabaseSync(f.file, { readOnly: true });
    expect(after.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
    expect(
      after
        .prepare('PRAGMA table_info(work_items)')
        .all()
        .some((row) => row.name === 'priority'),
    ).toBe(false);
    after.close();
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an empty schema3 store missing a metadata column fails before it can accept work', async () => {
  const f = await fixture();
  await f.store.close();
  const db = new DatabaseSync(f.file);
  db.exec('ALTER TABLE work_items DROP COLUMN assignee');
  db.close();
  const broken = new Work(f.file);
  try {
    await expect(broken.ready).rejects.toMatchObject({ message: 'WORK_CORRUPT' });
  } finally {
    await broken.close();
    await f.close();
  }
});

test('foreign legacy columns are rejected before schema adoption rather than after commit', async () => {
  const f = await legacyFixture();
  const db = new DatabaseSync(f.file);
  db.exec('ALTER TABLE work_items ADD COLUMN mock_foreign TEXT');
  db.close();
  const store = new Work(f.file);
  try {
    await expect(store.ready).rejects.toMatchObject({ message: 'WORK_CORRUPT' });
    const check = new DatabaseSync(f.file, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
    expect(
      check
        .prepare('PRAGMA table_info(work_items)')
        .all()
        .some((row) => row.name === 'priority'),
    ).toBe(false);
    check.close();
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
