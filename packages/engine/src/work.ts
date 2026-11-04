import { createHash } from 'node:crypto';
import { chmod, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isLegacyWorkWrite,
  isWorkAuthor,
  isWorkComment,
  isWorkCommentQuery,
  isWorkCommentReceipt,
  isWorkCommentWrite,
  isWorkCompleted,
  isWorkItem,
  isWorkQuery,
  isWorkReceipt,
  isWorkWrite,
  legacyWorkState,
  legacyWorkStates,
  validAgentId,
  type WorkAck,
  type WorkAuthor,
  type WorkComment,
  type WorkCommentAck,
  type WorkCommentPage,
  type WorkCommentReceipt,
  type WorkCommentWrite,
  type WorkItem,
  type WorkPage,
  type WorkReceipt,
  type WorkStatus,
  type WorkWrite,
  workCommentKey,
  workKey,
  workPriorities,
} from '@daban/protocol';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  min,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
  sum,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate, tables, unwrap } from './database.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { migrations } from './work-migrations.js';
import { workComments, workItems, workMeta, workOperations } from './work-schema.js';

type ItemRow = typeof workItems.$inferSelect;
type OperationRow = typeof workOperations.$inferSelect;
type CommentRow = typeof workComments.$inferSelect;
const capacity = 1000,
  operations = 10000;
const legacyTables = ['work_items', 'work_meta', 'work_operations'];
const currentTables = ['work_comments', ...legacyTables];
// SQLite maintains AUTOINCREMENT counters here; it is read only and never part of the migrated schema.
const sequence = sqliteTable('sqlite_sequence', { name: text(), seq: integer() });
const signature = (request: WorkWrite, actor: WorkAuthor) =>
  createHash('sha256').update(workKey(request, actor)).digest('hex');
const commentSignature = (request: WorkCommentWrite, actor: WorkAuthor) =>
  createHash('sha256').update(workCommentKey(request, actor)).digest('hex');
const commentSchema = `CREATE TABLE work_comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,item TEXT NOT NULL REFERENCES work_items(id),body TEXT NOT NULL,creator TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;`;

function validateColumns(client: DatabaseSync, version: number) {
  // Check legacy layout before DDL: a check after COMMIT would already have adopted an unsupported store.
  const columns = client.prepare('PRAGMA table_info(work_items)').all();
  const core = [
    'seq',
    'id',
    'title',
    'description',
    'progress',
    'status',
    'revision',
    'deleted',
    'created',
    'updated',
    'completed',
    'creator',
    'editor',
  ];
  const names = version < 3 ? core : [...core, 'priority', 'assignee'];
  if (JSON.stringify(columns.map((row) => row.name)) !== JSON.stringify(names))
    throw new Fault('WORK_CORRUPT');
  for (const row of columns) {
    const name = String(row.name);
    const type = ['seq', 'revision', 'deleted'].includes(name) ? 'INTEGER' : 'TEXT';
    if (
      row.type !== type ||
      row.pk !== (name === 'seq' ? 1 : 0) ||
      row.notnull !== (['seq', 'completed', 'assignee'].includes(name) ? 0 : 1)
    )
      throw new Fault('WORK_CORRUPT');
  }
  if (version < 3) return;
  const priority = columns.find((row) => row.name === 'priority');
  const assignee = columns.find((row) => row.name === 'assignee');
  if (
    columns.length !== 15 ||
    priority?.type !== 'TEXT' ||
    priority.notnull !== 1 ||
    priority.dflt_value !== "'normal'" ||
    priority.pk !== 0 ||
    assignee?.type !== 'TEXT' ||
    assignee.notnull !== 0 ||
    assignee.dflt_value !== null ||
    assignee.pk !== 0
  )
    throw new Fault('WORK_CORRUPT');
}

