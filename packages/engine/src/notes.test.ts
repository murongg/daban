import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  isNoteItem,
  isNotePage,
  isNoteQuery,
  isNoteReceipt,
  isNoteWrite,
  type NoteWrite,
  noteKey,
} from '@daban/protocol';
import { Notes } from './notes.js';

const alpha = 'mock-alpha',
  beta = 'mock-beta';
const human = { kind: 'human' as const };
const actor = { kind: 'bot' as const, bot: alpha };
async function revision(store: Notes) {
  const status = await store.status(alpha);
  assert.ok(status.available);
  return status.revision;
}
const create = (note = 'mock-note', id = 'mock-create'): NoteWrite => ({
  id,
  note,
  revision: 0,
  action: 'create',
  value: { title: '合成独立便笺', body: 'MOCK PRIVATE DETAIL', status: 'open' },
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notes-'));
  const file = path.join(root, 'notes.sqlite');
  let store = new Notes(file);
  await store.ready;
  return {
    root,
    file,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = new Notes(file);
      await store.ready;
    },
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('private notes and operation identities are scoped to the selected Bot', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write(alpha, create(), human);
    assert.equal(first.item.bot, alpha);
    assert.equal(first.item.status, 'open');
    assert.deepEqual(first.item.createdBy, human);
    await assert.rejects(f.store.get(beta, 'mock-note'), /NOTE_NOT_FOUND/);
    assert.deepEqual((await f.store.list(beta)).items, []);
    assert.deepEqual(await f.store.receipt(beta, create(), human), {
      state: 'unknown',
      bot: beta,
      request: create(),
      actor: human,
    });
    await assert.rejects(f.store.write(beta, create('mock-other'), actor), /INVALID_NOTE_AUTHOR/);
    const own = await f.store.write(beta, create(), { kind: 'bot', bot: beta });
    assert.equal(own.item.bot, beta);
    assert.deepEqual(own.item.createdBy, { kind: 'bot', bot: beta });
    assert.deepEqual(await f.store.status(alpha), { available: true, revision: 1, count: 1 });
    assert.deepEqual(await f.store.status(beta), { available: true, revision: 1, count: 1 });
    assert.equal((await f.store.get(alpha, 'mock-note')).bot, alpha);
  } finally {
    await f.close();
  }
});

test('open, parked and done persist with completion, trash and creator provenance', async () => {
  const f = await fixture();
  try {
    await f.store.write(
      alpha,
      {
        ...create(),
        value: { title: '  合成独立便笺  ', body: 'MOCK PRIVATE DETAIL', status: 'open' },
      },
      human,
    );
    const parked = await f.store.write(
      alpha,
      {
        id: 'mock-park',
        note: 'mock-note',
        revision: 1,
        action: 'update',
        value: { status: 'parked' },
      },
      actor,
    );
    assert.equal(parked.item.title, '合成独立便笺');
    assert.equal(parked.item.body, 'MOCK PRIVATE DETAIL');
    assert.equal(parked.item.completedAt, undefined);
    assert.deepEqual(parked.item.createdBy, human);
    assert.deepEqual(parked.item.updatedBy, actor);
    assert.equal((await f.store.list(alpha)).items.length, 1);
    const done = await f.store.write(
      alpha,
      {
        id: 'mock-done',
        note: 'mock-note',
        revision: 2,
        action: 'update',
        value: { status: 'done' },
      },
      actor,
    );
    assert.ok(done.item.completedAt);
    assert.equal((await f.store.list(alpha)).items.length, 0);
    assert.equal((await f.store.list(alpha, { filter: 'done' })).items.length, 1);
    const trashed = await f.store.write(
      alpha,
      { id: 'mock-trash', note: 'mock-note', revision: 3, action: 'trash' },
      human,
    );
    assert.equal(trashed.item.completedAt, done.item.completedAt);
    await assert.rejects(
      f.store.write(
        alpha,
        {
          id: 'mock-edit-trash',
          note: 'mock-note',
          revision: 4,
          action: 'update',
          value: { body: 'MOCK REJECTED' },
        },
        human,
      ),
      /NOTE_TRASHED/,
    );
    const restored = await f.store.write(
      alpha,
      { id: 'mock-restore', note: 'mock-note', revision: 4, action: 'restore' },
      human,
    );
    assert.equal(restored.item.body, done.item.body);
    assert.equal(restored.item.completedAt, done.item.completedAt);
    const open = await f.store.write(
      alpha,
      {
        id: 'mock-reopen',
        note: 'mock-note',
        revision: 5,
        action: 'update',
        value: { status: 'open' },
      },
      actor,
    );
    assert.equal(open.item.completedAt, undefined);
    await f.reopen();
    assert.deepEqual(await f.store.get(alpha, 'mock-note'), open.item);
    assert.deepEqual(await f.store.status(beta), { available: true, revision: 0, count: 0 });
  } finally {
    await f.close();
  }
});

