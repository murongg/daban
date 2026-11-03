import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AttachmentEntry,
  type AttachmentPage,
  type AttachmentPurge,
  type AttachmentQuery,
  type AttachmentReceipt,
  type AttachmentRef,
  type DocumentOriginal,
  type DocumentUpload,
  imageMime,
  isAttachmentEntry,
  isAttachmentId,
  isAttachmentQuery,
  isAttachmentReceipt,
  isAttachmentRef,
  isAttachmentUpload,
  isAttachmentVersion,
  isKnowledgeContent,
  isTaskFileName,
  validAgentId,
} from '@daban/protocol';
import { and, eq, getColumns, gt, isNull, sql, sum } from 'drizzle-orm';
import { migrations } from './attachments-migrations.js';
import { purges, uploads } from './attachments-schema.js';
import { errorCode, Fault } from './control.js';
import { checkpoint, configure, type Database, migrate, unwrap } from './database.js';
import { imageInput } from './images.js';

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
// Raw projection keeps a mistyped (non-BLOB) value visible to the corruption check instead of failing in the Buffer codec.
const fields = { ...getColumns(uploads), data: sql<unknown>`${uploads.data}` };
// Drizzle has no byte-length function; CAST to BLOB measures UTF-8 bytes rather than characters.
const textBytes = sql<number>`length(CAST(${uploads.content} AS BLOB))`;

