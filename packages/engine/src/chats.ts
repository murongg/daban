import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ChatAck,
  type ChatReceipt,
  type ChatState,
  type ChatStatus,
  isChatAck,
  isChatRequest,
  isChatState,
  validAgentId,
} from '@daban/protocol';
import { asc, count, eq, sql } from 'drizzle-orm';
import { migrations } from './chats-migrations.js';
import { chatMeta, chatReceipts, chats } from './chats-schema.js';
import { Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';

function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS chats(bot TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_receipts(id TEXT PRIMARY KEY,bot TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);`);
}

export class Chats {
  readonly ready: Promise<unknown>;
  private db!: Database;
  private failure = false;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly file: string,
    readonly admit: (bot: string) => undefined,
  ) {
    this.ready = this.load();
    this.ready.catch(() => {
      this.failure = true;
    });
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Fault('CHAT_UNAVAILABLE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { journal: 'WAL' });
      this.db = migrate(client, migrations, legacy);
      this.db.insert(chatMeta).values({ id: 1, revision: 0 }).onConflictDoNothing().run();
    } catch (error) {
      client.close();
      throw error;
    }
  }
  private usable() {
    if (this.closed || this.failure || !this.db) throw new Fault('CHAT_UNAVAILABLE', 503);
  }
  current(bot: string): ChatState {
    this.usable();
    if (!validAgentId(bot)) throw new Fault('INVALID_CHAT_REQUEST', 400);
    const row = this.db.select({ value: chats.value }).from(chats).where(eq(chats.bot, bot)).get();
    if (!row) return { bot, revision: 0 };
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      throw new Fault('CHAT_CORRUPT');
    }
    if (!isChatState(value) || value.bot !== bot) throw new Fault('CHAT_CORRUPT');
    return value;
  }
  assertCurrent(bot: string, revision: number | undefined) {
    const current = this.current(bot);
    if (revision === undefined && current.revision) throw new Fault('CHAT_REVISION_REQUIRED');
    if ((revision ?? 0) !== current.revision) throw new Fault('CHAT_CONFLICT');
    return current.revision;
  }
  private record(id: string): ChatReceipt | undefined {
    const row = this.db
      .select({ bot: chatReceipts.bot, value: chatReceipts.value })
      .from(chatReceipts)
      .where(eq(chatReceipts.id, id))
      .get();
    if (!row) return;
    let receipt: unknown;
    try {
      receipt = JSON.parse(row.value);
    } catch {
      throw new Fault('CHAT_CORRUPT');
    }
    const ack = { chat: this.current(row.bot), receipt };
    if (!isChatAck(ack) || ack.receipt.request.id !== id) throw new Fault('CHAT_CORRUPT');
    return ack.receipt;
  }
  private exclusive<T>(operation: () => T): Promise<T> {
    const next = this.chain
      .catch(() => {})
      .then(async () => {
        await this.ready;
        this.usable();
        return operation();
      });
    this.chain = next;
    return next;
  }
  renew(input: unknown): Promise<ChatAck> {
    if (!isChatRequest(input)) return Promise.reject(new Fault('INVALID_CHAT_REQUEST', 400));
    const request = { id: input.id, bot: input.bot, revision: input.revision };
    return this.exclusive(() =>
      this.db.transaction(
        (tx) => {
          const prior = this.record(request.id);
          if (prior) {
            if (JSON.stringify(prior.request) !== JSON.stringify(request))
              throw new Fault('CHAT_REQUEST_ID_REUSED');
            return { chat: this.current(request.bot), receipt: prior };
          }
          this.assertCurrent(request.bot, request.revision);
          // Admission and the boundary commit are synchronous: a new job cannot slip between them.
          this.admit(request.bot);
          if (tx.select({ n: count() }).from(chatReceipts).get()!.n >= 10000)
            throw new Fault('CHAT_LIMIT');
          const completedAt = new Date().toISOString();
          const chat: ChatState = {
            bot: request.bot,
            revision: request.revision + 1,
            updatedAt: completedAt,
          };
          const receipt: ChatReceipt = { request, revision: chat.revision, completedAt };
          tx.insert(chats)
            .values({ bot: chat.bot, value: JSON.stringify(chat) })
            .onConflictDoUpdate({ target: chats.bot, set: { value: sql`excluded.value` } })
            .run();
          tx.insert(chatReceipts)
            .values({ id: request.id, bot: request.bot, value: JSON.stringify(receipt) })
            .run();
          tx.update(chatMeta)
            .set({ revision: sql`${chatMeta.revision} + 1` })
            .where(eq(chatMeta.id, 1))
            .run();
          return { chat, receipt };
        },
        { behavior: 'immediate' },
      ),
    );
  }
  receipt(bot: string, id: string): Promise<ChatAck> {
    if (!validAgentId(bot) || !validAgentId(id))
      return Promise.reject(new Fault('INVALID_CHAT_REQUEST', 400));
    return this.exclusive(() => {
      const receipt = this.record(id);
      if (!receipt || receipt.request.bot !== bot) throw new Fault('CHAT_RECEIPT_NOT_FOUND', 404);
      return { chat: this.current(bot), receipt };
    });
  }
  async status(): Promise<ChatStatus> {
    try {
      return await this.exclusive(() => ({
        available: true,
        revision: this.db.select({ revision: chatMeta.revision }).from(chatMeta).get()!.revision,
        items: this.db
          .select({ bot: chats.bot })
          .from(chats)
          .orderBy(asc(chats.bot))
          .all()
          .map((row) => this.current(row.bot)),
      }));
    } catch {
      return { available: false, revision: 0, items: [], error: 'CHAT_UNAVAILABLE' };
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.chain.catch(() => {});
    await this.ready.catch(() => {});
    this.db?.$client.close();
  }
}