test('CAS rejects a competing draft and old receipts return current content after restart', async () => {
  const f = await fixture();
  try {
    await f.store.write(alpha, create(), human);
    const request: NoteWrite = {
      id: 'mock-first-update',
      note: 'mock-note',
      action: 'update',
      revision: 1,
      value: { body: 'MOCK FIRST' },
    };
    const competing: NoteWrite = {
      id: 'mock-competing',
      note: 'mock-note',
      action: 'update',
      revision: 1,
      value: { body: 'MOCK COMPETING' },
    };
    const results = await Promise.allSettled([
      f.store.write(alpha, request, actor),
      f.store.write(alpha, competing, human),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.match(String((results[1] as PromiseRejectedResult).reason), /NOTE_CONFLICT/);
    assert.equal((await f.store.receipt(alpha, competing, human)).state, 'unknown');
    const later = await f.store.write(
      alpha,
      {
        id: 'mock-later',
        note: 'mock-note',
        action: 'update',
        revision: 2,
        value: { body: 'MOCK LATER', status: 'parked' },
      },
      human,
    );
    await f.reopen();
    const receipt = await f.store.receipt(alpha, request, actor);
    assert.equal(receipt.state, 'complete');
    assert.ok(receipt.state === 'complete');
    assert.equal(receipt.acceptedRevision, 2);
    assert.deepEqual(receipt.item, later.item);
    assert.deepEqual(await f.store.write(alpha, request, actor), receipt);
    await assert.rejects(
      f.store.write(alpha, { ...request, value: { body: 'MOCK DIFFERENT' } }, actor),
      /NOTE_REQUEST_CONFLICT/,
    );
    await assert.rejects(f.store.receipt(alpha, request, human), /NOTE_REQUEST_CONFLICT/);
    assert.equal(await revision(f.store), 3);
  } finally {
    await f.close();
  }
});

test('a no-op has an exact receipt without changing note author, completion or freshness', async () => {
  const f = await fixture();
  try {
    const initial = await f.store.write(alpha, create(), human);
    const request: NoteWrite = {
      id: 'mock-noop',
      note: 'mock-note',
      action: 'update',
      revision: 1,
      value: { body: initial.item.body },
    };
    const result = await f.store.write(alpha, request, actor);
    assert.deepEqual(result.item, initial.item);
    assert.equal(await revision(f.store), 1);
    assert.deepEqual(await f.store.receipt(alpha, request, actor), result);
  } finally {
    await f.close();
  }
});

test('Bot-local literal search and stable pages include parked items and bounded Unicode summaries', async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 3; n++)
      await f.store.write(
        alpha,
        {
          ...create(`mock-${n}`, `mock-create-${n}`),
          value: {
            title: `合成 ${n}`,
            body: n === 3 ? `${'😀'.repeat(205)} MOCK %_\\` : `MOCK BODY ${n}`,
            status: n === 2 ? 'parked' : 'open',
          },
        },
        human,
      );
    await f.store.write(beta, create('mock-beta-only'), { kind: 'bot', bot: beta });
    const first = await f.store.list(alpha, { limit: 1 });
    assert.equal(first.items[0].id, 'mock-3');
    assert.equal(Array.from(first.items[0].body).length, 200);
    assert.equal(first.items[0].bodyTruncated, true);
    assert.ok(first.nextBefore);
    assert.equal(first.revision, 3);
    await f.store.write(
      alpha,
      {
        id: 'mock-update-middle',
        note: 'mock-2',
        action: 'update',
        revision: 1,
        value: { title: 'MOCK UPDATED' },
      },
      human,
    );
    const second = await f.store.list(alpha, { before: first.nextBefore, limit: 1 });
    assert.equal(second.items[0].id, 'mock-2');
    assert.equal(second.revision, 4);
    assert.deepEqual(
      (await f.store.list(alpha, { text: '%_\\' })).items.map((item) => item.id),
      ['mock-3'],
    );
    assert.equal((await f.store.list(alpha, { text: 'PRIVATE' })).items.length, 0);
    assert.equal((await f.store.list(alpha, { filter: 'parked' })).items.length, 1);
  } finally {
    await f.close();
  }
});