// Pre-ORM files may predate the purge receipts and the deleted, version and previous columns.
function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS uploads (bot TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB NOT NULL,content TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,version TEXT,previous TEXT,PRIMARY KEY(bot,id));
    CREATE TABLE IF NOT EXISTS purges (bot TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,confirmation TEXT NOT NULL,PRIMARY KEY(bot,id,version));`);
  const columns = new Set(
    client
      .prepare('PRAGMA table_info(uploads)')
      .all()
      .map((row) => row.name),
  );
  for (const [name, definition] of [
    ['deleted', 'INTEGER NOT NULL DEFAULT 0'],
    ['version', 'TEXT'],
    ['previous', 'TEXT'],
  ])
    if (!columns.has(name)) client.exec(`ALTER TABLE uploads ADD COLUMN ${name} ${definition}`);
}
export class Attachments {
  readonly ready: Promise<unknown>;
  private db!: Database;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  async status() {
    try {
      await this.ready;
      if (this.closed) return { available: false };
      this.db.select({ bot: uploads.bot }).from(uploads).limit(1).get();
      return { available: true };
    } catch {
      return { available: false };
    }
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const prior = await lstat(this.file).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      return undefined;
    });
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1))
      throw new Fault('ATTACHMENT_CORRUPT');
    if (!prior) await (await open(this.file, 'wx', 0o600)).close();
    await chmod(this.file, 0o600);
    const client = new DatabaseSync(this.file);
    try {
      configure(client, {
        journal: 'WAL',
        synchronous: 'FULL',
        busyTimeout: 5000,
        secureDelete: true,
      });
      this.db = migrate(client, migrations, legacy);
    } catch (error) {
      client.close();
      throw error;
    }
    this.transaction(() => {
      const unversioned = this.db
        .select({ bot: uploads.bot, id: uploads.id })
        .from(uploads)
        .where(isNull(uploads.version))
        .all();
      for (const row of unversioned)
        this.db
          .update(uploads)
          .set({ version: randomUUID() })
          .where(and(eq(uploads.bot, row.bot), eq(uploads.id, row.id), isNull(uploads.version)))
          .run();
    });
  }
  private exclusive<T>(bot: string, action: () => T, signal?: AbortSignal): Promise<T> {
    if (!validAgentId(bot)) return Promise.reject(new Fault('INVALID_ATTACHMENT', 400));
    const pending = this.chain.then(async () => {
      await this.ready;
      if (this.closed) throw new Fault('ATTACHMENT_UNAVAILABLE', 503);
      signal?.throwIfAborted();
      return action();
    });
    this.chain = pending.catch(() => {});
    return pending;
  }
  private row(bot: string, id: string) {
    if (!isAttachmentId(id)) throw new Fault('INVALID_ATTACHMENT', 400);
    const row = this.find(bot, id);
    if (!row) throw new Fault('ATTACHMENT_NOT_FOUND', 404);
    return row;
  }
  private find(bot: string, id: string) {
    return this.db
      .select(fields)
      .from(uploads)
      .where(and(eq(uploads.bot, bot), eq(uploads.id, id)))
      .get();
  }
  private usage(bot: string) {
    const usage = this.db
      .select({ bytes: sum(uploads.bytes), text: sum(textBytes) })
      .from(uploads)
      .where(eq(uploads.bot, bot))
      .get()!;
    return { bytes: Number(usage.bytes ?? 0), text: Number(usage.text ?? 0) };
  }
  private transaction<T>(action: () => T) {
    try {
      // Boxing keeps the generic result distinguishable from a Promise for Drizzle's sync typing.
      return this.db.transaction(() => ({ result: action() }), { behavior: 'immediate' }).result;
    } catch (error) {
      throw unwrap(error);
    }
  }
  private entry(row: Record<string, unknown>): AttachmentEntry {
    if (row.deleted !== 0 && row.deleted !== 1) throw new Fault('ATTACHMENT_CORRUPT');
    const entry: unknown = {
      ...this.ref(row),
      version: row.version,
      deleted: row.deleted === 1,
      textSize: row.textBytes ?? Buffer.byteLength(String(row.content || '')),
    };
    if (!isAttachmentEntry(entry)) throw new Fault('ATTACHMENT_CORRUPT');
    return entry;
  }
  private available(row: Record<string, unknown>) {
    if (row.deleted === 1) throw new Fault('ATTACHMENT_TRASHED');
    if (row.deleted !== 0) throw new Fault('ATTACHMENT_CORRUPT');
    return row;
  }
  private ref(row: Record<string, unknown>): AttachmentRef {
    const ref: unknown = {
      id: row.id,
      bot: row.bot,
      name: row.name,
      size: row.bytes,
      sha256: row.sha256,
    };
    if (!isAttachmentRef(ref) || ref.id !== digest(`${ref.name}\0${ref.sha256}`))
      throw new Fault('ATTACHMENT_CORRUPT');
    return ref;
  }
  private receipt(row: Record<string, unknown>): AttachmentReceipt {
    const receipt: unknown = { ...this.ref(row), content: row.content };
    if (!isAttachmentReceipt(receipt)) throw new Fault('ATTACHMENT_CORRUPT');
    return receipt;
  }
  private materialize(row: Record<string, unknown>) {
    const receipt = this.receipt(row);
    if (
      !(row.data instanceof Uint8Array) ||
      row.data.length !== receipt.size ||
      digest(row.data) !== receipt.sha256
    )
      throw new Fault('ATTACHMENT_CORRUPT');
    return { receipt, data: Buffer.from(row.data) };
  }
  async upload(
    bot: string,
    file: DocumentUpload,
    extract: (file: DocumentUpload, signal?: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
  ) {
    if (!isAttachmentUpload(file) || !isTaskFileName(file.name))
      throw new Fault('INVALID_ATTACHMENT', 400);
    const input = structuredClone(file),
      data = Buffer.from(input.data, 'base64');
    if (data.toString('base64') !== input.data) throw new Fault('INVALID_ATTACHMENT', 400);
    const sha256 = digest(data),
      id = digest(`${input.name}\0${sha256}`);
    const prior = await this.exclusive(bot, () => this.find(bot, id), signal);
    if (prior) return this.materialize(this.available(prior)).receipt;
    const image = imageMime(input.name) ? imageInput(input) : undefined;
    const content = image
      ? `图片附件：${image.mimeType}，${image.width} × ${image.height}。原件保留；${image.mimeType === 'image/gif' || image.mimeType === 'image/webp' ? '模型按静态首帧读取，不代表理解完整动画。' : '发送时提供原始图片。'}本说明不是 OCR 或图片内容。`
      : await extract(input, signal);
    if (!isKnowledgeContent(content)) throw new Fault('DOCUMENT_LIMIT', 413);
    if (!content.trim()) throw new Fault('DOCUMENT_EMPTY', 400);
    return this.exclusive(
      bot,
      () =>
        this.transaction(() => {
          const current = this.find(bot, id);
          if (current) return this.materialize(this.available(current)).receipt;
          const usage = this.usage(bot);
          if (
            usage.bytes + data.length > 50 * 1024 * 1024 ||
            usage.text + Buffer.byteLength(content) > 20 * 1024 * 1024
          )
            throw new Fault('ATTACHMENT_STORAGE_LIMIT');
          // Immutable original and extracted text are one record; task retries keep this source outside writable workspaces.
          this.db
            .insert(uploads)
            .values({
              bot,
              id,
              name: input.name,
              bytes: data.length,
              sha256,
              data,
              content,
              version: randomUUID(),
            })
            .run();
          return this.materialize(this.row(bot, id)).receipt;
        }),
      signal,
    );
  }
  read(bot: string, id: string) {
    return this.exclusive(bot, () => this.materialize(this.available(this.row(bot, id))));
  }
  async source(bot: string, id: string): Promise<DocumentOriginal> {
    const { receipt, data } = await this.exclusive(bot, () => this.materialize(this.row(bot, id)));
    return {
      id,
      bot,
      file: { name: receipt.name, data: data.toString('base64') },
      sha256: receipt.sha256,
    };
  }
  list(bot: string, query: AttachmentQuery): Promise<AttachmentPage> {
    if (!isAttachmentQuery(query)) return Promise.reject(new Fault('INVALID_ATTACHMENT', 400));
    const input = structuredClone(query);
    return this.exclusive(bot, () => {
      const usage = this.usage(bot);
      const rows = this.db
        .select({
          bot: uploads.bot,
          id: uploads.id,
          name: uploads.name,
          bytes: uploads.bytes,
          sha256: uploads.sha256,
          version: uploads.version,
          deleted: uploads.deleted,
          textBytes,
        })
        .from(uploads)
        .where(
          and(
            eq(uploads.bot, bot),
            eq(uploads.deleted, input.trash ? 1 : 0),
            gt(uploads.id, input.before || ''),
          ),
        )
        .orderBy(uploads.id)
        .all();
      const items = rows
        .filter((row) =>
          String(row.name)
            .toLowerCase()
            .includes((input.query || '').toLowerCase()),
        )
        .slice(0, 51)
        .map((row) => this.entry(row));
      return {
        items: items.slice(0, 50),
        originalBytes: usage.bytes,
        textBytes: usage.text,
        ...(items.length > 50 ? { next: items[49].id } : {}),
      };
    });
  }
  private change(bot: string, id: string, version: string, deleted: boolean) {
    if (!isAttachmentVersion(version)) return Promise.reject(new Fault('INVALID_ATTACHMENT', 400));
    return this.exclusive(bot, () =>
      this.transaction(() => {
        const row = this.row(bot, id),
          entry = this.entry(row);
        if (row.version !== version) {
          if (entry.deleted === deleted && row.previous === version) return entry;
          throw new Fault('ATTACHMENT_CONFLICT');
        }
        if (entry.deleted === deleted) return entry;
        this.db
          .update(uploads)
          .set({ deleted: deleted ? 1 : 0, version: randomUUID(), previous: version })
          .where(and(eq(uploads.bot, bot), eq(uploads.id, id)))
          .run();
        return this.entry(this.row(bot, id));
      }),
    );
  }
  trash(bot: string, id: string, version: string) {
    return this.change(bot, id, version, true);
  }
  restore(bot: string, id: string, version: string) {
    return this.change(bot, id, version, false);
  }
  purge(bot: string, id: string, version: string, confirmation: string): Promise<AttachmentPurge> {
    if (!isAttachmentId(id) || !isAttachmentVersion(version) || !isTaskFileName(confirmation))
      return Promise.reject(new Fault('INVALID_ATTACHMENT', 400));
    return this.exclusive(bot, () => {
      this.transaction(() => {
        const row = this.find(bot, id);
        if (!row) {
          const prior = this.db
            .select({ confirmation: purges.confirmation })
            .from(purges)
            .where(and(eq(purges.bot, bot), eq(purges.id, id), eq(purges.version, version)))
            .get();
          if (!prior) throw new Fault('ATTACHMENT_NOT_FOUND', 404);
          if (prior.confirmation !== digest(confirmation))
            throw new Fault('ATTACHMENT_CONFIRMATION', 400);
          return;
        }
        if (row.version !== version) throw new Fault('ATTACHMENT_CONFLICT');
        if (row.deleted !== 1) throw new Fault('ATTACHMENT_NOT_TRASHED');
        if (row.name !== confirmation) throw new Fault('ATTACHMENT_CONFIRMATION', 400);
        // The scoped receipt and byte removal share a transaction; a fresh upload has a different mutation version.
        this.db
          .insert(purges)
          .values({ bot, id, version, confirmation: digest(confirmation) })
          .run();
        this.db
          .delete(uploads)
          .where(and(eq(uploads.bot, bot), eq(uploads.id, id)))
          .run();
      });
      let checkpointed = false;
      try {
        checkpointed = checkpoint(this.db);
      } catch {}
      return { bot, id, version, purged: true, checkpointed };
    });
  }
  async close() {
    await this.chain;
    await this.ready.catch(() => {});
    if (this.closed) return;
    this.closed = true;
    this.db?.$client.close();
  }
}
