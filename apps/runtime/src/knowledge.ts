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
import { errorCode, Fault } from './control.js';

interface Cause {
  kind: 'user' | 'bot';
  runId?: string;
  signal?: AbortSignal;
}
type Row = Record<string, unknown>;
export class Knowledge {
  readonly ready: Promise<unknown>;
  private db!: DatabaseSync;
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
          this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS revision FROM revisions').get()!
            .revision,
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
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,bot TEXT NOT NULL,path TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(bot,path));
      CREATE TABLE IF NOT EXISTS revisions (document TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,content TEXT NOT NULL,bytes INTEGER NOT NULL,deleted INTEGER NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,run TEXT,PRIMARY KEY(document,revision));
      CREATE TABLE IF NOT EXISTS sources (document TEXT PRIMARY KEY,bot TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,UNIQUE(bot,name));
      CREATE TABLE IF NOT EXISTS knowledge_imports (bot TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS document_owner ON documents(bot,deleted,updated);`);
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
  private transaction<T>(action: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private row(bot: string, id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_KNOWLEDGE', 400);
    const row = this.db.prepare('SELECT * FROM documents WHERE id=? AND bot=?').get(id, bot);
    if (!row) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
    return row;
  }
  private document(row: Row, version?: Row): KnowledgeDocument {
    const source = this.db
      .prepare('SELECT name,bytes,sha256 FROM sources WHERE document=? AND bot=?')
      .get(row.id as string, row.bot as string);
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
    const prior = this.db.prepare('SELECT id FROM documents WHERE bot=? AND path=?').get(bot, name);
    if (prior && prior.id !== id) throw new Fault('KNOWLEDGE_PATH_EXISTS');
    const bytes = Buffer.byteLength(content),
      revision = current ? Number(current.revision) + 1 : 1,
      stamp = new Date().toISOString();
    const usage = this.db
      .prepare(
        'SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM documents WHERE bot=? AND deleted=0',
      )
      .get(bot)!;
    if (
      !deleted &&
      (Number(usage.count) - (current && current.deleted === 0 ? 1 : 0) >= 100 ||
        Number(usage.bytes) -
          (current && current.deleted === 0 ? Number(current.bytes) : 0) +
          bytes >
          20 * 1024 * 1024)
    )
      throw new Fault('KNOWLEDGE_LIMIT');
    // Current content and immutable revision history share this transaction; neither is a second authority.
    this.db
      .prepare(
        'INSERT INTO revisions(document,revision,path,content,bytes,deleted,at,actor,run) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        revision,
        name,
        content,
        bytes,
        deleted ? 1 : 0,
        stamp,
        cause.kind,
        cause.runId || null,
      );
    if (current)
      this.db
        .prepare(
          'UPDATE documents SET path=?,revision=?,content=?,bytes=?,deleted=?,updated=? WHERE id=? AND bot=?',
        )
        .run(name, revision, content, bytes, deleted ? 1 : 0, stamp, id, bot);
    else
      this.db
        .prepare(
          'INSERT INTO documents(id,bot,path,revision,content,bytes,deleted,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(id, bot, name, revision, content, bytes, deleted ? 1 : 0, stamp, stamp);
    return this.document(this.row(bot, id));
  }
  list(bot: string, includeDeleted = false) {
    return this.exclusive(bot, () =>
      this.db
        .prepare(
          'SELECT * FROM documents WHERE bot=? AND (?=1 OR deleted=0) ORDER BY updated DESC,path',
        )
        .all(bot, includeDeleted ? 1 : 0)
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
              .prepare('SELECT * FROM revisions WHERE document=? AND revision=?')
              .get(id, version);
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
        this.transaction(() => {
          const current = value.id
            ? this.row(bot, value.id)
            : this.db
                .prepare('SELECT * FROM documents WHERE bot=? AND path=?')
                .get(bot, value.path);
          if (
            current &&
            current.deleted === 0 &&
            current.path === value.path &&
            current.content === value.content
          )
            return this.document(current);
          if (!value.id && current) throw new Fault('KNOWLEDGE_PATH_EXISTS');
          if (current && current.revision !== value.revision) throw new Fault('KNOWLEDGE_CONFLICT');
          return this.commit(
            bot,
            value.id || randomUUID(),
            value.path,
            value.content,
            false,
            current,
            cause,
          );
        }),
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
        this.transaction(() => {
          const prior = this.db
            .prepare('SELECT * FROM sources WHERE bot=? AND name=?')
            .get(bot, name);
          if (prior) {
            const document = this.row(bot, String(prior.document));
            if (document.deleted === 0 && prior.sha256 === sha256) return this.document(document);
            throw new Fault('KNOWLEDGE_PATH_EXISTS');
          }
          const usage = this.db
            .prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM sources WHERE bot=?')
            .get(bot)!;
          if (Number(usage.bytes) + data.length > 50 * 1024 * 1024)
            throw new Fault('DOCUMENT_STORAGE_LIMIT');
          const id = randomUUID();
          // The original and first text revision commit together; edits/restores never replace the original.
          this.commit(bot, id, `${name}.txt`, content, false);
          this.db
            .prepare('INSERT INTO sources(document,bot,name,bytes,sha256,data) VALUES(?,?,?,?,?,?)')
            .run(id, bot, name, data.length, sha256, data);
          return this.document(this.row(bot, id));
        }),
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
      this.transaction(() => {
        const receipt = this.db
          .prepare('SELECT digest FROM knowledge_imports WHERE bot=?')
          .get(bot);
        if (receipt) {
          if (receipt.digest !== digest) throw new Fault('KNOWLEDGE_IMPORT_CONFLICT');
          return this.db
            .prepare('SELECT * FROM documents WHERE bot=? ORDER BY path')
            .all(bot)
            .map((row) => this.document(row));
        }
        if (this.db.prepare('SELECT id FROM documents WHERE bot=? LIMIT 1').get(bot))
          throw new Fault('KNOWLEDGE_IMPORT_CONFLICT');
        const documents = values.map((value) => {
          const id = randomUUID();
          this.commit(bot, id, value.path, value.content, false);
          if (value.original) {
            const data = Buffer.from(value.original.data, 'base64');
            this.db
              .prepare(
                'INSERT INTO sources(document,bot,name,bytes,sha256,data) VALUES(?,?,?,?,?,?)',
              )
              .run(
                id,
                bot,
                value.original.name,
                data.length,
                createHash('sha256').update(data).digest('hex'),
                data,
              );
          }
          return this.document(this.row(bot, id));
        });
        // The ownership receipt and every original/text row are one commit, so retry never resets later edits.
        this.db.prepare('INSERT INTO knowledge_imports(bot,digest) VALUES(?,?)').run(bot, digest);
        return documents;
      }),
    );
  }
  source(bot: string, id: string): Promise<DocumentOriginal> {
    return this.exclusive(bot, () => {
      this.row(bot, id);
      const source = this.db
        .prepare('SELECT name,data,bytes,sha256 FROM sources WHERE document=? AND bot=?')
        .get(id, bot);
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
        this.transaction(() => {
          const row = this.row(bot, id);
          if (row.revision !== revision || row.deleted === 1) throw new Fault('KNOWLEDGE_CONFLICT');
          const content = this.document(row).content,
            index = oldText ? content.indexOf(oldText) : content.length;
          if (index < 0) throw new Fault('KNOWLEDGE_EDIT_MISMATCH');
          if (oldText && content.indexOf(oldText, index + 1) >= 0)
            throw new Fault('KNOWLEDGE_EDIT_AMBIGUOUS');
          const next = content.slice(0, index) + newText + content.slice(index + oldText.length);
          if (!isKnowledgeContent(next)) throw new Fault('INVALID_KNOWLEDGE', 400);
          if (next === content) return this.document(row);
          return this.commit(bot, id, String(row.path), next, false, row, cause);
        }),
      cause,
    );
  }
  remove(bot: string, id: string, revision: number, cause?: Cause) {
    if (!this.revision(revision)) return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(
      bot,
      () =>
        this.transaction(() => {
          const row = this.row(bot, id);
          if (row.deleted === 1) return this.document(row);
          if (row.revision !== revision) throw new Fault('KNOWLEDGE_CONFLICT');
          return this.commit(bot, id, String(row.path), '', true, row, cause);
        }),
      cause,
    );
  }
  versions(bot: string, id: string, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    if (!this.revision(before) || !this.revision(limit) || limit > 20)
      return Promise.reject(new Fault('INVALID_KNOWLEDGE', 400));
    return this.exclusive(bot, () => {
      this.row(bot, id);
      return this.db
        .prepare(
          'SELECT * FROM revisions WHERE document=? AND revision<? ORDER BY revision DESC LIMIT ?',
        )
        .all(id, before, limit)
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
        this.transaction(() => {
          const row = this.row(bot, id);
          if (row.revision !== revision) throw new Fault('KNOWLEDGE_CONFLICT');
          const old = this.db
            .prepare('SELECT * FROM revisions WHERE document=? AND revision=? AND deleted=0')
            .get(id, target);
          if (!old) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
          const document = this.document(row, old);
          return this.commit(bot, id, document.path, document.content, false, row, cause);
        }),
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
        .prepare('SELECT * FROM documents WHERE bot=? AND deleted=0 ORDER BY updated DESC,path')
        .all(bot)
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
    this.db?.close();
  }
}