test('cancellation and close reject queued writes without publishing a receipt', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.store.write(alpha, create(), human, controller.signal), /abort/i);
    assert.equal((await f.store.receipt(alpha, create(), human)).state, 'unknown');
    const pending = f.store.write(alpha, create(), human);
    await f.store.close();
    await assert.rejects(pending, /NOTES_CLOSED/);
    await f.reopen();
    assert.equal((await f.store.list(alpha)).items.length, 0);
    assert.equal((await f.store.receipt(alpha, create(), human)).state, 'unknown');
  } finally {
    await f.close();
  }
});

test('the note, local revision and operation receipt roll back together on a failed commit', async () => {
  const f = await fixture();
  try {
    const old = await f.store.write(alpha, create(), human);
    const db = new DatabaseSync(f.file);
    db.exec(
      "CREATE TRIGGER mock_block_notes BEFORE INSERT ON note_operations WHEN NEW.id='mock-rollback' BEGIN SELECT RAISE(ABORT,'MOCK_NOTE_COMMIT'); END",
    );
    const request: NoteWrite = {
      id: 'mock-rollback',
      note: 'mock-note',
      action: 'update',
      revision: 1,
      value: { body: 'MOCK SHOULD ROLLBACK' },
    };
    await assert.rejects(f.store.write(alpha, request, actor), /MOCK_NOTE_COMMIT/);
    assert.deepEqual(await f.store.get(alpha, 'mock-note'), old.item);
    assert.equal(await revision(f.store), 1);
    assert.equal((await f.store.receipt(alpha, request, actor)).state, 'unknown');
    db.exec('DROP TRIGGER mock_block_notes');
    db.close();
  } finally {
    await f.close();
  }
});

test('corrupt note ownership refuses to appear empty', async () => {
  const f = await fixture();
  try {
    await f.store.write(alpha, create(), human);
    await f.store.close();
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE note_items SET editor=?').run(JSON.stringify({ kind: 'bot', bot: beta }));
    db.close();
    await assert.rejects(f.reopen(), /NOTES_CORRUPT/);
    assert.deepEqual(await f.store.status(alpha), { available: false, error: 'NOTES_CORRUPT' });
    await assert.rejects(f.store.list(alpha), /NOTES_CORRUPT/);
  } finally {
    await f.close();
  }
});

