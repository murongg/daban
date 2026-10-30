import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isWorkAuthor,
  isWorkComment,
  isWorkCommentQuery,
  isWorkCommentReceipt,
  isWorkCommentWrite,
  isWorkItem,
  isWorkQuery,
  isWorkReceipt,
  isWorkWrite,
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
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';

type Row = Record<string, unknown>;
const capacity = 1000,
  operations = 10000;
const signature = (request: WorkWrite, actor: WorkAuthor) =>
  createHash('sha256').update(workKey(request, actor)).digest('hex');
const commentSignature = (request: WorkCommentWrite, actor: WorkAuthor) =>
  createHash('sha256').update(workCommentKey(request, actor)).digest('hex');
const commentSchema = `CREATE TABLE work_comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,item TEXT NOT NULL REFERENCES work_items(id),body TEXT NOT NULL,creator TEXT NOT NULL,signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;`;
export class Work {
  // One local runtime owns this file; add a process lease before multiple service writers are supported.
  readonly ready: Promise<unknown>;
  private db?: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private loading = true;
  constructor(readonly file: string) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
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
        existing.uid !== process.getuid?.())
    )
      throw new Fault('WORK_CORRUPT');
    if (!existing) await (await open(this.file, 'wx', 0o600)).close();
    await chmod(this.file, 0o600);
    try {
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
          : ![1, 2].includes(version) ||
            JSON.stringify(names) !==
              JSON.stringify(
                version === 1
                  ? ['work_items', 'work_meta', 'work_operations']
                  : ['work_comments', 'work_items', 'work_meta', 'work_operations'],
              )
      )
        throw new Fault('WORK_CORRUPT');
      if (version > 0) {
        const meta = this.db.prepare('SELECT id,revision FROM work_meta').all();
        if (
          meta.length !== 1 ||
          meta[0].id !== 1 ||
          !Number.isSafeInteger(meta[0].revision) ||
          Number(meta[0].revision) < 0 ||
          Number(meta[0].revision) > operations
        )
          throw new Fault('WORK_CORRUPT');
      }
      this.db.exec(
        'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;',
      );
      // Validate legacy records before the additive migration; corrupt data must not be adopted as schema2.
      if (version === 1) this.validateWork();
      if (version === 0)
        this.transaction(() => {
          this.db!.exec(`
        CREATE TABLE IF NOT EXISTS work_items(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,progress TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,completed TEXT,creator TEXT NOT NULL,editor TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS work_operations(id TEXT PRIMARY KEY,item TEXT NOT NULL REFERENCES work_items(id),signature TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS work_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,comments INTEGER NOT NULL DEFAULT 0 CHECK(comments>=0)) STRICT;
        INSERT INTO work_meta VALUES(1,0,0);`);
          this.db!.exec(commentSchema);
          this.db!.exec('PRAGMA user_version=2');
        });
      else if (version === 1)
        this.transaction(() => {
          this.db!.exec(
            'ALTER TABLE work_meta ADD COLUMN comments INTEGER NOT NULL DEFAULT 0 CHECK(comments>=0)',
          );
          this.db!.exec(commentSchema);
          this.db!.exec('PRAGMA user_version=2');
        });
      this.validateWork();
      this.commentAuthority();
      for (const row of this.db.prepare('SELECT * FROM work_comments').all()) this.commentRow(row);
    } catch {
      this.db?.close();
      this.db = undefined;
      throw new Fault('WORK_CORRUPT');
    } finally {
      this.loading = false;
    }
  }
  private exclusive<T>(action: () => T, signal?: AbortSignal): Promise<T> {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        if (this.closed || !this.db) throw new Fault('WORK_CLOSED');
        signal?.throwIfAborted();
        return action();
      });
    this.chain = next;
    return next;
  }
  private database() {
    // close() drains ready; only the loader may finish its atomic schema work after admission closes.
    if (!this.db || (this.closed && !this.loading)) throw new Fault('WORK_CLOSED');
    return this.db;
  }
  private validateWork() {
    const db = this.database(),
      rows = db.prepare('SELECT * FROM work_items').all();
    if (rows.length > capacity) throw new Fault('WORK_CORRUPT');
    for (const row of rows) this.item(row);
    const revision = db.prepare('SELECT revision FROM work_meta WHERE id=1').get()?.revision;
    const sum = rows.reduce((total, row) => total + Number(row.revision), 0);
    if (!Number.isSafeInteger(sum) || revision !== sum) throw new Fault('WORK_CORRUPT');
    const receipts = db
      .prepare(
        'SELECT o.*,w.revision AS item_revision FROM work_operations o LEFT JOIN work_items w ON w.id=o.item',
      )
      .all();
    if (receipts.length > operations) throw new Fault('WORK_CORRUPT');
    if (
      Number(db.prepare('PRAGMA user_version').get()!.user_version) === 1 &&
      receipts.length < sum
    )
      throw new Fault('WORK_CORRUPT');
    for (const row of receipts) {
      this.operation(row);
      if (Number(row.item_revision) < Number(row.revision)) throw new Fault('WORK_CORRUPT');
    }
  }
  private commentAuthority() {
    const db = this.database(),
      meta = db.prepare('SELECT revision,comments FROM work_meta WHERE id=1').get();
    const counts = db
      .prepare('SELECT COUNT(*) AS n,MIN(seq) AS first,MAX(seq) AS last FROM work_comments')
      .get()!;
    const sequence =
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name='work_comments'").get()?.seq ?? 0;
    const legacy = Number(db.prepare('SELECT COUNT(*) AS n FROM work_operations').get()!.n);
    const itemRevisions = db
      .prepare('SELECT COALESCE(SUM(revision),0) AS n FROM work_items')
      .get()!.n;
    if (
      !meta ||
      !Number.isSafeInteger(meta.revision) ||
      Number(meta.revision) < 0 ||
      Number(meta.revision) > operations ||
      !Number.isSafeInteger(meta.comments) ||
      Number(meta.comments) < 0 ||
      Number(meta.comments) > Number(meta.revision) ||
      meta.revision !== itemRevisions ||
      Number(meta.revision) > legacy + Number(counts.n) ||
      meta.comments !== counts.n ||
      sequence !== counts.n ||
      (Number(counts.n) > 0 && (counts.first !== 1 || counts.last !== counts.n)) ||
      legacy + Number(counts.n) > operations ||
      db.prepare('SELECT 1 FROM work_comments c JOIN work_operations o ON o.id=c.id LIMIT 1').get()
    )
      throw new Fault('WORK_CORRUPT');
    return Number(meta.comments);
  }
  private operationCount() {
    return (
      Number(this.database().prepare('SELECT COUNT(*) AS n FROM work_operations').get()!.n) +
      this.commentAuthority()
    );
  }
  private revision() {
    const row = this.database().prepare('SELECT revision FROM work_meta WHERE id=1').get();
    if (
      !row ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 0 ||
      Number(row.revision) > operations
    )
      throw new Fault('WORK_CORRUPT');
    this.commentAuthority();
    return Number(row.revision);
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
  private item(row: Row): WorkItem {
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
  private find(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_WORK_QUERY', 400);
    const row = this.database().prepare('SELECT * FROM work_items WHERE id=?').get(id);
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
      const count = Number(db.prepare('SELECT COUNT(*) AS count FROM work_items').get()!.count);
      return { available: true, revision: this.revision(), count };
    } catch {
      return { available: false, error: 'WORK_CORRUPT' };
    }
  }
  list(input: unknown = {}): Promise<WorkPage> {
    if (!isWorkQuery(input)) return Promise.reject(new Fault('INVALID_WORK_QUERY', 400));
    const query = structuredClone(input);
    return this.exclusive(() => {
      const filter = query.filter ?? 'all',
        conditions = [filter === 'trash' ? 'deleted=1' : 'deleted=0'];
      const values: (string | number)[] = [];
      if (filter === 'open') conditions.push("status!='done'");
      if (filter === 'done') conditions.push("status='done'");
      if (query.before !== undefined) {
        conditions.push('seq<?');
        values.push(query.before);
      }
      if (query.text) {
        const text = `%${query.text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        conditions.push(
          "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR progress LIKE ? ESCAPE '\\')",
        );
        values.push(text, text, text);
      }
      const limit = query.limit ?? 50;
      const rows = this.database()
        .prepare(
          `SELECT * FROM work_items WHERE ${conditions.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
        )
        .all(...values, limit + 1);
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
        ...(rows.length > limit ? { nextBefore: Number(page.at(-1)!.seq) } : {}),
      };
    });
  }
  private operation(row: Row) {
    if (
      !validAgentId(row.id) ||
      !validAgentId(row.item) ||
      typeof row.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.signature) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
      typeof row.at !== 'string' ||
      row.at.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(row.at) ||
      !Number.isFinite(Date.parse(row.at))
    )
      throw new Fault('WORK_CORRUPT');
  }
  private accepted(request: WorkWrite, actor: WorkAuthor): WorkAck | undefined {
    const row = this.database().prepare('SELECT * FROM work_operations WHERE id=?').get(request.id);
    if (!row) {
      if (this.database().prepare('SELECT 1 FROM work_comments WHERE id=?').get(request.id))
        throw new Fault('WORK_REQUEST_CONFLICT');
      return undefined;
    }
    this.operation(row);
    if (row.signature !== signature(request, actor)) throw new Fault('WORK_REQUEST_CONFLICT');
    if (
      row.item !== request.item ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
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
    if (item.revision < Number(row.revision)) throw new Fault('WORK_CORRUPT');
    const accepted: WorkAck = {
      state: 'complete',
      request,
      actor,
      acceptedRevision: Number(row.revision),
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
    if (!isWorkWrite(input)) return Promise.reject(new Fault('INVALID_WORK_WRITE', 400));
    if (!isWorkAuthor(by)) return Promise.reject(new Fault('INVALID_WORK_ACTOR', 400));
    const request = structuredClone(input),
      actor = structuredClone(by);
    return this.exclusive(() => {
      // Receipt lookup precedes CAS and trash checks: retry never reapplies old intent over newer work.
      const prior = this.accepted(request, actor);
      if (prior) return prior;
      this.revision();
      const db = this.database();
      if (this.operationCount() >= operations) throw new Fault('WORK_OPERATION_LIMIT');
      const row = db.prepare('SELECT * FROM work_items WHERE id=?').get(request.item);
      let now = new Date().toISOString();
      let item: WorkItem,
        changed = true;
      if (request.action === 'create') {
        if (row) throw new Fault('WORK_ID_CONFLICT');
        if (Number(db.prepare('SELECT COUNT(*) AS count FROM work_items').get()!.count) >= capacity)
          throw new Fault('WORK_LIMIT');
        item = {
          ...request.value,
          title: request.value.title.trim(),
          id: request.item,
          revision: 1,
          deleted: false,
          createdAt: now,
          updatedAt: now,
          ...(request.value.status === 'done' ? { completedAt: now } : {}),
          createdBy: actor,
          updatedBy: actor,
        };
      } else {
        if (!row) throw new Fault('WORK_NOT_FOUND', 404);
        const current = this.item(row);
        // Stored discussion times must stay readable when the host clock moves backward.
        now = new Date(
          Math.max(Date.parse(now), Date.parse(current.updatedAt), Date.parse(current.createdAt)),
        ).toISOString();
        if (current.revision !== request.revision) throw new Fault('WORK_CONFLICT');
        if (request.action === 'update' && current.deleted) throw new Fault('WORK_TRASHED');
        item = {
          ...current,
          ...(request.action === 'update'
            ? request.value
            : { deleted: request.action === 'trash' }),
        };
        item.title = item.title.trim();
        changed = ['title', 'description', 'progress', 'status', 'deleted'].some(
          (key) => current[key as keyof WorkItem] !== item[key as keyof WorkItem],
        );
        if (changed) {
          item.revision++;
          item.updatedAt = now;
          item.updatedBy = actor;
          if (item.status === 'done')
            item.completedAt = current.status === 'done' ? current.completedAt : now;
          else delete item.completedAt;
        }
      }
      return this.transaction(() => {
        if (request.action === 'create')
          db.prepare(
            'INSERT INTO work_items(id,title,description,progress,status,revision,deleted,created,updated,completed,creator,editor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            item.id,
            item.title,
            item.description,
            item.progress,
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
              'UPDATE work_items SET title=?,description=?,progress=?,status=?,revision=?,deleted=?,updated=?,completed=?,editor=? WHERE id=? AND revision=?',
            )
            .run(
              item.title,
              item.description,
              item.progress,
              item.status,
              item.revision,
              Number(item.deleted),
              item.updatedAt,
              item.completedAt ?? null,
              JSON.stringify(item.updatedBy),
              item.id,
              request.revision,
            );
          if (Number(result.changes) !== 1) throw new Fault('WORK_CONFLICT');
        }
        db.prepare(
          'INSERT INTO work_operations(id,item,signature,revision,at) VALUES(?,?,?,?,?)',
        ).run(request.id, item.id, signature(request, actor), item.revision, now);
        if (
          changed &&
          Number(
            db.prepare('UPDATE work_meta SET revision=revision+1 WHERE id=1').run().changes,
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
      });
    }, signal);
  }
  private commentRow(row: Row): WorkComment {
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
      Number(row.seq) < 1 ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 2 ||
      typeof row.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.signature)
    )
      throw new Fault('WORK_CORRUPT');
    const request = {
      id: value.id,
      item: value.item,
      body: value.body,
      revision: Number(row.revision) - 1,
    };
    if (commentSignature(request, value.createdBy) !== row.signature)
      throw new Fault('WORK_CORRUPT');
    let item: WorkItem;
    try {
      item = this.find(value.item);
    } catch {
      throw new Fault('WORK_CORRUPT');
    }
    if (
      item.revision < Number(row.revision) ||
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
      row = db.prepare('SELECT * FROM work_comments WHERE id=?').get(request.id);
    if (!row) {
      if (db.prepare('SELECT 1 FROM work_operations WHERE id=?').get(request.id))
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
      acceptedRevision: Number(row.revision),
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
      return this.transaction(() => {
        const db = this.database();
        if (
          Number(
            db
              .prepare(
                'UPDATE work_items SET revision=?,updated=?,editor=? WHERE id=? AND revision=?',
              )
              .run(item.revision, now, JSON.stringify(actor), item.id, request.revision).changes,
          ) !== 1
        )
          throw new Fault('WORK_CONFLICT');
        db.prepare(
          'INSERT INTO work_comments(id,item,body,creator,signature,revision,at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          comment.id,
          comment.item,
          comment.body,
          JSON.stringify(actor),
          commentSignature(request, actor),
          item.revision,
          now,
        );
        if (
          Number(
            db
              .prepare('UPDATE work_meta SET revision=revision+1,comments=comments+1 WHERE id=1')
              .run().changes,
          ) !== 1
        )
          throw new Fault('WORK_CORRUPT');
        return result;
      });
    }, signal);
  }
  comments(input: unknown): Promise<WorkCommentPage> {
    if (!isWorkCommentQuery(input)) return Promise.reject(new Fault('INVALID_WORK_QUERY', 400));
    const query = structuredClone(input);
    return this.exclusive(() => {
      const item = this.find(query.item);
      this.commentAuthority();
      const values: (string | number)[] = [query.item];
      if (query.before !== undefined) values.push(query.before);
      const limit = query.limit ?? 50;
      const rows = this.database()
        .prepare(
          `SELECT * FROM work_comments WHERE item=? ${query.before === undefined ? '' : 'AND seq<?'} ORDER BY seq DESC LIMIT ?`,
        )
        .all(...values, limit + 1);
      const comments: WorkComment[] = [];
      let last: number | undefined;
      for (const row of rows.slice(0, limit)) {
        const next = this.commentRow(row);
        // One bounded response must fit the existing model projection budget even for fully escaped text.
        const projected = {
          item: item.id,
          revision: item.revision,
          comments: [...comments, next],
          nextBefore: Number(row.seq),
        };
        if (Buffer.byteLength(JSON.stringify(projected)) > 120 * 1024) break;
        comments.push(next);
        last = Number(row.seq);
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
    this.db?.close();
    this.db = undefined;
  }
}
