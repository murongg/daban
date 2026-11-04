import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isNoteItem,
  isNotePage,
  isNoteQuery,
  isNoteReceipt,
  isNoteWrite,
  type NoteWrite,
  noteKey,
} from '@daban/protocol';
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test, vi } from 'vitest';
import { Notes } from './notes.js';
import { noteItems, noteOperations } from './notes-schema.js';
import { privateMetadata, secureDirectory } from './private-files.js';

const alpha = 'mock-alpha',
  beta = 'mock-beta';
const human = { kind: 'human' as const };
const actor = { kind: 'bot' as const, bot: alpha };
async function revision(store: Notes) {
  const status = await store.status(alpha);
  expect.assert(status.available);
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
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-notes-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
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
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

test('a pre-ORM version 1 notes file keeps its notes and receipts after the schema baseline', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-notes-legacy-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const file = path.join(root, 'notes.sqlite');
  const at = '2026-01-01T00:00:00.000Z',
    request = create(),
    key = createHash('sha256')
      .update(noteKey(alpha, request, human))
      .digest('hex');
  const old = new DatabaseSync(file);
  old.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE note_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,bot TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,completed TEXT,creator TEXT NOT NULL,editor TEXT NOT NULL,UNIQUE(bot,id)) STRICT;
    CREATE TABLE note_operations(bot TEXT NOT NULL,id TEXT NOT NULL,note TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL,PRIMARY KEY(bot,id),FOREIGN KEY(bot,note) REFERENCES note_items(bot,id)) STRICT;
    CREATE TABLE note_meta(bot TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
    PRAGMA user_version=1;`);
  old
    .prepare(
      'INSERT INTO note_items(bot,id,title,body,status,revision,deleted,created,updated,completed,creator,editor) VALUES(?,?,?,?,?,1,0,?,?,NULL,?,?)',
    )
    .run(
      alpha,
      request.note,
      '合成独立便笺',
      'MOCK PRIVATE DETAIL',
      'open',
      at,
      at,
      JSON.stringify(human),
      JSON.stringify(human),
    );
  old
    .prepare('INSERT INTO note_operations VALUES(?,?,?,?,1,?)')
    .run(alpha, request.id, request.note, key, at);
  old.prepare('INSERT INTO note_meta VALUES(?,1)').run(alpha);
  old.close();
  const store = new Notes(file);
  try {
    await store.ready;
    const prior = await store.receipt(alpha, request, human);
    expect.assert(prior.state === 'complete');
    expect(prior.acceptedAt).toBe(at);
    expect(prior.item.title).toBe('合成独立便笺');
    expect(await store.status(alpha)).toStrictEqual({ available: true, revision: 1, count: 1 });
    const next = await store.write(
      alpha,
      {
        id: 'mock-legacy-update',
        note: request.note,
        action: 'update',
        revision: 1,
        value: { status: 'parked' },
      },
      human,
    );
    expect(next.item.revision).toBe(2);
    expect((await store.list(alpha)).items.map((item) => item.id)).toStrictEqual([request.note]);
  } finally {
    await store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('private notes and operation identities are scoped to the selected Bot', async () => {
  const f = await fixture();
  try {
    const first = await f.store.write(alpha, create(), human);
    expect(first.item.bot).toBe(alpha);
    expect(first.item.status).toBe('open');
    expect(first.item.createdBy).toStrictEqual(human);
    await expect(f.store.get(beta, 'mock-note')).rejects.toThrowError(/NOTE_NOT_FOUND/);
    expect((await f.store.list(beta)).items).toStrictEqual([]);
    expect(await f.store.receipt(beta, create(), human)).toStrictEqual({
      state: 'unknown',
      bot: beta,
      request: create(),
      actor: human,
    });
    await expect(f.store.write(beta, create('mock-other'), actor)).rejects.toThrowError(
      /INVALID_NOTE_AUTHOR/,
    );
    const own = await f.store.write(beta, create(), { kind: 'bot', bot: beta });
    expect(own.item.bot).toBe(beta);
    expect(own.item.createdBy).toStrictEqual({ kind: 'bot', bot: beta });
    expect(await f.store.status(alpha)).toStrictEqual({ available: true, revision: 1, count: 1 });
    expect(await f.store.status(beta)).toStrictEqual({ available: true, revision: 1, count: 1 });
    expect((await f.store.get(alpha, 'mock-note')).bot).toBe(alpha);
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
    expect(parked.item.title).toBe('合成独立便笺');
    expect(parked.item.body).toBe('MOCK PRIVATE DETAIL');
    expect(parked.item.completedAt).toBe(undefined);
    expect(parked.item.createdBy).toStrictEqual(human);
    expect(parked.item.updatedBy).toStrictEqual(actor);
    expect((await f.store.list(alpha)).items.length).toBe(1);
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
    expect.assert(done.item.completedAt);
    expect((await f.store.list(alpha)).items.length).toBe(0);
    expect((await f.store.list(alpha, { filter: 'done' })).items.length).toBe(1);
    const trashed = await f.store.write(
      alpha,
      { id: 'mock-trash', note: 'mock-note', revision: 3, action: 'trash' },
      human,
    );
    expect(trashed.item.completedAt).toBe(done.item.completedAt);
    await expect(
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
    ).rejects.toThrowError(/NOTE_TRASHED/);
    const restored = await f.store.write(
      alpha,
      { id: 'mock-restore', note: 'mock-note', revision: 4, action: 'restore' },
      human,
    );
    expect(restored.item.body).toBe(done.item.body);
    expect(restored.item.completedAt).toBe(done.item.completedAt);
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
    expect(open.item.completedAt).toBe(undefined);
    await f.reopen();
    expect(await f.store.get(alpha, 'mock-note')).toStrictEqual(open.item);
    expect(await f.store.status(beta)).toStrictEqual({ available: true, revision: 0, count: 0 });
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
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/NOTE_CONFLICT/);
    expect((await f.store.receipt(alpha, competing, human)).state).toBe('unknown');
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
    expect(receipt.state).toBe('complete');
    expect.assert(receipt.state === 'complete');
    expect(receipt.acceptedRevision).toBe(2);
    expect(receipt.item).toStrictEqual(later.item);
    expect(await f.store.write(alpha, request, actor)).toStrictEqual(receipt);
    await expect(
      f.store.write(alpha, { ...request, value: { body: 'MOCK DIFFERENT' } }, actor),
    ).rejects.toThrowError(/NOTE_REQUEST_CONFLICT/);
    await expect(f.store.receipt(alpha, request, human)).rejects.toThrowError(
      /NOTE_REQUEST_CONFLICT/,
    );
    expect(await revision(f.store)).toBe(3);
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
    expect(result.item).toStrictEqual(initial.item);
    expect(await revision(f.store)).toBe(1);
    expect(await f.store.receipt(alpha, request, actor)).toStrictEqual(result);
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
    expect(first.items[0].id).toBe('mock-3');
    expect(Array.from(first.items[0].body).length).toBe(200);
    expect(first.items[0].bodyTruncated).toBe(true);
    expect.assert(first.nextBefore);
    expect(first.revision).toBe(3);
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
    expect(second.items[0].id).toBe('mock-2');
    expect(second.revision).toBe(4);
    expect(
      (await f.store.list(alpha, { text: '%_\\' })).items.map((item) => item.id),
    ).toStrictEqual(['mock-3']);
    expect((await f.store.list(alpha, { text: 'PRIVATE' })).items.length).toBe(0);
    expect((await f.store.list(alpha, { filter: 'parked' })).items.length).toBe(1);
  } finally {
    await f.close();
  }
});

test('cancellation and close reject queued writes without publishing a receipt', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(f.store.write(alpha, create(), human, controller.signal)).rejects.toThrowError(
      /abort/i,
    );
    expect((await f.store.receipt(alpha, create(), human)).state).toBe('unknown');
    const pending = f.store.write(alpha, create(), human);
    await f.store.close();
    await expect(pending).rejects.toThrowError(/NOTES_CLOSED/);
    await f.reopen();
    expect((await f.store.list(alpha)).items.length).toBe(0);
    expect((await f.store.receipt(alpha, create(), human)).state).toBe('unknown');
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
    await expect(f.store.write(alpha, request, actor)).rejects.toThrowError(/MOCK_NOTE_COMMIT/);
    expect(await f.store.get(alpha, 'mock-note')).toStrictEqual(old.item);
    expect(await revision(f.store)).toBe(1);
    expect((await f.store.receipt(alpha, request, actor)).state).toBe('unknown');
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
    await expect(f.reopen()).rejects.toThrowError(/NOTES_CORRUPT/);
    expect(await f.store.status(alpha)).toStrictEqual({ available: false, error: 'NOTES_CORRUPT' });
    await expect(f.store.list(alpha)).rejects.toThrowError(/NOTES_CORRUPT/);
  } finally {
    await f.close();
  }
});

test('private note files reject symbolic and hard links', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-note-links-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
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
      await expect(store.ready).rejects.toThrowError(/NOTES_CORRUPT/);
      await store.close();
    }
    expect(await privateMetadata(source, await lstat(source), 0o600)).toBe(true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Note DTOs reject foreign scope, unknown fields, malformed revisions and forged authors', () => {
  expect(isNoteWrite(create())).toBe(true);
  for (const value of [
    { ...create(), bot: beta },
    { ...create(), revision: 1 },
    { ...create(), value: { title: ' ', body: '', status: 'open' } },
    { ...create(), value: { title: 'MOCK', body: 'x'.repeat(4001), status: 'open' } },
    Object.assign([], create()),
    Object.create(create()),
  ])
    expect(isNoteWrite(value)).toBe(false);
  expect(isNoteQuery({ filter: 'parked', text: '%_\\', limit: 50 })).toBe(true);
  expect(isNoteQuery({ bot: beta })).toBe(false);
  expect(isNoteQuery({ filter: ['active'] })).toBe(false);
  expect(isNoteQuery({ limit: 51 })).toBe(false);
  expect(
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
  ).toBe(false);
  expect(
    isNoteReceipt({
      state: 'unknown',
      bot: alpha,
      request: create(),
      actor: { kind: 'bot', bot: beta },
    }),
  ).toBe(false);
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
    expect(saved.item.id).toBe(original.note);
    expect(saved.item.body).toBe(original.value.body);
    expect(saved.item.createdBy).toStrictEqual(actor);
    const patch: NoteWrite = {
      id: 'mock-ordered',
      note: original.note,
      action: 'update',
      revision: 1,
      value: { title: 'MOCK NEW TITLE', body: 'MOCK NEW BODY' },
    };
    const changed = await f.store.write(alpha, patch, human);
    expect(
      await f.store.write(
        alpha,
        { ...patch, value: { body: 'MOCK NEW BODY', title: 'MOCK NEW TITLE' } },
        human,
      ),
    ).toStrictEqual(changed);
  } finally {
    await f.close();
  }
});

test('unknown or unrelated databases remain intact instead of being converted to notes', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-note-schema-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  try {
    for (const version of [0, 1, 2]) {
      const file = path.join(root, `schema-${version}.sqlite`),
        db = new DatabaseSync(file);
      db.exec(
        `CREATE TABLE mock_existing(value TEXT);INSERT INTO mock_existing VALUES('MOCK RETAIN');PRAGMA user_version=${version}`,
      );
      db.close();
      const bytes = await readFile(file),
        store = new Notes(file);
      await expect(store.ready).rejects.toThrowError(/NOTES_CORRUPT/);
      await store.close();
      expect(await readFile(file)).toStrictEqual(bytes);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
      await expect(operation).rejects.toThrowError(/NOTES_CORRUPT/);
    expect(await f.store.status(alpha)).toStrictEqual({ available: false, error: 'NOTES_CORRUPT' });
    await expect(f.reopen()).rejects.toThrowError(/NOTES_CORRUPT/);
    const inspect = drizzle({ client: new DatabaseSync(f.file, { readOnly: true }) });
    expect(inspect.select({ n: count() }).from(noteItems).get()!.n).toBe(1);
    expect(inspect.select({ n: count() }).from(noteOperations).get()!.n).toBe(1);
    inspect.$client.close();
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
    await expect(f.store.receipt(alpha, create(), human)).rejects.toThrowError(/NOTES_CORRUPT/);
    await expect(f.reopen()).rejects.toThrowError(/NOTES_CORRUPT/);
  } finally {
    await f.close();
  }
});

test('a failed initial schema transaction stays retryable without partially published tables', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-note-init-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const file = path.join(root, 'notes.sqlite'),
    prepare = DatabaseSync.prototype.prepare;
  let injected = false;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!injected && sql.includes('CREATE TABLE `note_operations`')) {
      injected = true;
      return prepare.call(
        this,
        sql.replace('CREATE TABLE `note_operations`', 'MOCK_STORAGE_REFUSAL note_operations'),
      );
    }
    return prepare.call(this, sql);
  });
  const failed = new Notes(file);
  try {
    await expect(failed.ready).rejects.toThrowError(/NOTES_CORRUPT/);
    await failed.close();
    expect(injected).toBe(true);
    const inspect = new DatabaseSync(file, { readOnly: true });
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all(),
    ).toStrictEqual([]);
    expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(0);
    inspect.close();
    vi.restoreAllMocks();
    const recovered = new Notes(file);
    await recovered.ready;
    expect(await recovered.status(alpha)).toStrictEqual({ available: true, revision: 0, count: 0 });
    await recovered.close();
  } finally {
    vi.restoreAllMocks();
    await failed.close();
    await rm(temporary, { recursive: true, force: true });
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
    await expect(f.store.write(beta, create(), human)).rejects.toThrowError(/NOTE_LIMIT/);
    expect(await f.store.status(beta)).toStrictEqual({ available: true, revision: 0, count: 0 });
    expect((await f.store.status(alpha)).available).toBe(true);
    await f.reopen();
    expect((await f.store.list(alpha, { filter: 'trash' })).items.length).toBe(1);
  } finally {
    await f.close();
  }
});

test('the operation quota refuses new writes while accepted retries remain readable', async () => {
  const f = await fixture();
  try {
    const initial = await f.store.write(alpha, create(), human),
      db = drizzle({ client: new DatabaseSync(f.file) });
    db.transaction((tx) => {
      for (let n = 0; n < 9999; n++) {
        const request: NoteWrite = {
          id: `mock-ledger-${n}`,
          note: 'mock-note',
          action: 'update',
          revision: 1,
          value: { body: initial.item.body },
        };
        tx.insert(noteOperations)
          .values({
            bot: alpha,
            id: request.id,
            note: request.note,
            signature: createHash('sha256')
              .update(noteKey(alpha, request, human))
              .digest('hex'),
            revision: 1,
            at: initial.acceptedAt,
          })
          .run();
      }
    });
    db.$client.close();
    await expect(
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
    ).rejects.toThrowError(/NOTE_OPERATION_LIMIT/);
    await f.reopen();
    expect(await f.store.write(alpha, create(), human)).toStrictEqual(initial);
  } finally {
    await f.close();
  }
});

test('page and receipt projections keep the exact Bot and reject impossible cursor or acceptance metadata', async () => {
  const f = await fixture();
  try {
    const accepted = await f.store.write(alpha, create(), human);
    const page = await f.store.list(alpha);
    expect(isNotePage(page)).toBe(true);
    expect(isNotePage({ ...page, revision: 0 })).toBe(false);
    expect(isNotePage({ ...page, bot: beta })).toBe(false);
    expect(isNotePage({ ...page, items: [...page.items, ...page.items] })).toBe(false);
    expect(isNotePage({ ...page, items: [], nextBefore: 1 })).toBe(false);
    expect(isNoteReceipt(accepted)).toBe(true);
    expect(isNoteReceipt({ ...accepted, bot: beta })).toBe(false);
    expect(isNoteReceipt({ ...accepted, acceptedRevision: 2 })).toBe(false);
    expect(
      isNoteReceipt({ ...accepted, acceptedRevision: 2, item: { ...accepted.item, revision: 2 } }),
    ).toBe(false);
    expect(
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
    ).toBe(false);
    expect(isNoteReceipt({ ...accepted, actor: { kind: 'bot', bot: beta } })).toBe(false);
    expect(isNoteItem({ ...accepted.item, status: 'done' })).toBe(false);
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
    await expect(f.store.receipt(alpha, create(), human)).rejects.toThrowError(/NOTES_CORRUPT/);
    await f.reopen();
    await expect(f.store.write(alpha, create(), human)).rejects.toThrowError(/NOTES_CORRUPT/);
    expect((await f.store.get(alpha, 'mock-note')).body).toBe('MOCK LATER');
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
      await expect(f.store.get(alpha, 'mock-note')).rejects.toThrowError(/NOTES_CORRUPT/);
      await expect(f.store.list(alpha)).rejects.toThrowError(/NOTES_CORRUPT/);
      expect(await f.store.status(alpha)).toStrictEqual({
        available: false,
        error: 'NOTES_CORRUPT',
      });
      await expect(f.reopen()).rejects.toThrowError(/NOTES_CORRUPT/);
    } finally {
      await f.close();
    }
  }
});