test('private note files reject symbolic and hard links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-note-links-'));
  try {
    const source = path.join(root, 'source.sqlite');
    await writeFile(source, 'MOCK NOT A DATABASE', { mode: 0o600 });
    for (const [name, make] of [
      ['symbolic', symlink],
      ['hard', link],
    ] as const) {
      const file = path.join(root, name);
      await make(source, file);
      const store = new Notes(file);
      await assert.rejects(store.ready, /NOTES_CORRUPT/);
      await store.close();
    }
    assert.equal((await lstat(source)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Note DTOs reject foreign scope, unknown fields, malformed revisions and forged authors', () => {
  assert.equal(isNoteWrite(create()), true);
  for (const value of [
    { ...create(), bot: beta },
    { ...create(), revision: 1 },
    { ...create(), value: { title: ' ', body: '', status: 'open' } },
    { ...create(), value: { title: 'MOCK', body: 'x'.repeat(4001), status: 'open' } },
    Object.assign([], create()),
    Object.create(create()),
  ])
    assert.equal(isNoteWrite(value), false);
  assert.equal(isNoteQuery({ filter: 'parked', text: '%_\\', limit: 50 }), true);
  assert.equal(isNoteQuery({ bot: beta }), false);
  assert.equal(isNoteQuery({ filter: ['active'] }), false);
  assert.equal(isNoteQuery({ limit: 51 }), false);
  assert.equal(
    isNoteItem({
      bot: alpha,
      id: 'mock-note',
      title: 'MOCK',
      body: '',
      status: 'open',
      revision: 1,
      deleted: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      createdBy: human,
      updatedBy: { kind: 'bot', bot: beta },
    }),
    false,
  );
  assert.equal(
    isNoteReceipt({
      state: 'unknown',
      bot: alpha,
      request: create(),
      actor: { kind: 'bot', bot: beta },
    }),
    false,
  );
});

test('caller mutation and patch property order cannot alter scope or defeat exact retries', async () => {
  const f = await fixture();
  try {
    const request = {
      id: 'mock-captured',
      note: 'mock-captured-note',
      action: 'create' as const,
      revision: 0 as const,
      value: { title: 'MOCK CAPTURED', body: 'MOCK ORIGINAL', status: 'open' as const },
    };
    const by = { kind: 'bot' as const, bot: alpha },
      original = structuredClone(request);
    const pending = f.store.write(alpha, request, by);
    request.note = 'mock-mutated';
    request.value.body = 'MOCK MUTATED';
    by.bot = beta;
    const saved = await pending;
    assert.equal(saved.item.id, original.note);
    assert.equal(saved.item.body, original.value.body);
    assert.deepEqual(saved.item.createdBy, actor);
    const patch: NoteWrite = {
      id: 'mock-ordered',
      note: original.note,
      action: 'update',
      revision: 1,
      value: { title: 'MOCK NEW TITLE', body: 'MOCK NEW BODY' },
    };
    const changed = await f.store.write(alpha, patch, human);
    assert.deepEqual(
      await f.store.write(
        alpha,
        { ...patch, value: { body: 'MOCK NEW BODY', title: 'MOCK NEW TITLE' } },
        human,
      ),
      changed,
    );
  } finally {
    await f.close();
  }
});

test('unknown or unrelated databases remain intact instead of being converted to notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-note-schema-'));
  try {
    for (const version of [0, 2]) {
      const file = path.join(root, `schema-${version}.sqlite`),
        db = new DatabaseSync(file);
      db.exec(
        `CREATE TABLE mock_existing(value TEXT);INSERT INTO mock_existing VALUES('MOCK RETAIN');PRAGMA user_version=${version}`,
      );
      db.close();
      const bytes = await readFile(file),
        store = new Notes(file);
      await assert.rejects(store.ready, /NOTES_CORRUPT/);
      await store.close();
      assert.deepEqual(await readFile(file), bytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing per-Bot authority cannot turn existing notes into a new empty namespace', async () => {
  const f = await fixture();
  try {
    await f.store.write(alpha, create(), human);
    const db = new DatabaseSync(f.file);
    db.prepare('DELETE FROM note_meta WHERE bot=?').run(alpha);
    db.close();
    for (const operation of [
      f.store.get(alpha, 'mock-note'),
      f.store.list(alpha),
      f.store.receipt(alpha, create(), human),
      f.store.write(
        alpha,
        {
          id: 'mock-untracked',
          note: 'mock-note',
          action: 'update',
          revision: 1,
          value: { status: 'parked' },
        },
        human,
      ),
    ])
      await assert.rejects(operation, /NOTES_CORRUPT/);
    assert.deepEqual(await f.store.status(alpha), { available: false, error: 'NOTES_CORRUPT' });
    await assert.rejects(f.reopen(), /NOTES_CORRUPT/);
    const inspect = new DatabaseSync(f.file, { readOnly: true });
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM note_items').get()!.n, 1);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM note_operations').get()!.n, 1);
    inspect.close();
  } finally {
    await f.close();
  }
});

