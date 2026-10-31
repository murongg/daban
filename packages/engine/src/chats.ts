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
import { Fault } from './control.js';

export class Chats {
  readonly ready: Promise<unknown>;
  private db!: DatabaseSync;
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
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS chats(bot TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_receipts(id TEXT PRIMARY KEY,bot TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO chat_meta VALUES(1,0);`);
  }
  private usable() {
    if (this.closed || this.failure || !this.db) throw new Fault('CHAT_UNAVAILABLE', 503);
  }
  current(bot: string): ChatState {
    this.usable();
    if (!validAgentId(bot)) throw new Fault('INVALID_CHAT_REQUEST', 400);
    const row = this.db.prepare('SELECT value FROM chats WHERE bot=?').get(bot);
    if (!row) return { bot, revision: 0 };
    let value: unknown;
    try {
      value = JSON.parse(String(row.value));
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
    const row = this.db.prepare('SELECT bot,value FROM chat_receipts WHERE id=?').get(id);
    if (!row) return;
    let receipt: unknown;
    try {
      receipt = JSON.parse(String(row.value));
    } catch {
      throw new Fault('CHAT_CORRUPT');
    }
    const ack = { chat: this.current(String(row.bot)), receipt };
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
    return this.exclusive(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const prior = this.record(request.id);
        if (prior) {
          if (JSON.stringify(prior.request) !== JSON.stringify(request))
            throw new Fault('CHAT_REQUEST_ID_REUSED');
          this.db.exec('COMMIT');
          return { chat: this.current(request.bot), receipt: prior };
        }
        this.assertCurrent(request.bot, request.revision);
        // Admission and the boundary commit are synchronous: a new job cannot slip between them.
        this.admit(request.bot);
        if (Number(this.db.prepare('SELECT count(*) AS n FROM chat_receipts').get()!.n) >= 10000)
          throw new Fault('CHAT_LIMIT');
        const completedAt = new Date().toISOString();
        const chat: ChatState = {
          bot: request.bot,
          revision: request.revision + 1,
          updatedAt: completedAt,
        };
        const receipt: ChatReceipt = { request, revision: chat.revision, completedAt };
        this.db
          .prepare(
            'INSERT INTO chats VALUES(?,?) ON CONFLICT(bot) DO UPDATE SET value=excluded.value',
          )
          .run(chat.bot, JSON.stringify(chat));
        this.db
          .prepare('INSERT INTO chat_receipts VALUES(?,?,?)')
          .run(request.id, request.bot, JSON.stringify(receipt));
        this.db.exec('UPDATE chat_meta SET revision=revision+1 WHERE id=1');
        this.db.exec('COMMIT');
        return { chat, receipt };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
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
        revision: Number(this.db.prepare('SELECT revision FROM chat_meta').get()!.revision),
        items: this.db
          .prepare('SELECT bot FROM chats ORDER BY bot')
          .all()
          .map((row) => this.current(String(row.bot))),
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
    this.db?.close();
  }
}
