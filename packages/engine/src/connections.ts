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
import { Fault } from './control.js';

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
  private db?: DatabaseSync;
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
    this.db = new DatabaseSync(this.options.file);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    if (
      ![0, 1].includes(version) ||
      (version === 0 && tables.length) ||
      tables.some((name) => !['computers', 'computer_commands', 'computer_meta'].includes(name))
    )
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    await chmod(this.options.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS computers(bot TEXT PRIMARY KEY,revision INTEGER NOT NULL,phase TEXT NOT NULL,desired INTEGER NOT NULL,slot INTEGER UNIQUE,instance TEXT,boot TEXT NOT NULL,error TEXT,recovery TEXT,updated TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS computer_commands(id TEXT PRIMARY KEY,bot TEXT NOT NULL,signature TEXT NOT NULL,action TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,uncertain INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS computer_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO computer_meta VALUES(1,0);PRAGMA user_version=1;`);
    this.refresh();
    const reserved = [...this.rows.values()].filter((row) => row.slot !== undefined);
    const claimed = this.db.prepare("SELECT id FROM computer_commands WHERE phase='claimed'").all();
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
        this.db!.prepare(
          "UPDATE computer_commands SET phase='interrupted',error='COMPUTER_OUTCOME_UNKNOWN',uncertain=1 WHERE phase='claimed'",
        ).run();
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
      values = db.prepare('SELECT * FROM computers').all();
    if (values.length > 2000) throw new Fault('COMPUTER_STORE_LIMIT', 503);
    const rows = values.map((row) => this.parse(row));
    const revision = Number(
      db.prepare('SELECT revision FROM computer_meta WHERE id=1').get()!.revision,
    );
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Fault('COMPUTER_STORE_UNAVAILABLE', 503);
    this.rows.clear();
    for (const row of rows) this.rows.set(row.bot, row);
    this.revision = revision;
  }
  private transaction<T>(action: () => T): T {
    const db = this.available();
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = action();
      db.prepare('UPDATE computer_meta SET revision=revision+1 WHERE id=1').run();
      db.exec('COMMIT');
      committed = true;
      // Publish cached ownership only after the durable transaction has committed.
      this.refresh();
      return result;
    } catch (error) {
      if (!committed) db.exec('ROLLBACK');
      if (committed || !(error instanceof Fault) || error.code === 'COMPUTER_STORE_UNAVAILABLE')
        this.failed = true;
      throw error;
    }
  }
  private write(input: Omit<Row, 'revision' | 'updatedAt'> & { revision: number }) {
    if (!Number.isSafeInteger(input.revision + 1)) throw new Fault('COMPUTER_STORE_LIMIT', 503);
    this.available()
      .prepare(
        `INSERT INTO computers VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot) DO UPDATE SET revision=excluded.revision,phase=excluded.phase,desired=excluded.desired,slot=excluded.slot,instance=excluded.instance,boot=excluded.boot,error=excluded.error,recovery=excluded.recovery,updated=excluded.updated`,
      )
      .run(
        input.bot,
        input.revision + 1,
        input.phase,
        input.desired ? 1 : 0,
        input.slot ?? null,
        input.instance ?? null,
        input.boot,
        input.error ?? null,
        input.recovery ?? null,
        new Date().toISOString(),
      );
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
    const prior = this.db!.prepare('SELECT * FROM computer_commands WHERE id=?').get(request.id);
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
      if (
        Number(this.db!.prepare('SELECT COUNT(*) AS count FROM computer_commands').get()!.count) >=
        10000
      )
        throw new Fault('COMPUTER_STORE_LIMIT', 503);
      // The runtime verifies registration and admission first; this durable claim must precede driver effects.
      this.db!.prepare(
        'INSERT INTO computer_commands(id,bot,signature,action,phase) VALUES(?,?,?,?,?)',
      ).run(request.id, request.bot, signature, request.action, noop ? 'settled' : 'claimed');
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
        this.db!.prepare("UPDATE computer_commands SET phase='settled' WHERE id=?").run(request.id);
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
      operation = db.prepare('SELECT * FROM computer_commands WHERE id=?').get(id);
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
      db.prepare("UPDATE computer_commands SET phase='settled',error=?,uncertain=? WHERE id=?").run(
        outcome.phase === 'failed' ? outcome.error : null,
        outcome.phase === 'failed' && outcome.reserved ? 1 : 0,
        id,
      );
    });
  }
  receipt(id: string, bot: string): ComputerReceipt {
    const db = this.available();
    if (!validAgentId(id) || !validAgentId(bot)) throw new Fault('INVALID_COMPUTER_REQUEST', 400);
    const row = db
      .prepare('SELECT phase,error,uncertain FROM computer_commands WHERE id=? AND bot=?')
      .get(id, bot);
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
    this.db?.close();
  }
}