test('malformed receipts are refused as corruption before their fingerprint is compared', async () => {
  const f = await fixture();
  try {
    await f.store.write(alpha, create(), human);
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE note_operations SET signature=?').run('MOCK INVALID');
    db.close();
    await assert.rejects(f.store.receipt(alpha, create(), human), /NOTES_CORRUPT/);
    await assert.rejects(f.reopen(), /NOTES_CORRUPT/);
  } finally {
    await f.close();
  }
});

test('a failed initial schema transaction stays retryable without partially published tables', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-note-init-'));
  const file = path.join(root, 'notes.sqlite'),
    execute = DatabaseSync.prototype.exec;
  let injected = false;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (!injected && sql.includes('CREATE TABLE note_operations')) {
      injected = true;
      return execute.call(
        this,
        sql.replace('CREATE TABLE note_operations', 'MOCK_STORAGE_REFUSAL note_operations'),
      );
    }
    return execute.call(this, sql);
  });
  const failed = new Notes(file);
  try {
    await assert.rejects(failed.ready, /NOTES_CORRUPT/);
    await failed.close();
    assert.equal(injected, true);
    const inspect = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all(),
      [],
    );
    assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 0);
    inspect.close();
    t.mock.restoreAll();
    const recovered = new Notes(file);
    await recovered.ready;
    assert.deepEqual(await recovered.status(alpha), { available: true, revision: 0, count: 0 });
    await recovered.close();
  } finally {
    t.mock.restoreAll();
    await failed.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retained-item capacity includes trash while other Bot metadata remains scoped', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 1000; n++)
      await f.store.write(alpha, create(`mock-card-${n}`, `mock-create-${n}`), human);
    await f.store.write(
      alpha,
      { id: 'mock-trash-capacity', note: 'mock-card-0', action: 'trash', revision: 1 },
      human,
    );
    await assert.rejects(f.store.write(beta, create(), human), /NOTE_LIMIT/);
    assert.deepEqual(await f.store.status(beta), { available: true, revision: 0, count: 0 });
    assert.equal((await f.store.status(alpha)).available, true);
    await f.reopen();
    assert.equal((await f.store.list(alpha, { filter: 'trash' })).items.length, 1);
  } finally {
    await f.close();
  }
});

test('the operation quota refuses new writes while accepted retries remain readable', async () => {
  const f = await fixture();
  try {
    const initial = await f.store.write(alpha, create(), human),
      db = new DatabaseSync(f.file);
    const insert = db.prepare(
      'INSERT INTO note_operations(bot,id,note,signature,revision,at) VALUES(?,?,?,?,?,?)',
    );
    db.exec('BEGIN');
    for (let n = 0; n < 9999; n++) {
      const request: NoteWrite = {
        id: `mock-ledger-${n}`,
        note: 'mock-note',
        action: 'update',
        revision: 1,
        value: { body: initial.item.body },
      };
      insert.run(
        alpha,
        request.id,
        request.note,
        createHash('sha256')
          .update(noteKey(alpha, request, human))
          .digest('hex'),
        1,
        initial.acceptedAt,
      );
    }
    db.exec('COMMIT');
    db.close();
    await assert.rejects(
      f.store.write(
        alpha,
        {
          id: 'mock-excess',
          note: 'mock-note',
          action: 'update',
          revision: 1,
          value: { status: 'parked' },
        },
        human,
      ),
      /NOTE_OPERATION_LIMIT/,
    );
    await f.reopen();
    assert.deepEqual(await f.store.write(alpha, create(), human), initial);
  } finally {
    await f.close();
  }
});

