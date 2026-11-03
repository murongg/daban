import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ComputerPhase,
  type ComputerReceipt,
  type ComputerRequest,
  type ComputerState,
  type ComputerStatus,
  validAgentId,
} from '@daban/protocol';
import { and, count, eq, sql } from 'drizzle-orm';
import { migrations } from './connections-migrations.js';
import { computerCommands, computerMeta, computers } from './connections-schema.js';
import { Fault } from './control.js';
import { configure, type Database, migrate, tables, unwrap } from './database.js';

interface Row {
  bot: string;
  revision: number;
  phase: ComputerPhase;
  desired: boolean;
  slot?: number;
  instance?: string;
  boot: string;
  error?: string;
  recovery?: 'stop' | 'restart';
  updatedAt: string;
}
type Outcome =
  | { phase: 'connected'; instance: string }
  | { phase: 'disconnected' }
  | {
      phase: 'failed';
      error: string;
      reserved: boolean;
      recovery?: 'stop' | 'restart';
      instance?: string;
    };
const phases: readonly ComputerPhase[] = [
  'disconnected',
  'connecting',
  'connected',
  'stopping',
  'suspended',
  'failed',
  'interrupted',
];
const code = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value);
const names = ['computer_commands', 'computer_meta', 'computers'];

// Pre-ORM files: version 1 may hold any subset of the three tables; the old bootstrap completes it.
function legacy(client: DatabaseSync) {
  const version = Number(client.prepare('PRAGMA user_version').get()!.user_version);
  if (version !== 1 || tables(client).some((name) => !names.includes(name)))
    throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
  client.exec(`CREATE TABLE IF NOT EXISTS computers(bot TEXT PRIMARY KEY,revision INTEGER NOT NULL,phase TEXT NOT NULL,desired INTEGER NOT NULL,slot INTEGER UNIQUE,instance TEXT,boot TEXT NOT NULL,error TEXT,recovery TEXT,updated TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS computer_commands(id TEXT PRIMARY KEY,bot TEXT NOT NULL,signature TEXT NOT NULL,action TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,uncertain INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS computer_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;`);
}
const blank = (bot: string): ComputerState => ({
  bot,
  revision: 0,
  phase: 'disconnected',
  desired: false,
  reserved: false,
});

