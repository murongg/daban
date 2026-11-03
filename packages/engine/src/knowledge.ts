import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BotBundle,
  type DocumentOriginal,
  type DocumentUpload,
  isBotBundle,
  isDocumentOriginal,
  isDocumentUpload,
  isKnowledgeContent,
  isKnowledgeDocument,
  isKnowledgeWrite,
  type KnowledgeDocument,
  type KnowledgeFile,
  type KnowledgeVersion,
  validAgentId,
} from '@daban/protocol';
import { and, asc, count, desc, eq, lt, max, sql, sum } from 'drizzle-orm';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { migrations } from './knowledge-migrations.js';
import { documents, knowledgeImports, revisions, sources } from './knowledge-schema.js';

interface Cause {
  kind: 'user' | 'bot';
  runId?: string;
  signal?: AbortSignal;
}
type Row = typeof documents.$inferSelect;
type Version = typeof revisions.$inferSelect;

function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,bot TEXT NOT NULL,path TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(bot,path));
    CREATE TABLE IF NOT EXISTS revisions (document TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,run TEXT,PRIMARY KEY(document,revision));
    CREATE TABLE IF NOT EXISTS sources (document TEXT PRIMARY KEY,bot TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,UNIQUE(bot,name));
    CREATE TABLE IF NOT EXISTS knowledge_imports (bot TEXT PRIMARY KEY,digest TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS document_owner ON documents(bot,deleted,updated);`);
}
export class Knowledge {
  readonly ready: Promise<unknown>;
  private db!: Database;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  async status(): Promise<{ available: boolean; revision?: number; error?: string }> {
    try {
      await this.ready;
      if (this.closed) return { available: false, error: 'KNOWLEDGE_UNAVAILABLE' };
      return {
        available: true,
        revision: Number(
          // revisions has no single-column key; its implicit rowid is the global commit order.
          this.db
            .select({ revision: max(sql`rowid`) })
            .from(revisions)
            .get()!.revision ?? 0,
        ),
      };
    } catch {
      return { available: false, error: 'KNOWLEDGE_UNAVAILABLE' };
    }
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const existing = await lstat(this.file).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
      throw new Fault('KNOWLEDGE_CORRUPT');
    if (!existing) await (await open(this.file, 'wx', 0o600)).close();
    await chmod(this.file, 0o600);
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.db = migrate(client, migrations, legacy);
    } catch (error) {
      client.close();
      if (
        error instanceof Error &&
        ['DATABASE_NEWER', 'DATABASE_UNVERSIONED'].includes(error.message)
      )
        throw new Fault('KNOWLEDGE_CORRUPT');
      throw error;
    }
  }
  private exclusive<T>(bot: string, action: () => T | Promise<T>, cause?: Cause): Promise<T> {
    if (!validAgentId(bot)) return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    const pending = this.chain.then(async () => {
      await this.ready;
      if (this.closed) throw new Fault('KNOWLEDGE_CLOSED');
      cause?.signal?.throwIfAborted();
      return action();
    });
    this.chain = pending.catch(() => {});
    return pending;
  }
  private row(bot: string, id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_KNOWLEDGE', 400);
    const row = this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.bot, bot)))
      .get();
    if (!row) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
    return row;
  }
  private document(row: Row, version?: Version): KnowledgeDocument {
    const source = this.db
      .select({ name: sources.name, bytes: sources.bytes, sha256: sources.sha256 })
      .from(sources)
      .where(and(eq(sources.document, row.id), eq(sources.bot, row.bot)))
      .get();
    const value: unknown = {
      id: row.id,
      bot: row.bot,
      path: version?.path ?? row.path,
      revision: version?.revision ?? row.revision,
      content: version?.content ?? row.content,
      size: version?.bytes ?? row.bytes,
      deleted: (version?.deleted ?? row.deleted) === 1,
      createdAt: row.created,
      updatedAt: version?.at ?? row.updated,
      ...(source
        ? { source: { name: source.name, size: source.bytes, sha256: source.sha256 } }
        : {}),
    };
    if (!isKnowledgeDocument(value)) throw new Fault('KNOWLEDGE_CORRUPT');
    return value;
  }
  private meta(document: KnowledgeDocument): KnowledgeFile {
    const { content: _content, ...file } = document;
    return file;
  }
  private revision(value: unknown, zero = false): value is number {
    return Number.isSafeInteger(value) && Number(value) >= (zero ? 0 : 1);
  }
  private commit(
    bot: string,
    id: string,
    name: string,
    content: string,
    deleted: boolean,
    current?: Row,
    cause: Cause = { kind: 'user' },
  ) {
    if (
      (cause.kind !== 'user' && cause.kind !== 'bot') ||
      (cause.runId !== undefined && !validAgentId(cause.runId))
    )
      throw new Fault('INVALID_KNOWLEDGE', 400);
    const prior = this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.bot, bot), eq(documents.path, name)))
      .get();
    if (prior && prior.id !== id) throw new Fault('KNOWLEDGE_PATH_EXISTS');
    const bytes = Buffer.byteLength(content),
      revision = current ? Number(current.revision) + 1 : 1,
      stamp = new Date().toISOString();
    const usage = this.db
      .select({ count: count(), bytes: sum(documents.bytes) })
      .from(documents)
      .where(and(eq(documents.bot, bot), eq(documents.deleted, 0)))
      .get()!;
    if (
      !deleted &&
      (Number(usage.count) - (current && current.deleted === 0 ? 1 : 0) >= 100 ||
        Number(usage.bytes ?? 0) -
          (current && current.deleted === 0 ? Number(current.bytes) : 0) +
          bytes >
          20 * 1024 * 1024)
    )
      throw new Fault('KNOWLEDGE_LIMIT');
    // Current content and immutable revision history share this transaction; neither is a second authority.
    this.db
      .insert(revisions)
      .values({
        document: id,
        revision,
        path: name,
        content,
        bytes,
        deleted: deleted ? 1 : 0,
        at: stamp,
        actor: cause.kind,
        run: cause.runId || null,
      })
      .run();
    if (current)
      this.db
        .update(documents)
        .set({ path: name, revision, content, bytes, deleted: deleted ? 1 : 0, updated: stamp })
        .where(and(eq(documents.id, id), eq(documents.bot, bot)))
        .run();
    else
      this.db
        .insert(documents)
        .values({
          id,
          bot,
          path: name,
          revision,
          content,
          bytes,
          deleted: deleted ? 1 : 0,
          created: stamp,
          updated: stamp,
        })
        .run();
    return this.document(this.row(bot, id));
  }
  list(bot: string, includeDeleted = false) {
    return this.exclusive(bot, () =>
      this.db
        .select()
        .from(documents)
        .where(and(eq(documents.bot, bot), includeDeleted ? undefined : eq(documents.deleted, 0)))
        .orderBy(desc(documents.updated), asc(documents.path))
        .all()
        .map((row) => this.meta(this.document(row))),
    );
  }
  read(bot: string, id: string, version?: number) {
    if (version !== undefined && !this.revision(version))
      return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(bot, () => {
      const row = this.row(bot, id);
      const previous =
        version === undefined
          ? undefined
          : this.db
              .select()
              .from(revisions)
              .where(and(eq(revisions.document, id), eq(revisions.revision, version)))
              .get();
      if (version !== undefined && !previous) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
      return this.document(row, previous);
    });
  }
  write(bot: string, input: unknown, cause?: Cause) {
    if (!isKnowledgeWrite(input)) return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    const value = structuredClone(input);
    return this.exclusive(
      bot,
      () =>
        this.db.transaction(
          () => {
            const current = value.id
              ? this.row(bot, value.id)
              : this.db
                  .select()
                  .from(documents)
                  .where(and(eq(documents.bot, bot), eq(documents.path, value.path)))
                  .get();
            if (
              current &&
              current.deleted === 0 &&
              current.path === value.path &&
              current.content === value.content
            )
              return this.document(current);
            if (!value.id && current) throw new Fault('KNOWLEDGE_PATH_EXISTS');
            if (current && current.revision !== value.revision)
              throw new Fault('KNOWLEDGE_CONFLICT');
            return this.commit(
              bot,
              value.id || randomUUID(),
              value.path,
              value.content,
              false,
              current,
              cause,
            );
          },
          { behavior: 'immediate' },
        ),
      cause,
    );
  }
  importDocument(bot: string, input: DocumentUpload, content: string, signal?: AbortSignal) {
    if (!isDocumentUpload(input) || !isKnowledgeContent(content))
      return Promise.reject(new Fault('INVALID_DOCUMENT', 400));
    if (!content.trim()) return Promise.reject(new Fault('DOCUMENT_EMPTY', 400));
    const data = Buffer.from(input.data, 'base64'),
      name = input.name;
    if (data.toString('base64') !== input.data)
      return Promise.reject(new Fault('INVALID_DOCUMENT', 400));
    const sha256 = createHash('sha256').update(data).digest('hex');
    return this.exclusive(
      bot,
      () =>
        this.db.transaction(
          () => {
            const prior = this.db
              .select({ document: sources.document, sha256: sources.sha256 })
              .from(sources)
              .where(and(eq(sources.bot, bot), eq(sources.name, name)))
              .get();
            if (prior) {
              const document = this.row(bot, String(prior.document));
              if (document.deleted === 0 && prior.sha256 === sha256) return this.document(document);
              throw new Fault('KNOWLEDGE_PATH_EXISTS');
            }
            const usage = this.db
              .select({ bytes: sum(sources.bytes) })
              .from(sources)
              .where(eq(sources.bot, bot))
              .get()!;
            if (Number(usage.bytes ?? 0) + data.length > 50 * 1024 * 1024)
              throw new Fault('DOCUMENT_STORAGE_LIMIT');
            const id = randomUUID();
            // The original and first text revision commit together; edits/restores never replace the original.
            this.commit(bot, id, `${name}.txt`, content, false);
            this.db
              .insert(sources)
              .values({ document: id, bot, name, bytes: data.length, sha256, data })
              .run();
            return this.document(this.row(bot, id));
          },
          { behavior: 'immediate' },
        ),
      { kind: 'user', signal },
    );
  }
  importBundle(bot: string, digest: string, input: BotBundle['knowledge']) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !isBotBundle({
        format: 'daban.bot',
        version: 1,
        profile: { name: 'Import validation', instructions: '', color: 'violet' },
        preferences: '',
        skills: [],
        knowledge: input,
      })
    )
      return Promise.reject(new Fault('INVALID_BOT_IMPORT', 400));
    const values = structuredClone(input);
    for (const document of values) {
      if (
        document.original &&
        Buffer.from(document.original.data, 'base64').toString('base64') !== document.original.data
      )
        return Promise.reject(new Fault('INVALID_DOCUMENT', 400));
    }
    return this.exclusive(bot, () =>
      this.db.transaction(
        () => {
          const receipt = this.db
            .select({ digest: knowledgeImports.digest })
            .from(knowledgeImports)
            .where(eq(knowledgeImports.bot, bot))
            .get();
          if (receipt) {
            if (receipt.digest !== digest) throw new Fault('KNOWLEDGE_IMPORT_CONFLICT');
            return this.db
              .select()
              .from(documents)
              .where(eq(documents.bot, bot))
              .orderBy(asc(documents.path))
              .all()
              .map((row) => this.document(row));
          }
          if (
            this.db
              .select({ id: documents.id })
              .from(documents)
              .where(eq(documents.bot, bot))
              .limit(1)
              .get()
          )
            throw new Fault('KNOWLEDGE_IMPORT_CONFLICT');
          const copied = values.map((value) => {
            const id = randomUUID();
            this.commit(bot, id, value.path, value.content, false);
            if (value.original) {
              const data = Buffer.from(value.original.data, 'base64');
              this.db
                .insert(sources)
                .values({
                  document: id,
                  bot,
                  name: value.original.name,
                  bytes: data.length,
                  sha256: createHash('sha256').update(data).digest('hex'),
                  data,
                })
                .run();
            }
            return this.document(this.row(bot, id));
          });
          // The ownership receipt and every original/text row are one commit, so retry never resets later edits.
          this.db.insert(knowledgeImports).values({ bot, digest }).run();
          return copied;
        },
        { behavior: 'immediate' },
      ),
    );
  }
  source(bot: string, id: string): Promise<DocumentOriginal> {
    return this.exclusive(bot, () => {
      this.row(bot, id);
      const source = this.db
        .select({
          name: sources.name,
          // Read the stored value without the Buffer codec so a non-BLOB value reaches the check below.
          data: sql<unknown>`${sources.data}`,
          bytes: sources.bytes,
          sha256: sources.sha256,
        })
        .from(sources)
        .where(and(eq(sources.document, id), eq(sources.bot, bot)))
        .get();
      if (!source) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
      if (
        !(source.data instanceof Uint8Array) ||
        source.data.length !== source.bytes ||
        createHash('sha256').update(source.data).digest('hex') !== source.sha256
      )
        throw new Fault('KNOWLEDGE_CORRUPT');
      const original = {
        id,
        bot,
        file: { name: String(source.name), data: Buffer.from(source.data).toString('base64') },
        sha256: String(source.sha256),
      };
      if (!isDocumentOriginal(original)) throw new Fault('KNOWLEDGE_CORRUPT');
      return original;
    });
  }
  edit(bot: string, id: string, revision: number, oldText: string, newText: string, cause?: Cause) {
    if (
      !this.revision(revision) ||
      typeof oldText !== 'string' ||
      typeof newText !== 'string' ||
      oldText.length > 20000 ||
      newText.length > 20000 ||
      oldText.includes('\0') ||
      newText.includes('\0')
    )
      return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(
      bot,
      () =>
        this.db.transaction(
          () => {
            const row = this.row(bot, id);
            if (row.revision !== revision || row.deleted === 1)
              throw new Fault('KNOWLEDGE_CONFLICT');
            const content = this.document(row).content,
              index = oldText ? content.indexOf(oldText) : content.length;
            if (index < 0) throw new Fault('KNOWLEDGE_EDIT_MISMATCH');
            if (oldText && content.indexOf(oldText, index + 1) >= 0)
              throw new Fault('KNOWLEDGE_EDIT_AMBIGUOUS');
            const next = content.slice(0, index) + newText + content.slice(index + oldText.length);
            if (!isKnowledgeContent(next)) throw new Fault('INVALID_KNOWLEDGE', 400);
            if (next === content) return this.document(row);
            return this.commit(bot, id, String(row.path), next, false, row, cause);
          },
          { behavior: 'immediate' },
        ),
      cause,
    );
  }
  remove(bot: string, id: string, revision: number, cause?: Cause) {
    if (!this.revision(revision)) return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(
      bot,
      () =>
        this.db.transaction(
          () => {
            const row = this.row(bot, id);
            if (row.deleted === 1) return this.document(row);
            if (row.revision !== revision) throw new Fault('KNOWLEDGE_CONFLICT');
            return this.commit(bot, id, String(row.path), '', true, row, cause);
          },
          { behavior: 'immediate' },
        ),
      cause,
    );
  }
  versions(bot: string, id: string, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    if (!this.revision(before) || !this.revision(limit) || limit > 20)
      return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(bot, () => {
      this.row(bot, id);
      return this.db
        .select()
        .from(revisions)
        .where(and(eq(revisions.document, id), lt(revisions.revision, before)))
        .orderBy(desc(revisions.revision))
        .limit(limit)
        .all()
        .map(
          (row): KnowledgeVersion => ({
            revision: Number(row.revision),
            path: String(row.path),
            size: Number(row.bytes),
            deleted: row.deleted === 1,
            at: String(row.at),
            actor: row.actor as 'user' | 'bot',
            ...(row.run ? { runId: String(row.run) } : {}),
          }),
        );
    });
  }
  restore(bot: string, id: string, revision: number, target: number, cause?: Cause) {
    if (!this.revision(revision) || !this.revision(target))
      return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(
      bot,
      () =>
        this.db.transaction(
          () => {
            const row = this.row(bot, id);
            if (row.revision !== revision) throw new Fault('KNOWLEDGE_CONFLICT');
            const old = this.db
              .select()
              .from(revisions)
              .where(
                and(
                  eq(revisions.document, id),
                  eq(revisions.revision, target),
                  eq(revisions.deleted, 0),
                ),
              )
              .get();
            if (!old) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
            const document = this.document(row, old);
            return this.commit(bot, id, document.path, document.content, false, row, cause);
          },
          { behavior: 'immediate' },
        ),
      cause,
    );
  }
  search(bot: string, query: string, limit = 100) {
    if (
      typeof query !== 'string' ||
      query.length > 200 ||
      query.includes('\0') ||
      !this.revision(limit) ||
      limit > 100
    )
      return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(bot, () =>
      this.db
        .select()
        .from(documents)
        .where(and(eq(documents.bot, bot), eq(documents.deleted, 0)))
        .orderBy(desc(documents.updated), asc(documents.path))
        .all()
        .map((row) => this.document(row))
        .filter((document) =>
          `${document.path}\n${document.content}`.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, limit)
        .map((document) => this.meta(document)),
    );
  }
  async close() {
    await this.chain;
    await this.ready.catch(() => {});
    if (this.closed) return;
    this.closed = true;
    this.db?.$client.close();
  }
}