test('page and receipt projections keep the exact Bot and reject impossible cursor or acceptance metadata', async () => {
  const f = await fixture();
  try {
    const accepted = await f.store.write(alpha, create(), human);
    const page = await f.store.list(alpha);
    assert.equal(isNotePage(page), true);
    assert.equal(isNotePage({ ...page, revision: 0 }), false);
    assert.equal(isNotePage({ ...page, bot: beta }), false);
    assert.equal(isNotePage({ ...page, items: [...page.items, ...page.items] }), false);
    assert.equal(isNotePage({ ...page, items: [], nextBefore: 1 }), false);
    assert.equal(isNoteReceipt(accepted), true);
    assert.equal(isNoteReceipt({ ...accepted, bot: beta }), false);
    assert.equal(isNoteReceipt({ ...accepted, acceptedRevision: 2 }), false);
    assert.equal(
      isNoteReceipt({ ...accepted, acceptedRevision: 2, item: { ...accepted.item, revision: 2 } }),
      false,
    );
    assert.equal(
      isNoteReceipt({
        ...accepted,
        request: {
          id: 'mock-impossible',
          note: 'mock-note',
          action: 'update',
          revision: 5,
          value: { body: 'MOCK' },
        },
        item: { ...accepted.item, revision: 6 },
      }),
      false,
    );
    assert.equal(isNoteReceipt({ ...accepted, actor: { kind: 'bot', bot: beta } }), false);
    assert.equal(isNoteItem({ ...accepted.item, status: 'done' }), false);
  } finally {
    await f.close();
  }
});

test('an impossible accepted version cannot turn a damaged create receipt into success', async () => {
  const f = await fixture();
  try {
    await f.store.write(alpha, create(), human);
    await f.store.write(
      alpha,
      {
        id: 'mock-legit-update',
        note: 'mock-note',
        action: 'update',
        revision: 1,
        value: { body: 'MOCK LATER' },
      },
      human,
    );
    const db = new DatabaseSync(f.file);
    db.prepare('UPDATE note_operations SET revision=2 WHERE bot=? AND id=?').run(
      alpha,
      'mock-create',
    );
    db.close();
    await assert.rejects(f.store.receipt(alpha, create(), human), /NOTES_CORRUPT/);
    await f.reopen();
    await assert.rejects(f.store.write(alpha, create(), human), /NOTES_CORRUPT/);
    assert.equal((await f.store.get(alpha, 'mock-note')).body, 'MOCK LATER');
  } finally {
    await f.close();
  }
});

test('rewound or orphaned local authority cannot expose a false empty or untracked note', async () => {
  for (const mode of ['rewound', 'orphaned']) {
    const f = await fixture();
    try {
      await f.store.write(alpha, create(), human);
      const db = new DatabaseSync(f.file);
      // Simulate damaged on-disk relationships, not a deletion admitted by the live store.
      if (mode === 'orphaned') db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        mode === 'rewound'
          ? 'UPDATE note_meta SET revision=0 WHERE bot=?'
          : 'DELETE FROM note_items WHERE bot=?',
      ).run(alpha);
      db.close();
      await assert.rejects(f.store.get(alpha, 'mock-note'), /NOTES_CORRUPT/);
      await assert.rejects(f.store.list(alpha), /NOTES_CORRUPT/);
      assert.deepEqual(await f.store.status(alpha), { available: false, error: 'NOTES_CORRUPT' });
      await assert.rejects(f.reopen(), /NOTES_CORRUPT/);
    } finally {
      await f.close();
    }
  }
});