export class Connections {
  // shortcut: one runtime owns a data root; add a process lease before supporting multiple servers for that root.
  readonly ready: Promise<unknown>;
  private db?: Database;
  private failed = false;
  private closed = false;
  private revision = 0;
  private readonly rows = new Map<string, Row>();
  constructor(readonly options: { file: string; limit: number; boot: string }) {
    this.ready = this.load().catch(() => {
      this.failed = true;
    });
  }
  private available() {
    if (!this.db || this.failed || this.closed) throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    return this.db;
  }
  private async load() {
    if (
      !Number.isSafeInteger(this.options.limit) ||
      this.options.limit < 1 ||
      this.options.limit > 16 ||
      !validAgentId(this.options.boot)
    )
      throw new Fault('INVALID_COMPUTER_CONFIG', 400);
    await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.options.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.options.file);
    try {
      configure(client, { synchronous: 'FULL', busyTimeout: 1000 });
      // Refused files are checked before chmod and WAL so they are retained unchanged.
      this.db = migrate(client, migrations, legacy);
    } catch (error) {
      client.close();
      throw error;
    }
    const db = this.db;
    if (JSON.stringify(tables(db)) !== JSON.stringify(names))
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    await chmod(this.options.file, 0o600);
    configure(client, { journal: 'WAL' });
    db.insert(computerMeta).values({ id: 1, revision: 0 }).onConflictDoNothing().run();
    this.refresh();
    const reserved = [...this.rows.values()].filter((row) => row.slot !== undefined);
    const claimed = db
      .select({ id: computerCommands.id })
      .from(computerCommands)
      .where(eq(computerCommands.phase, 'claimed'))
      .all();
    if (reserved.length || claimed.length)
      this.transaction(() => {
        for (const old of reserved) {
          const rebooted = old.boot !== this.options.boot;
          this.write({
            ...old,
            phase: rebooted ? (old.desired ? 'suspended' : 'disconnected') : 'interrupted',
            slot: rebooted ? undefined : old.slot,
            instance: rebooted ? undefined : old.instance,
            error: 'COMPUTER_OUTCOME_UNKNOWN',
            recovery: rebooted ? undefined : 'restart',
          });
        }
        // A new process cannot prove old effects were absent; even a reboot must not replay the old operation.
        db.update(computerCommands)
          .set({ phase: 'interrupted', error: 'COMPUTER_OUTCOME_UNKNOWN', uncertain: 1 })
          .where(eq(computerCommands.phase, 'claimed'))
          .run();
      });
  }
  private parse(raw: Record<string, unknown>): Row {
    const revision = Number(raw.revision),
      slot = raw.slot == null ? undefined : Number(raw.slot);
    if (
      !validAgentId(raw.bot) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !phases.includes(raw.phase as ComputerPhase) ||
      ![0, 1].includes(Number(raw.desired)) ||
      (slot !== undefined && (!Number.isSafeInteger(slot) || slot < 0 || slot > 15)) ||
      (raw.instance != null && !validAgentId(raw.instance)) ||
      !validAgentId(raw.boot) ||
      (raw.error != null && !code(raw.error)) ||
      (raw.recovery != null && !['stop', 'restart'].includes(String(raw.recovery))) ||
      typeof raw.updated !== 'string' ||
      !Number.isFinite(Date.parse(raw.updated))
    )
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    const row: Row = {
      bot: raw.bot,
      revision,
      phase: raw.phase as ComputerPhase,
      desired: raw.desired === 1,
      slot,
      instance: raw.instance == null ? undefined : String(raw.instance),
      boot: raw.boot,
      error: raw.error == null ? undefined : String(raw.error),
      recovery: raw.recovery == null ? undefined : (raw.recovery as Row['recovery']),
      updatedAt: raw.updated,
    };
    if (
      (row.phase === 'connected' && (!row.desired || row.slot === undefined || !row.instance)) ||
      (['disconnected', 'suspended'].includes(row.phase) &&
        (row.slot !== undefined || row.instance !== undefined)) ||
      (row.phase === 'disconnected' && row.desired) ||
      (row.phase === 'suspended' && !row.desired) ||
      (['connecting', 'stopping'].includes(row.phase) && row.slot === undefined)
    )
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    return row;
  }
  private refresh() {
    const db = this.available(),
      values = db.select().from(computers).all();
    if (values.length > 2000) throw new Fault('COMPUTER_STORE_LIMIT', 503);
    const rows = values.map((row) => this.parse(row));
    const revision = Number(
      db
        .select({ revision: computerMeta.revision })
        .from(computerMeta)
        .where(eq(computerMeta.id, 1))
        .get()!.revision,
    );
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    this.rows.clear();
    for (const row of rows) this.rows.set(row.bot, row);
    this.revision = revision;
  }
  private transaction<T>(action: () => T): T {
    const db = this.available();
    let committed = false;
    try {
      // Boxing keeps the generic result distinguishable from a Promise for Drizzle's sync typing.
      const { result } = db.transaction(
        () => {
          const value = action();
          db.update(computerMeta)
            .set({ revision: sql`${computerMeta.revision} + 1` })
            .where(eq(computerMeta.id, 1))
            .run();
          return { result: value };
        },
        { behavior: 'immediate' },
      );
      committed = true;
      // Publish cached ownership only after the durable transaction has committed.
      this.refresh();
      return result;
    } catch (error) {
      if (committed || !(error instanceof Fault) || error.code === 'COMPUTER_STORE_UNAVAILABLE')
        this.failed = true;
      throw unwrap(error);
    }
  }
  private write(input: Omit<Row, 'revision' | 'updatedAt'> & { revision: number }) {
    if (!Number.isSafeInteger(input.revision + 1)) throw new Fault('COMPUTER_STORE_LIMIT', 503);
    this.available()
      .insert(computers)
      .values({
        bot: input.bot,
        revision: input.revision + 1,
        phase: input.phase,
        desired: input.desired ? 1 : 0,
        slot: input.slot ?? null,
        instance: input.instance ?? null,
        boot: input.boot,
        error: input.error ?? null,
        recovery: input.recovery ?? null,
        updated: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: computers.bot,
        set: {
          revision: sql`excluded.revision`,
          phase: sql`excluded.phase`,
          desired: sql`excluded.desired`,
          slot: sql`excluded.slot`,
          instance: sql`excluded.instance`,
          boot: sql`excluded.boot`,
          error: sql`excluded.error`,
          recovery: sql`excluded.recovery`,
          updated: sql`excluded.updated`,
        },
      })
      .run();
  }
  private public(row: Row): ComputerState {
    return {
      bot: row.bot,
      revision: row.revision,
      phase: row.phase,
      desired: row.desired,
      reserved: row.slot !== undefined,
      ...(row.instance ? { instance: row.instance } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.recovery ? { recovery: row.recovery } : {}),
      updatedAt: row.updatedAt,
    };
  }
  snapshot(): ComputerStatus {
    return {
      available: !!this.db && !this.failed && !this.closed,
      limit: this.options.limit,
      revision: this.revision,
      items:
        this.failed || this.closed ? [] : [...this.rows.values()].map((row) => this.public(row)),
      ...(this.failed || this.closed ? { error: 'COMPUTER_STORE_UNAVAILABLE' } : {}),
    };
  }
  get(bot: string): ComputerState {
    this.available();
    if (!validAgentId(bot)) throw new Fault('INVALID_COMPUTER_REQUEST', 400);
    const row = this.rows.get(bot);
    return row ? this.public(row) : blank(bot);
  }
  private validate(request: ComputerRequest) {
    if (
      !request ||
      typeof request !== 'object' ||
      Object.keys(request).some(
        (key) => !['id', 'bot', 'action', 'revision', 'instance', 'confirmation'].includes(key),
      ) ||
      !validAgentId(request.id) ||
      !validAgentId(request.bot) ||
      !['connect', 'stop'].includes(request.action) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0 ||
      (request.instance !== undefined && !validAgentId(request.instance)) ||
      (request.action === 'connect' &&
        (request.instance !== undefined || request.confirmation !== undefined))
    )
      throw new Fault('INVALID_COMPUTER_REQUEST', 400);
    if (request.action === 'stop' && request.confirmation !== 'close-apps')
      throw new Fault('COMPUTER_CONFIRM_REQUIRED', 400);
  }
  claim(request: ComputerRequest): {
    fresh: boolean;
    state: ComputerState;
    receipt: ComputerReceipt;
    slot?: number;
  } {
    this.available();
    this.validate(request);
    const signature = createHash('sha256')
      .update(
        JSON.stringify([
          request.bot,
          request.action,
          request.revision,
          request.instance ?? null,
          request.confirmation ?? null,
        ]),
      )
      .digest('hex');
    const prior = this.db!.select()
      .from(computerCommands)
      .where(eq(computerCommands.id, request.id))
      .get();
    if (prior) {
      if (prior.bot !== request.bot || prior.signature !== signature)
        throw new Fault('COMPUTER_REQUEST_ID_REUSED');
      return {
        fresh: false,
        state: this.get(request.bot),
        receipt: this.receipt(request.id, request.bot),
      };
    }
    const current = this.get(request.bot),
      old = this.rows.get(request.bot);
    if (current.revision !== request.revision) throw new Fault('COMPUTER_CONFLICT');
    if (['connecting', 'stopping'].includes(current.phase)) throw new Fault('COMPUTER_BUSY');
    if (request.action === 'stop' && current.instance !== request.instance)
      throw new Fault('DESKTOP_VIEW_STALE');
    const noop =
      request.action === 'connect'
        ? current.phase === 'connected'
        : !current.reserved && !current.desired;
    let slot = old?.slot;
    if (request.action === 'connect' && !noop) {
      if (slot !== undefined) throw new Fault('COMPUTER_STOP_REQUIRED');
      const used = new Set(
        [...this.rows.values()].flatMap((row) => (row.slot === undefined ? [] : [row.slot])),
      );
      if (used.size >= this.options.limit) throw new Fault('COMPUTER_CAPACITY');
      slot = Array.from({ length: this.options.limit }, (_, index) => index).find(
        (value) => !used.has(value),
      );
    }
    this.transaction(() => {
      if (this.db!.select({ count: count() }).from(computerCommands).get()!.count >= 10000)
        throw new Fault('COMPUTER_STORE_LIMIT', 503);
      // The runtime verifies registration and admission first; this durable claim must precede driver effects.
      this.db!.insert(computerCommands)
        .values({
          id: request.id,
          bot: request.bot,
          signature,
          action: request.action,
          phase: noop ? 'settled' : 'claimed',
        })
        .run();
      if (!noop)
        this.write({
          bot: request.bot,
          revision: current.revision,
          phase:
            request.action === 'connect'
              ? 'connecting'
              : current.reserved
                ? 'stopping'
                : 'disconnected',
          desired: request.action === 'connect',
          slot,
          instance: old?.instance,
          boot: this.options.boot,
          error: undefined,
          recovery: undefined,
        });
      if (!noop && request.action === 'stop' && !current.reserved)
        this.db!.update(computerCommands)
          .set({ phase: 'settled' })
          .where(eq(computerCommands.id, request.id))
          .run();
    });
    const receipt = this.receipt(request.id, request.bot);
    return {
      fresh: receipt.phase === 'claimed',
      state: this.get(request.bot),
      receipt,
      ...(slot === undefined ? {} : { slot }),
    };
  }
  finish(id: string, outcome: Outcome) {
    const db = this.available(),
      operation = db.select().from(computerCommands).where(eq(computerCommands.id, id)).get();
    if (!operation) throw new Fault('COMPUTER_REQUEST_NOT_FOUND', 404);
    if (operation.phase === 'settled') return;
    if (operation.phase !== 'claimed') throw new Fault('COMPUTER_OUTCOME_UNKNOWN');
    const row = this.rows.get(String(operation.bot));
    if (
      !row ||
      !['connecting', 'stopping'].includes(row.phase) ||
      (outcome.phase === 'connected' &&
        (operation.action !== 'connect' || !validAgentId(outcome.instance))) ||
      (outcome.phase === 'disconnected' && operation.action !== 'stop') ||
      (outcome.phase === 'failed' &&
        (!code(outcome.error) ||
          (outcome.reserved && row.slot === undefined) ||
          (outcome.instance !== undefined && !validAgentId(outcome.instance)) ||
          (outcome.recovery !== undefined && !['stop', 'restart'].includes(outcome.recovery))))
    )
      throw new Fault('INVALID_COMPUTER_STATE', 400);
    this.transaction(() => {
      this.write({
        ...row,
        phase: outcome.phase,
        slot:
          outcome.phase === 'connected' || (outcome.phase === 'failed' && outcome.reserved)
            ? row.slot
            : undefined,
        instance:
          outcome.phase === 'connected'
            ? outcome.instance
            : outcome.phase === 'failed' && outcome.reserved
              ? (outcome.instance ?? row.instance)
              : undefined,
        desired: outcome.phase === 'disconnected' ? false : row.desired,
        error: outcome.phase === 'failed' ? outcome.error : undefined,
        recovery: outcome.phase === 'failed' && outcome.reserved ? outcome.recovery : undefined,
      });
      db.update(computerCommands)
        .set({
          phase: 'settled',
          error: outcome.phase === 'failed' ? outcome.error : null,
          uncertain: outcome.phase === 'failed' && outcome.reserved ? 1 : 0,
        })
        .where(eq(computerCommands.id, id))
        .run();
    });
  }
  receipt(id: string, bot: string): ComputerReceipt {
    const db = this.available();
    if (!validAgentId(id) || !validAgentId(bot)) throw new Fault('INVALID_COMPUTER_REQUEST', 400);
    const row = db
      .select({
        phase: computerCommands.phase,
        error: computerCommands.error,
        uncertain: computerCommands.uncertain,
      })
      .from(computerCommands)
      .where(and(eq(computerCommands.id, id), eq(computerCommands.bot, bot)))
      .get();
    if (!row) return { id, bot, phase: 'unknown' };
    if (
      !['claimed', 'settled', 'interrupted'].includes(String(row.phase)) ||
      (row.error != null && !code(row.error)) ||
      ![0, 1].includes(Number(row.uncertain))
    )
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    return {
      id,
      bot,
      phase: row.phase as ComputerReceipt['phase'],
      ...(row.error ? { error: String(row.error) } : {}),
      ...(row.uncertain === 1 ? { uncertain: true } : {}),
    };
  }
  suspend(bot: string) {
    this.available();
    const row = this.rows.get(bot);
    if (!row || row.slot === undefined) return;
    if (['connecting', 'stopping'].includes(row.phase)) throw new Fault('COMPUTER_BUSY');
    // Only the owner calls this after confirmed teardown; closing an app window does not suspend a computer.
    this.transaction(() =>
      this.write({
        ...row,
        phase: row.desired ? 'suspended' : 'disconnected',
        slot: undefined,
        instance: undefined,
        error: undefined,
        recovery: undefined,
      }),
    );
  }
  async close() {
    if (this.closed) return;
    await this.ready;
    this.closed = true;
    this.db?.$client.close();
  }
}
