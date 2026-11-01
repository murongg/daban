import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isNoteAuthor,
  isNoteItem,
  isNoteQuery,
  isNoteReceipt,
  isNoteWrite,
  type NoteAck,
  type NoteAuthor,
  type NoteAvailability,
  type NoteItem,
  type NotePage,
  type NoteReceipt,
  type NoteStatus,
  type NoteWrite,
  noteAuthorMatches,
  noteKey,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';
import { privateMetadata } from './private-files.js';

type Row = Record<string, unknown>;
const capacity = 1000,
  operationLimit = 10000;
const signature = (bot: string, request: NoteWrite, actor: NoteAuthor) =>
  createHash('sha256')
    .update(noteKey(bot, request, actor))
    .digest('hex');
export class Notes {
  // One runtime owns the database; a process lease is required before supporting multiple writers.
  readonly ready: Promise<unknown>;
  private db?: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    readonly file: string,
    private readonly admit: (bot: string) => undefined = () => {},
  ) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const existing = await lstat(this.file).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
        return undefined;
      });
      if (
        existing &&
        (!existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.nlink !== 1 ||
          !(await privateMetadata(this.file, existing)))
      )
        throw new Fault('NOTES_CORRUPT');
      if (!existing) await (await open(this.file, 'wx', 0o600)).close();
      await chmod(this.file, 0o600);
      this.db = new DatabaseSync(this.file);
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      const names = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name));
      if (
        version === 0
          ? names.length > 0
          : version !== 1 ||
            JSON.stringify(names) !== JSON.stringify(['note_items', 'note_meta', 'note_operations'])
      )
        throw new Fault('NOTES_CORRUPT');
      this.db.exec(
        'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;',
      );
      // A failed first open must not leave an incomplete schema claiming to be version 1.
      if (version === 0)
        this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE note_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,bot TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,completed TEXT,creator TEXT NOT NULL,editor TEXT NOT NULL,UNIQUE(bot,id)) STRICT;
        CREATE TABLE note_operations(bot TEXT NOT NULL,id TEXT NOT NULL,note TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL,PRIMARY KEY(bot,id),FOREIGN KEY(bot,note) REFERENCES note_items(bot,id)) STRICT;
        CREATE TABLE note_meta(bot TEXT PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
        PRAGMA user_version=1;COMMIT;`);
      const items = this.db.prepare('SELECT * FROM note_items').all();
      if (items.length > capacity) throw new Fault('NOTES_CORRUPT');
      const metas = this.db.prepare('SELECT * FROM note_meta').all(),
        bots = new Set<string>();
      for (const meta of metas) {
        if (
          !validAgentId(meta.bot) ||
          !Number.isSafeInteger(meta.revision) ||
          Number(meta.revision) < 0 ||
          Number(meta.revision) > operationLimit
        )
          throw new Fault('NOTES_CORRUPT');
        bots.add(meta.bot);
      }
      const totals = new Map<string, number>();
      for (const row of items) {
        const item = this.item(row);
        if (!bots.has(item.bot)) throw new Fault('NOTES_CORRUPT');
        totals.set(item.bot, (totals.get(item.bot) ?? 0) + item.revision);
      }
      for (const meta of metas)
        if (totals.get(String(meta.bot)) !== meta.revision) throw new Fault('NOTES_CORRUPT');
      const operations = this.db
        .prepare(
          'SELECT o.*,n.revision AS note_revision FROM note_operations o LEFT JOIN note_items n ON n.bot=o.bot AND n.id=o.note',
        )
        .all();
      if (operations.length > operationLimit) throw new Fault('NOTES_CORRUPT');
      for (const row of operations) {
        this.operation(row);
        if (
          !bots.has(String(row.bot)) ||
          !Number.isSafeInteger(row.note_revision) ||
          Number(row.note_revision) < Number(row.revision)
        )
          throw new Fault('NOTES_CORRUPT');
      }
    } catch {
      this.db?.close();
      this.db = undefined;
      throw new Fault('NOTES_CORRUPT');
    }
  }
  private database() {
    if (this.closed || !this.db) throw new Fault('NOTES_CLOSED');
    return this.db;
  }
  private exclusive<T>(action: () => T, signal?: AbortSignal): Promise<T> {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        this.database();
        signal?.throwIfAborted();
        return action();
      });
    this.chain = next;
    return next;
  }
  private revision(bot: string) {
    const db = this.db;
    if (!db) throw new Fault('NOTES_CORRUPT');
    const meta = db.prepare('SELECT revision FROM note_meta WHERE bot=?').get(bot);
    const total = db
      .prepare('SELECT SUM(revision) AS revision FROM note_items WHERE bot=?')
      .get(bot)!;
    if (!meta) {
      if (total.revision !== null) throw new Fault('NOTES_CORRUPT');
      return 0;
    }
    // Soft deletion keeps every note revision: rewound or orphaned metadata must never look fresh.
    if (
      !Number.isSafeInteger(meta.revision) ||
      Number(meta.revision) < 0 ||
      Number(meta.revision) > operationLimit ||
      meta.revision !== total.revision
    )
      throw new Fault('NOTES_CORRUPT');
    return Number(meta.revision);
  }
  private item(row: Row): NoteItem {
    let createdBy: unknown, updatedBy: unknown;
    try {
      createdBy = JSON.parse(String(row.creator));
      updatedBy = JSON.parse(String(row.editor));
    } catch {
      throw new Fault('NOTES_CORRUPT');
    }
    const item = {
      bot: row.bot,
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      revision: row.revision,
      deleted: row.deleted === 1,
      createdAt: row.created,
      updatedAt: row.updated,
      ...(row.completed === null ? {} : { completedAt: row.completed }),
      createdBy,
      updatedBy,
    };
    if (!isNoteItem(item) || ![0, 1].includes(Number(row.deleted)))
      throw new Fault('NOTES_CORRUPT');
    return item;
  }
  private find(bot: string, id: string) {
    const row = this.database()
      .prepare('SELECT * FROM note_items WHERE bot=? AND id=?')
      .get(bot, id);
    if (!row) throw new Fault('NOTE_NOT_FOUND', 404);
    return this.item(row);
  }
  get(bot: string, id: string) {
    if (!validAgentId(bot) || !validAgentId(id))
      return Promise.reject(new Fault('INVALID_NOTE_QUERY', 400));
    return this.exclusive(() => {
      this.revision(bot);
      return this.find(bot, id);
    });
  }
  async availability(): Promise<NoteAvailability> {
    try {
      await this.ready;
      return this.closed ? { available: false, error: 'NOTES_CLOSED' } : { available: true };
    } catch {
      return { available: false, error: 'NOTES_CORRUPT' };
    }
  }
  async status(bot: string): Promise<NoteStatus> {
    if (!validAgentId(bot)) throw new Fault('INVALID_NOTE_QUERY', 400);
    try {
      await this.ready;
      if (this.closed) return { available: false, error: 'NOTES_CLOSED' };
      return {
        available: true,
        revision: this.revision(bot),
        count: Number(
          this.database().prepare('SELECT COUNT(*) AS n FROM note_items WHERE bot=?').get(bot)!.n,
        ),
      };
    } catch {
      return { available: false, error: 'NOTES_CORRUPT' };
    }
  }
  list(bot: string, input: unknown = {}): Promise<NotePage> {
    if (!validAgentId(bot) || !isNoteQuery(input))
      return Promise.reject(new Fault('INVALID_NOTE_QUERY', 400));
    const query = structuredClone(input);
    return this.exclusive(() => {
      const revision = this.revision(bot),
        filter = query.filter ?? 'active';
      const conditions = ['bot=?', filter === 'trash' ? 'deleted=1' : 'deleted=0'];
      const values: (string | number)[] = [bot];
      if (filter === 'active') conditions.push("status!='done'");
      else if (['open', 'parked', 'done'].includes(filter)) {
        conditions.push('status=?');
        values.push(filter);
      }
      if (query.before !== undefined) {
        conditions.push('seq<?');
        values.push(query.before);
      }
      if (query.text) {
        const text = `%${query.text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
        values.push(text, text);
      }
      const limit = query.limit ?? 50;
      const rows = this.database()
        .prepare(
          `SELECT * FROM note_items WHERE ${conditions.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
        )
        .all(...values, limit + 1);
      const page = rows.slice(0, limit);
      return {
        bot,
        revision,
        items: page.map((row) => {
          const item = this.item(row),
            chars = Array.from(item.body);
          return { ...item, body: chars.slice(0, 200).join(''), bodyTruncated: chars.length > 200 };
        }),
        ...(rows.length > limit ? { nextBefore: Number(page.at(-1)!.seq) } : {}),
      };
    });
  }
  private operation(row: Row) {
    if (
      !validAgentId(row.bot) ||
      !validAgentId(row.id) ||
      !validAgentId(row.note) ||
      typeof row.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.signature) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
      typeof row.at !== 'string' ||
      row.at.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(row.at) ||
      !Number.isFinite(Date.parse(row.at))
    )
      throw new Fault('NOTES_CORRUPT');
  }
  private accepted(bot: string, request: NoteWrite, actor: NoteAuthor): NoteAck | undefined {
    // Both the row lookup and fingerprint carry the Bot; another Bot's matching IDs reveal no receipt.
    const row = this.database()
      .prepare('SELECT * FROM note_operations WHERE bot=? AND id=?')
      .get(bot, request.id);
    if (!row) return undefined;
    this.operation(row);
    if (row.signature !== signature(bot, request, actor)) throw new Fault('NOTE_REQUEST_CONFLICT');
    if (row.note !== request.note) throw new Fault('NOTES_CORRUPT');
    let item: NoteItem;
    try {
      item = this.find(bot, request.note);
    } catch {
      throw new Fault('NOTES_CORRUPT');
    }
    const result: NoteAck = {
      state: 'complete',
      bot,
      request,
      actor,
      acceptedRevision: Number(row.revision),
      acceptedAt: String(row.at),
      item,
    };
    if (!isNoteReceipt(result)) throw new Fault('NOTES_CORRUPT');
    return result;
  }
  receipt(bot: string, input: unknown, by: unknown): Promise<NoteReceipt> {
    if (!validAgentId(bot) || !isNoteWrite(input))
      return Promise.reject(new Fault('INVALID_NOTE_WRITE', 400));
    if (!isNoteAuthor(by) || !noteAuthorMatches(bot, by))
      return Promise.reject(new Fault('INVALID_NOTE_AUTHOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive(() => {
      this.revision(bot);
      return (
        this.accepted(bot, request, actor) ?? { state: 'unknown' as const, bot, request, actor }
      );
    });
  }
  private transaction<T>(action: () => T) {
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  write(bot: string, input: unknown, by: unknown, signal?: AbortSignal): Promise<NoteAck> {
    if (!validAgentId(bot) || !isNoteWrite(input))
      return Promise.reject(new Fault('INVALID_NOTE_WRITE', 400));
    if (!isNoteAuthor(by) || !noteAuthorMatches(bot, by))
      return Promise.reject(new Fault('INVALID_NOTE_AUTHOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive(() => {
      // Recheck after the queue yields: lifecycle or recovery may have revoked a previously valid writer.
      this.admit(bot);
      this.revision(bot);
      // Resolve an accepted intent before CAS or trash checks, without reapplying an older edit.
      const prior = this.accepted(bot, request, actor);
      if (prior) return prior;
      const db = this.database();
      if (
        Number(db.prepare('SELECT COUNT(*) AS n FROM note_operations').get()!.n) >= operationLimit
      )
        throw new Fault('NOTE_OPERATION_LIMIT');
      const row = db
        .prepare('SELECT * FROM note_items WHERE bot=? AND id=?')
        .get(bot, request.note);
      const now = new Date().toISOString();
      let item: NoteItem,
        changed = true;
      if (request.action === 'create') {
        if (row) throw new Fault('NOTE_ID_CONFLICT');
        if (Number(db.prepare('SELECT COUNT(*) AS n FROM note_items').get()!.n) >= capacity)
          throw new Fault('NOTE_LIMIT');
        item = {
          ...request.value,
          title: request.value.title.trim(),
          bot,
          id: request.note,
          revision: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          ...(request.value.status === 'done' ? { completedAt: now } : {}),
          createdBy: actor,
          updatedBy: actor,
        };
      } else {
        if (!row) throw new Fault('NOTE_NOT_FOUND', 404);
        const current = this.item(row);
        if (current.revision !== request.revision) throw new Fault('NOTE_CONFLICT');
        if (request.action === 'update' && current.deleted) throw new Fault('NOTE_TRASHED');
        item = {
          ...current,
          ...(request.action === 'update'
            ? request.value
            : { deleted: request.action === 'trash' }),
        };
        item.title = item.title.trim();
        changed = ['title', 'body', 'status', 'deleted'].some(
          (key) => current[key as keyof NoteItem] !== item[key as keyof NoteItem],
        );
        if (changed) {
          item.revision++;
          item.updatedAt = new Date(
            Math.max(Date.now(), Date.parse(current.updatedAt)),
          ).toISOString();
          item.updatedBy = actor;
          if (item.status === 'done')
            item.completedAt = current.status === 'done' ? current.completedAt : item.updatedAt;
          else delete item.completedAt;
        }
      }
      return this.transaction(() => {
        if (request.action === 'create')
          db.prepare(
            'INSERT INTO note_items(bot,id,title,body,status,revision,deleted,created,updated,completed,creator,editor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            bot,
            item.id,
            item.title,
            item.body,
            item.status,
            item.revision,
            Number(item.deleted),
            item.createdAt,
            item.updatedAt,
            item.completedAt ?? null,
            JSON.stringify(item.createdBy),
            JSON.stringify(item.updatedBy),
          );
        else if (changed) {
          const result = db
            .prepare(
              'UPDATE note_items SET title=?,body=?,status=?,revision=?,deleted=?,updated=?,completed=?,editor=? WHERE bot=? AND id=? AND revision=?',
            )
            .run(
              item.title,
              item.body,
              item.status,
              item.revision,
              Number(item.deleted),
              item.updatedAt,
              item.completedAt ?? null,
              JSON.stringify(item.updatedBy),
              bot,
              item.id,
              request.revision,
            );
          if (Number(result.changes) !== 1) throw new Fault('NOTE_CONFLICT');
        }
        db.prepare(
          'INSERT INTO note_operations(bot,id,note,signature,revision,at) VALUES(?,?,?,?,?,?)',
        ).run(bot, request.id, item.id, signature(bot, request, actor), item.revision, now);
        if (changed)
          db.prepare(
            'INSERT INTO note_meta(bot,revision) VALUES(?,1) ON CONFLICT(bot) DO UPDATE SET revision=revision+1',
          ).run(bot);
        return {
          state: 'complete' as const,
          bot,
          request,
          actor,
          acceptedRevision: item.revision,
          acceptedAt: now,
          item,
        };
      });
    }, signal);
  }
  async close() {
    this.closed = true;
    await this.chain.catch(() => {});
    await this.ready.catch(() => {});
    this.db?.close();
    this.db = undefined;
  }
}