export class Work {
  // One local runtime owns this file; add a process lease before multiple service writers are supported.
  readonly ready: Promise<unknown>;
  private db?: Database;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private loading = true;
  constructor(
    readonly file: string,
    private readonly admit: (actor: WorkAuthor) => undefined = () => undefined,
  ) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    // Establish the private ACL root before validating an existing Windows database.
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
      throw new Fault('WORK_CORRUPT');
    if (!existing) await (await open(this.file, 'wx', 0o600)).close();
    await chmod(this.file, 0o600);
    let client: DatabaseSync | undefined;
    try {
      client = new DatabaseSync(this.file);
      configure(client, {
        journal: 'WAL',
        synchronous: 'FULL',
        foreignKeys: true,
        busyTimeout: 5000,
      });
      this.db = migrate(client, migrations, (legacy) => this.upgrade(legacy));
      this.validate(this.db, 3);
    } catch {
      client?.close();
      this.db = undefined;
      throw new Fault('WORK_CORRUPT');
    } finally {
      this.loading = false;
    }
  }
  // Pre-ORM files carry user_version 1-3. This runs inside migrate's transaction, so any refusal
  // leaves the old file untouched and every accepted file ends at the baseline schema.
  private upgrade(client: DatabaseSync) {
    const version = Number(client.prepare('PRAGMA user_version').get()?.user_version);
    if (
      ![1, 2, 3].includes(version) ||
      JSON.stringify(tables(client)) !==
        JSON.stringify(version === 1 ? legacyTables : currentTables)
    )
      throw new Fault('WORK_CORRUPT');
    validateColumns(client, version);
    const meta = client.prepare('SELECT id,revision FROM work_meta').all();
    if (
      meta.length !== 1 ||
      meta[0].id !== 1 ||
      !Number.isSafeInteger(meta[0].revision) ||
      Number(meta[0].revision) < 0 ||
      Number(meta[0].revision) > operations
    )
      throw new Fault('WORK_CORRUPT');
    if (version === 1) {
      client.exec(
        'ALTER TABLE work_meta ADD COLUMN comments INTEGER NOT NULL DEFAULT 0 CHECK(comments>=0)',
      );
      client.exec(commentSchema);
    }
    if (version < 3) {
      client.exec(
        "ALTER TABLE work_items ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent'))",
      );
      client.exec('ALTER TABLE work_items ADD COLUMN assignee TEXT');
      client.exec('PRAGMA user_version=3');
    }
    validateColumns(client, 3);
    // Validate every legacy receipt and comment before the baseline is recorded.
    this.validate(drizzle({ client }), version);
  }
  private validate(db: Database, version: number) {
    if (JSON.stringify(tables(db)) !== JSON.stringify(currentTables))
      throw new Fault('WORK_CORRUPT');
    this.validateWork(db, version);
    this.commentAuthority(db);
    for (const row of db.select().from(workComments).all()) this.commentRow(row, db);
  }
  private exclusive<T>(action: () => T, signal?: AbortSignal): Promise<T> {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (this.closed || !this.db) throw new Fault('WORK_CLOSED');
        signal?.throwIfAborted();
        try {
          return action();
        } catch (error) {
          throw unwrap(error);
        }
      });
    this.chain = next;
    return next;
  }
  private database() {
    // close() drains ready; only the loader may finish its atomic schema work after admission closes.
    if (!this.db || (this.closed && !this.loading)) throw new Fault('WORK_CLOSED');
    return this.db;
  }
  private validateWork(db: Database, version: number) {
    const rows = db.select().from(workItems).all();
    if (rows.length > capacity) throw new Fault('WORK_CORRUPT');
    for (const row of rows) this.item(row, version < 3);
    const revision = db
      .select({ revision: workMeta.revision })
      .from(workMeta)
      .where(eq(workMeta.id, 1))
      .get()?.revision;
    const total = rows.reduce((value, row) => value + Number(row.revision), 0);
    if (!Number.isSafeInteger(total) || revision !== total) throw new Fault('WORK_CORRUPT');
    const receipts = db
      .select({
        id: workOperations.id,
        item: workOperations.item,
        signature: workOperations.signature,
        revision: workOperations.revision,
        at: workOperations.at,
        itemRevision: workItems.revision,
      })
      .from(workOperations)
      .leftJoin(workItems, eq(workItems.id, workOperations.item))
      .all();
    if (receipts.length > operations) throw new Fault('WORK_CORRUPT');
    if (version === 1 && receipts.length < total) throw new Fault('WORK_CORRUPT');
    for (const row of receipts) {
      this.operation(row);
      if (Number(row.itemRevision) < Number(row.revision)) throw new Fault('WORK_CORRUPT');
    }
  }
  private commentAuthority(db = this.database()) {
    const meta = db
      .select({ revision: workMeta.revision, comments: workMeta.comments })
      .from(workMeta)
      .where(eq(workMeta.id, 1))
      .get();
    const counts = db
      .select({ n: count(), first: min(workComments.seq), last: max(workComments.seq) })
      .from(workComments)
      .get()!;
    const sequenced =
      db
        .select({ seq: sequence.seq })
        .from(sequence)
        .where(eq(sequence.name, 'work_comments'))
        .get()?.seq ?? 0;
    const legacy = db.select({ n: count() }).from(workOperations).get()!.n;
    const itemRevisions =
      db
        .select({ n: sum(workItems.revision).mapWith(Number) })
        .from(workItems)
        .get()?.n ?? 0;
    if (
      !meta ||
      !Number.isSafeInteger(meta.revision) ||
      meta.revision < 0 ||
      meta.revision > operations ||
      !Number.isSafeInteger(meta.comments) ||
      meta.comments < 0 ||
      meta.comments > meta.revision ||
      meta.revision !== itemRevisions ||
      meta.revision > legacy + counts.n ||
      meta.comments !== counts.n ||
      sequenced !== counts.n ||
      (counts.n > 0 && (counts.first !== 1 || counts.last !== counts.n)) ||
      legacy + counts.n > operations ||
      db
        .select({ id: workComments.id })
        .from(workComments)
        .innerJoin(workOperations, eq(workOperations.id, workComments.id))
        .limit(1)
        .get()
    )
      throw new Fault('WORK_CORRUPT');
    return meta.comments;
  }
  private operationCount() {
    return (
      this.database().select({ n: count() }).from(workOperations).get()!.n + this.commentAuthority()
    );
  }
  private revision() {
    const row = this.database()
      .select({ revision: workMeta.revision })
      .from(workMeta)
      .where(eq(workMeta.id, 1))
      .get();
    if (
      !row ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      row.revision > operations
    )
      throw new Fault('WORK_CORRUPT');
    this.commentAuthority();
    return row.revision;
  }
  private item(row: ItemRow, legacy = false): WorkItem {
    // Pre-workflow files only knew the three legacy states; anything else there is corruption.
    if (legacy && !legacyWorkStates.includes(row.status as (typeof legacyWorkStates)[number]))
      throw new Fault('WORK_CORRUPT');
    if (
      !workPriorities.includes(row.priority as (typeof workPriorities)[number]) ||
      (row.assignee !== null && !validAgentId(row.assignee))
    )
      throw new Fault('WORK_CORRUPT');
    let createdBy: unknown, updatedBy: unknown;
    try {
      createdBy = JSON.parse(String(row.creator));
      updatedBy = JSON.parse(String(row.editor));
    } catch {
      throw new Fault('WORK_CORRUPT');
    }
    const item = {
      id: row.id,
      title: row.title,
      description: row.description,
      progress: row.progress,
      status: row.status,
      ...(row.priority !== 'normal' ? { priority: row.priority } : {}),
      ...(row.assignee !== null ? { assignee: row.assignee } : {}),
      revision: row.revision,
      deleted: row.deleted === 1,
      createdAt: row.created,
      updatedAt: row.updated,
      ...(row.completed === null ? {} : { completedAt: row.completed }),
      createdBy,
      updatedBy,
    };
    if (!isWorkItem(item) || ![0, 1].includes(Number(row.deleted))) throw new Fault('WORK_CORRUPT');
    return item;
  }
  private find(id: string, db = this.database()) {
    if (!validAgentId(id)) throw new Fault('INVALID_WORK_QUERY', 400);
    const row = db.select().from(workItems).where(eq(workItems.id, id)).get();
    if (!row) throw new Fault('WORK_NOT_FOUND', 404);
    return this.item(row);
  }
  get(id: string) {
    return this.exclusive(() => this.find(id));
  }
  async status(): Promise<WorkStatus> {
    try {
      await this.ready;
      if (this.closed) return { available: false, error: 'WORK_CLOSED' };
      const db = this.database();
      const total = db.select({ count: count() }).from(workItems).get()!.count;
      return { available: true, revision: this.revision(), count: total };
    } catch {
      return { available: false, error: 'WORK_CORRUPT' };
    }
  }
  list(input: unknown = {}): Promise<WorkPage> {
    if (!isWorkQuery(input)) return Promise.reject(new Fault('INVALID_WORK_QUERY', 400));
    const query = structuredClone(input);
    return this.exclusive(() => {
      const filter = query.filter ?? 'all';
      const conditions: (SQL | undefined)[] = [eq(workItems.deleted, filter === 'trash' ? 1 : 0)];
      if (filter === 'open') conditions.push(notInArray(workItems.status, ['done', 'closed']));
      if (filter === 'done') conditions.push(inArray(workItems.status, ['done', 'closed']));
      if (query.before !== undefined) conditions.push(lt(workItems.seq, query.before));
      if (query.text) {
        const text = `%${query.text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        // The builder's like() has no ESCAPE clause; the pattern itself stays a bound parameter.
        const contains = (column: SQLWrapper) => sql`${column} LIKE ${text} ESCAPE '\\'`;
        conditions.push(
          or(
            contains(workItems.title),
            contains(workItems.description),
            contains(workItems.progress),
          ),
        );
      }
      if (query.status !== undefined) conditions.push(eq(workItems.status, query.status));
      if (query.priority !== undefined) conditions.push(eq(workItems.priority, query.priority));
      if (Object.hasOwn(query, 'assignee'))
        conditions.push(
          query.assignee === null
            ? isNull(workItems.assignee)
            : eq(workItems.assignee, query.assignee!),
        );
      const limit = query.limit ?? 50;
      const rows = this.database()
        .select()
        .from(workItems)
        .where(and(...conditions))
        .orderBy(desc(workItems.seq))
        .limit(limit + 1)
        .all();
      const page = rows.slice(0, limit);
      return {
        revision: this.revision(),
        items: page.map((row) => {
          const { description: _description, progress, ...item } = this.item(row);
          const chars = Array.from(progress);
          return {
            ...item,
            progress: chars.slice(0, 200).join(''),
            progressTruncated: chars.length > 200,
          };
        }),
        ...(rows.length > limit ? { nextBefore: page.at(-1)!.seq } : {}),
      };
    });
  }
  private operation(row: OperationRow) {
    if (
      !validAgentId(row.id) ||
      !validAgentId(row.item) ||
      typeof row.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.signature) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.at !== 'string' ||
      row.at.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(row.at) ||
      !Number.isFinite(Date.parse(row.at))
    )
      throw new Fault('WORK_CORRUPT');
  }
  private accepted(request: WorkWrite, actor: WorkAuthor): WorkAck | undefined {
    const db = this.database();
    const row = db.select().from(workOperations).where(eq(workOperations.id, request.id)).get();
    if (!row) {
      if (
        db
          .select({ id: workComments.id })
          .from(workComments)
          .where(eq(workComments.id, request.id))
          .get()
      )
        throw new Fault('WORK_REQUEST_CONFLICT');
      return undefined;
    }
    this.operation(row);
    if (row.signature !== signature(request, actor)) throw new Fault('WORK_REQUEST_CONFLICT');
    if (
      row.item !== request.item ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.at !== 'string' ||
      !Number.isFinite(Date.parse(row.at))
    )
      throw new Fault('WORK_CORRUPT');
    let item: WorkItem;
    try {
      item = this.find(request.item);
    } catch {
      throw new Fault('WORK_CORRUPT');
    }
    if (item.revision < row.revision) throw new Fault('WORK_CORRUPT');
    const accepted: WorkAck = {
      state: 'complete',
      request,
      actor,
      acceptedRevision: row.revision,
      acceptedAt: row.at,
      item,
    };
    if (!isWorkReceipt(accepted)) throw new Fault('WORK_CORRUPT');
    return accepted;
  }
  receipt(input: unknown, by: unknown): Promise<WorkReceipt> {
    if (!isWorkWrite(input)) return Promise.reject(new Fault('INVALID_WORK_WRITE', 400));
    if (!isWorkAuthor(by)) return Promise.reject(new Fault('INVALID_WORK_ACTOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive<WorkReceipt>(
      () => this.accepted(request, actor) ?? { state: 'unknown', request, actor },
    );
  }
  write(input: unknown, by: unknown, signal?: AbortSignal): Promise<WorkAck> {
    return this.writeFor(input, by, signal, false);
  }
  writeLegacy(input: unknown, by: unknown, signal?: AbortSignal): Promise<WorkAck> {
    if (!isLegacyWorkWrite(input)) return Promise.reject(new Fault('INVALID_WORK_WRITE', 400));
    return this.writeFor(input, by, signal, true);
  }
  private writeFor(
    input: unknown,
    by: unknown,
    signal: AbortSignal | undefined,
    legacy: boolean,
  ): Promise<WorkAck> {
    if (!isWorkWrite(input)) return Promise.reject(new Fault('INVALID_WORK_WRITE', 400));
    if (!isWorkAuthor(by)) return Promise.reject(new Fault('INVALID_WORK_ACTOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive(() => {
      // Receipt lookup precedes CAS and trash checks: retry never reapplies old intent over newer work.
      const prior = this.accepted(request, actor);
      if (prior) return prior;
      // Check admission inside the serialized effect: recovery or Bot lifecycle may change while queued.
      this.admit(actor);
      this.revision();
      const db = this.database();
      if (this.operationCount() >= operations) throw new Fault('WORK_OPERATION_LIMIT');
      const row = db.select().from(workItems).where(eq(workItems.id, request.item)).get();
      let now = new Date().toISOString();
      let item: WorkItem,
        changed = true;
      if (request.action === 'create') {
        if (row) throw new Fault('WORK_ID_CONFLICT');
        if (db.select({ count: count() }).from(workItems).get()!.count >= capacity)
          throw new Fault('WORK_LIMIT');
        item = {
          ...request.value,
          title: request.value.title.trim(),
          id: request.item,
          revision: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          ...(isWorkCompleted(request.value.status) ? { completedAt: now } : {}),
          createdBy: actor,
          updatedBy: actor,
        };
        if (item.priority === 'normal') delete item.priority;
        if (item.assignee === null) delete item.assignee;
        if (item.assignee) this.admit({ kind: 'bot', bot: item.assignee });
      } else {
        if (!row) throw new Fault('WORK_NOT_FOUND', 404);
        const current = this.item(row);
        // Stored discussion times must stay readable when the host clock moves backward.
        now = new Date(
          Math.max(Date.parse(now), Date.parse(current.updatedAt), Date.parse(current.createdAt)),
        ).toISOString();
        if (current.revision !== request.revision) throw new Fault('WORK_CONFLICT');
        if ((request.action === 'update' || request.action === 'reopen') && current.deleted)
          throw new Fault('WORK_TRASHED');
        const patch = request.action === 'update' ? { ...request.value } : undefined;
        // Legacy full forms echo a three-state projection; that echo must not erase hidden workflow state.
        if (
          legacy &&
          patch?.status !== undefined &&
          !legacyWorkStates.includes(current.status as (typeof legacyWorkStates)[number])
        ) {
          if (patch.status === legacyWorkState(current.status)) delete patch.status;
          else if (current.status === 'closed') throw new Fault('WORK_CONFLICT');
        }
        if (request.action === 'reopen') {
          if (actor.kind !== 'human') throw new Fault('WORK_REOPEN_FORBIDDEN');
          if (current.status !== 'closed') throw new Fault('WORK_STATE_CONFLICT');
        }
        if (
          request.action === 'update' &&
          current.status === 'closed' &&
          patch?.status !== undefined &&
          patch.status !== 'closed'
        )
          throw new Fault('WORK_REOPEN_REQUIRED');
        if (
          request.action === 'update' &&
          typeof request.value.assignee === 'string' &&
          request.value.assignee !== current.assignee
        )
          this.admit({ kind: 'bot', bot: request.value.assignee });
        item = {
          ...current,
          ...(request.action === 'update'
            ? patch
            : request.action === 'reopen'
              ? { status: 'todo' as const }
              : { deleted: request.action === 'trash' }),
        };
        item.title = item.title.trim();
        if (item.priority === 'normal') delete item.priority;
        if (item.assignee === null) delete item.assignee;
        changed = [
          'title',
          'description',
          'progress',
          'status',
          'deleted',
          'priority',
          'assignee',
        ].some((key) => current[key as keyof WorkItem] !== item[key as keyof WorkItem]);
        if (changed) {
          item.revision++;
          item.updatedAt = now;
          item.updatedBy = actor;
          if (isWorkCompleted(item.status))
            item.completedAt = isWorkCompleted(current.status) ? current.completedAt : now;
          else delete item.completedAt;
        }
      }
      return db.transaction(
        (tx) => {
          if (request.action === 'create')
            tx.insert(workItems)
              .values({
                id: item.id,
                title: item.title,
                description: item.description,
                progress: item.progress,
                status: item.status,
                revision: item.revision,
                deleted: Number(item.deleted),
                created: item.createdAt,
                updated: item.updatedAt,
                completed: item.completedAt ?? null,
                creator: JSON.stringify(item.createdBy),
                editor: JSON.stringify(item.updatedBy),
                priority: item.priority ?? 'normal',
                assignee: item.assignee ?? null,
              })
              .run();
          else if (changed) {
            const result = tx
              .update(workItems)
              .set({
                title: item.title,
                description: item.description,
                progress: item.progress,
                status: item.status,
                revision: item.revision,
                deleted: Number(item.deleted),
                updated: item.updatedAt,
                completed: item.completedAt ?? null,
                editor: JSON.stringify(item.updatedBy),
                priority: item.priority ?? 'normal',
                assignee: item.assignee ?? null,
              })
              .where(and(eq(workItems.id, item.id), eq(workItems.revision, request.revision)))
              .run();
            if (Number(result.changes) !== 1) throw new Fault('WORK_CONFLICT');
          }
          tx.insert(workOperations)
            .values({
              id: request.id,
              item: item.id,
              signature: signature(request, actor),
              revision: item.revision,
              at: now,
            })
            .run();
          if (
            changed &&
            Number(
              tx
                .update(workMeta)
                .set({ revision: sql`${workMeta.revision} + 1` })
                .where(eq(workMeta.id, 1))
                .run().changes,
            ) !== 1
          )
            throw new Fault('WORK_CORRUPT');
          return {
            state: 'complete' as const,
            request,
            actor,
            acceptedRevision: item.revision,
            acceptedAt: now,
            item,
          };
        },
        { behavior: 'immediate' },
      );
    }, signal);
  }
  private commentRow(row: CommentRow, db = this.database()): WorkComment {
    let author: unknown;
    try {
      author = JSON.parse(String(row.creator));
    } catch {
      throw new Fault('WORK_CORRUPT');
    }
    const value = {
      id: row.id,
      item: row.item,
      body: row.body,
      createdAt: row.at,
      createdBy: author,
    };
    if (
      !isWorkComment(value) ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 2 ||
      typeof row.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.signature)
    )
      throw new Fault('WORK_CORRUPT');
    const request = {
      id: value.id,
      item: value.item,
      body: value.body,
      revision: row.revision - 1,
    };
    if (commentSignature(request, value.createdBy) !== row.signature)
      throw new Fault('WORK_CORRUPT');
    let item: WorkItem;
    try {
      item = this.find(value.item, db);
    } catch {
      throw new Fault('WORK_CORRUPT');
    }
    if (
      item.revision < row.revision ||
      Date.parse(value.createdAt) < Date.parse(item.createdAt) ||
      Date.parse(value.createdAt) > Date.parse(item.updatedAt)
    )
      throw new Fault('WORK_CORRUPT');
    return value;
  }
  private acceptedComment(
    request: WorkCommentWrite,
    actor: WorkAuthor,
  ): WorkCommentAck | undefined {
    this.commentAuthority();
    const db = this.database(),
      row = db.select().from(workComments).where(eq(workComments.id, request.id)).get();
    if (!row) {
      if (
        db
          .select({ id: workOperations.id })
          .from(workOperations)
          .where(eq(workOperations.id, request.id))
          .get()
      )
        throw new Fault('WORK_REQUEST_CONFLICT');
      return undefined;
    }
    const comment = this.commentRow(row);
    if (row.signature !== commentSignature(request, actor))
      throw new Fault('WORK_REQUEST_CONFLICT');
    const result = {
      state: 'complete' as const,
      request,
      actor,
      acceptedRevision: row.revision,
      acceptedAt: comment.createdAt,
      comment,
      item: this.find(request.item),
    };
    if (!isWorkCommentReceipt(result)) throw new Fault('WORK_CORRUPT');
    return result;
  }
  commentReceipt(input: unknown, by: unknown): Promise<WorkCommentReceipt> {
    if (!isWorkCommentWrite(input)) return Promise.reject(new Fault('INVALID_WORK_COMMENT', 400));
    if (!isWorkAuthor(by)) return Promise.reject(new Fault('INVALID_WORK_ACTOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive(
      () => this.acceptedComment(request, actor) ?? { state: 'unknown', request, actor },
    );
  }
  comment(input: unknown, by: unknown, signal?: AbortSignal): Promise<WorkCommentAck> {
    if (!isWorkCommentWrite(input)) return Promise.reject(new Fault('INVALID_WORK_COMMENT', 400));
    if (!isWorkAuthor(by)) return Promise.reject(new Fault('INVALID_WORK_ACTOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive(() => {
      // The original immutable comment is a receipt; replay must never append it onto a newer item again.
      const accepted = this.acceptedComment(request, actor);
      if (accepted) return accepted;
      // Accepted retries above are readers; only a new append needs current admission.
      this.admit(actor);
      if (this.operationCount() >= operations) throw new Fault('WORK_OPERATION_LIMIT');
      const current = this.find(request.item);
      if (current.revision !== request.revision) throw new Fault('WORK_CONFLICT');
      if (current.deleted) throw new Fault('WORK_TRASHED');
      const now = new Date(
        Math.max(Date.now(), Date.parse(current.updatedAt), Date.parse(current.createdAt)),
      ).toISOString();
      const item = { ...current, revision: current.revision + 1, updatedAt: now, updatedBy: actor };
      const comment = {
        id: request.id,
        item: request.item,
        body: request.body,
        createdAt: now,
        createdBy: actor,
      };
      const result = {
        state: 'complete' as const,
        request,
        actor,
        acceptedRevision: item.revision,
        acceptedAt: now,
        item,
        comment,
      };
      if (!isWorkCommentReceipt(result)) throw new Fault('WORK_CORRUPT');
      return this.database().transaction(
        (tx) => {
          if (
            Number(
              tx
                .update(workItems)
                .set({ revision: item.revision, updated: now, editor: JSON.stringify(actor) })
                .where(and(eq(workItems.id, item.id), eq(workItems.revision, request.revision)))
                .run().changes,
            ) !== 1
          )
            throw new Fault('WORK_CONFLICT');
          tx.insert(workComments)
            .values({
              id: comment.id,
              item: comment.item,
              body: comment.body,
              creator: JSON.stringify(actor),
              signature: commentSignature(request, actor),
              revision: item.revision,
              at: now,
            })
            .run();
          if (
            Number(
              tx
                .update(workMeta)
                .set({
                  revision: sql`${workMeta.revision} + 1`,
                  comments: sql`${workMeta.comments} + 1`,
                })
                .where(eq(workMeta.id, 1))
                .run().changes,
            ) !== 1
          )
            throw new Fault('WORK_CORRUPT');
          return result;
        },
        { behavior: 'immediate' },
      );
    }, signal);
  }
  comments(input: unknown): Promise<WorkCommentPage> {
    if (!isWorkCommentQuery(input)) return Promise.reject(new Fault('INVALID_WORK_QUERY', 400));
    const query = structuredClone(input);
    return this.exclusive(() => {
      const item = this.find(query.item);
      this.commentAuthority();
      const limit = query.limit ?? 50;
      const rows = this.database()
        .select()
        .from(workComments)
        .where(
          and(
            eq(workComments.item, query.item),
            query.before === undefined ? undefined : lt(workComments.seq, query.before),
          ),
        )
        .orderBy(desc(workComments.seq))
        .limit(limit + 1)
        .all();
      const comments: WorkComment[] = [];
      let last: number | undefined;
      for (const row of rows.slice(0, limit)) {
        const next = this.commentRow(row);
        // One bounded response must fit the existing model projection budget even for fully escaped text.
        const projected = {
          item: item.id,
          revision: item.revision,
          comments: [...comments, next],
          nextBefore: row.seq,
        };
        if (Buffer.byteLength(JSON.stringify(projected)) > 120 * 1024) break;
        comments.push(next);
        last = row.seq;
      }
      return {
        item: item.id,
        revision: item.revision,
        comments,
        ...(rows.length > comments.length ? { nextBefore: last } : {}),
      };
    });
  }
  async close() {
    this.closed = true;
    await this.chain.catch(() => {});
    await this.ready.catch(() => {});
    this.db?.$client.close();
    this.db = undefined;
  }
}
