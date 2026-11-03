import { createHash } from 'node:crypto';
import { chmod, lstat, open } from 'node:fs/promises';
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
import { and, count, desc, eq, getColumns, lt, ne, or, type SQL, sql, sum } from 'drizzle-orm';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate, tables, unwrap } from './database.js';
import { migrations } from './notes-migrations.js';
import { noteItems, noteMeta, noteOperations } from './notes-schema.js';
import { privateMetadata, secureDirectory } from './private-files.js';

type Row = Record<string, unknown>;
const capacity = 1000,
  operationLimit = 10000;
const signature = (bot: string, request: NoteWrite, actor: NoteAuthor) =>
  createHash('sha256')
    .update(noteKey(bot, request, actor))
    .digest('hex');
const names = ['note_items', 'note_meta', 'note_operations'];

// Pre-ORM files: version 1 with exactly the three tables is the baseline; anything else stays refused.
function legacy(client: DatabaseSync) {
  const version = Number(client.prepare('PRAGMA user_version').get()!.user_version);
  if (version !== 1 || JSON.stringify(tables(client)) !== JSON.stringify(names))
    throw new Fault('NOTES_CORRUPT');
}

export class Notes {
  // One runtime owns the database; a process lease is required before supporting multiple writers.
  readonly ready: Promise<unknown>;
  private db?: Database;
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
    let client: DatabaseSync | undefined;
    try {
      // Windows privacy comes from the verified parent ACL rather than Unix file mode bits.
      await secureDirectory(path.dirname(this.file));
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
      client = new DatabaseSync(this.file);
      configure(client, { synchronous: 'FULL', foreignKeys: true, busyTimeout: 5000 });
      // Refusal happens before WAL so an unknown file keeps its exact bytes; a failed first open publishes no tables.
      this.db = migrate(client, migrations, legacy);
      configure(client, { journal: 'WAL' });
      if (JSON.stringify(tables(this.db)) !== JSON.stringify(names))
        throw new Fault('NOTES_CORRUPT');
      const items = this.db.select().from(noteItems).all();
      if (items.length > capacity) throw new Fault('NOTES_CORRUPT');
      const metas = this.db.select().from(noteMeta).all(),
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
        .select({ ...getColumns(noteOperations), noteRevision: noteItems.revision })
        .from(noteOperations)
        .leftJoin(
          noteItems,
          and(eq(noteItems.bot, noteOperations.bot), eq(noteItems.id, noteOperations.note)),
        )
        .all();
      if (operations.length > operationLimit) throw new Fault('NOTES_CORRUPT');
      for (const row of operations) {
        this.operation(row);
        if (
          !bots.has(String(row.bot)) ||
          !Number.isSafeInteger(row.noteRevision) ||
          Number(row.noteRevision) < Number(row.revision)
        )
          throw new Fault('NOTES_CORRUPT');
      }
    } catch {
      client?.close();
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
    const meta = db
      .select({ revision: noteMeta.revision })
      .from(noteMeta)
      .where(eq(noteMeta.bot, bot))
      .get();
    const total = db
      .select({ revision: sum(noteItems.revision).mapWith(Number) })
      .from(noteItems)
      .where(eq(noteItems.bot, bot))
      .get()!;
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
      .select()
      .from(noteItems)
      .where(and(eq(noteItems.bot, bot), eq(noteItems.id, id)))
      .get();
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
        count: this.database()
          .select({ n: count() })
          .from(noteItems)
          .where(eq(noteItems.bot, bot))
          .get()!.n,
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
      const conditions: (SQL | undefined)[] = [
        eq(noteItems.bot, bot),
        eq(noteItems.deleted, filter === 'trash' ? 1 : 0),
      ];
      if (filter === 'active') conditions.push(ne(noteItems.status, 'done'));
      else if (['open', 'parked', 'done'].includes(filter))
        conditions.push(eq(noteItems.status, filter));
      if (query.before !== undefined) conditions.push(lt(noteItems.seq, query.before));
      if (query.text) {
        const text = `%${query.text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        // Drizzle's like() has no ESCAPE clause; literal %, _ and backslash must not act as wildcards.
        conditions.push(
          or(
            sql`${noteItems.title} LIKE ${text} ESCAPE '\\'`,
            sql`${noteItems.body} LIKE ${text} ESCAPE '\\'`,
          ),
        );
      }
      const limit = query.limit ?? 50;
      const rows = this.database()
        .select()
        .from(noteItems)
        .where(and(...conditions))
        .orderBy(desc(noteItems.seq))
        .limit(limit + 1)
        .all();
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
      .select()
      .from(noteOperations)
      .where(and(eq(noteOperations.bot, bot), eq(noteOperations.id, request.id)))
      .get();
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
    try {
      // Boxing keeps the generic result distinguishable from a Promise for Drizzle's sync typing.
      return db.transaction(() => ({ result: action() }), { behavior: 'immediate' }).result;
    } catch (error) {
      throw unwrap(error);
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
      if (db.select({ n: count() }).from(noteOperations).get()!.n >= operationLimit)
        throw new Fault('NOTE_OPERATION_LIMIT');
      const row = db
        .select()
        .from(noteItems)
        .where(and(eq(noteItems.bot, bot), eq(noteItems.id, request.note)))
        .get();
      const now = new Date().toISOString();
      let item: NoteItem,
        changed = true;
      if (request.action === 'create') {
        if (row) throw new Fault('NOTE_ID_CONFLICT');
        if (db.select({ n: count() }).from(noteItems).get()!.n >= capacity)
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
          db.insert(noteItems)
            .values({
              bot,
              id: item.id,
              title: item.title,
              body: item.body,
              status: item.status,
              revision: item.revision,
              deleted: Number(item.deleted),
              created: item.createdAt,
              updated: item.updatedAt,
              completed: item.completedAt ?? null,
              creator: JSON.stringify(item.createdBy),
              editor: JSON.stringify(item.updatedBy),
            })
            .run();
        else if (changed) {
          const result = db
            .update(noteItems)
            .set({
              title: item.title,
              body: item.body,
              status: item.status,
              revision: item.revision,
              deleted: Number(item.deleted),
              updated: item.updatedAt,
              completed: item.completedAt ?? null,
              editor: JSON.stringify(item.updatedBy),
            })
            .where(
              and(
                eq(noteItems.bot, bot),
                eq(noteItems.id, item.id),
                eq(noteItems.revision, request.revision),
              ),
            )
            .run();
          if (Number(result.changes) !== 1) throw new Fault('NOTE_CONFLICT');
        }
        db.insert(noteOperations)
          .values({
            bot,
            id: request.id,
            note: item.id,
            signature: signature(bot, request, actor),
            revision: item.revision,
            at: now,
          })
          .run();
        if (changed)
          db.insert(noteMeta)
            .values({ bot, revision: 1 })
            .onConflictDoUpdate({
              target: noteMeta.bot,
              set: { revision: sql`${noteMeta.revision} + 1` },
            })
            .run();
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
    this.db?.$client.close();
    this.db = undefined;
  }
}
