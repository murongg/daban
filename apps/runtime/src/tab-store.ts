import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publicUrl, validAgentId } from '@daban/protocol';
import { Fault } from './control.js';

export interface SavedTab {
  id: string;
  bot: string;
  url: string;
  title: string;
}
export interface TabRegistry {
  tabs: SavedTab[];
  active: Record<string, string>;
}
export interface TabReceipt {
  phase: 'claimed' | 'settled';
  error?: string;
  uncertain?: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export class TabStore {
  readonly ready: Promise<unknown>;
  private db?: DatabaseSync;
  private failed = false;
  private closed = false;
  constructor(
    readonly file: string,
    private readonly bots?: readonly string[],
  ) {
    this.ready = this.load().catch(() => {
      this.failed = true;
    });
  }
  private async load() {
    if (
      this.bots &&
      (!this.bots.length ||
        this.bots.length > 16 ||
        !this.bots.every(validAgentId) ||
        new Set(this.bots).size !== this.bots.length)
    )
      throw new Fault('INVALID_BROWSER_STATE');
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Fault('BROWSER_STATE_UNAVAILABLE');
    } finally {
      await handle.close();
    }
    this.db = new DatabaseSync(this.file);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name));
    if (
      ![0, 1].includes(version) ||
      (version === 0 && tables.length) ||
      tables.some(
        (name) =>
          !['browser_tabs', 'browser_active', 'browser_commands', 'browser_meta'].includes(name),
      )
    )
      throw new Fault('BROWSER_STATE_UNAVAILABLE');
    await chmod(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS browser_tabs(id TEXT PRIMARY KEY,bot TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,position INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS browser_active(bot TEXT PRIMARY KEY,tab TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS browser_commands(id TEXT PRIMARY KEY,bot TEXT NOT NULL,signature TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,uncertain INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS browser_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO browser_meta VALUES(1,0);PRAGMA user_version=1;`);
    this.registry();
  }
  private available() {
    if (!this.db || this.closed || this.failed) throw new Fault('BROWSER_STATE_UNAVAILABLE', 503);
    return this.db;
  }
  private owner(bot: unknown) {
    return validAgentId(bot) && (!this.bots || this.bots.includes(bot));
  }
  private validate(value: unknown): asserts value is TabRegistry {
    if (
      !object(value) ||
      Object.keys(value).some((key) => !['tabs', 'active'].includes(key)) ||
      !Array.isArray(value.tabs) ||
      value.tabs.length > (this.bots?.length ?? 2000) * 8 ||
      !object(value.active) ||
      Object.keys(value.active).length > (this.bots?.length ?? 2000) ||
      Object.keys(value.active).some((bot) => !this.owner(bot))
    )
      throw new Fault('INVALID_BROWSER_STATE', 400);
    const ids = new Set<string>();
    for (const tab of value.tabs) {
      if (
        !object(tab) ||
        Object.keys(tab).some((key) => !['id', 'bot', 'url', 'title'].includes(key)) ||
        !validAgentId(tab.id) ||
        ids.has(tab.id) ||
        typeof tab.bot !== 'string' ||
        !this.owner(tab.bot) ||
        (tab.url !== 'about:blank' && !publicUrl(tab.url)) ||
        typeof tab.title !== 'string' ||
        tab.title.length > 200 ||
        tab.title.includes('\0')
      )
        throw new Fault('INVALID_BROWSER_STATE', 400);
      ids.add(tab.id);
    }
    for (const bot of this.bots ??
      new Set([
        ...value.tabs.map((tab) => String((tab as Record<string, unknown>).bot)),
        ...Object.keys(value.active),
      ])) {
      const owned = value.tabs.filter((tab) => tab.bot === bot);
      if (
        !owned.length ||
        owned.length > 8 ||
        !owned.some((tab) => tab.id === (value.active as Record<string, unknown>)[bot])
      )
        throw new Fault('INVALID_BROWSER_STATE', 400);
    }
  }
  private registry(): TabRegistry | undefined {
    const db = this.available();
    const tabs = db
      .prepare('SELECT id,bot,url,title FROM browser_tabs ORDER BY bot,position LIMIT ?')
      .all((this.bots?.length ?? 2000) * 8 + 1)
      .map((row) => ({ ...row }));
    const active = db.prepare('SELECT bot,tab FROM browser_active').all();
    if (!tabs.length && !active.length) return;
    const value = {
      tabs,
      active: Object.fromEntries(active.map((row) => [String(row.bot), row.tab])),
    };
    this.validate(value);
    return value;
  }
  private transaction<T>(operation: () => T) {
    const db = this.available();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  private saveRows(state: TabRegistry) {
    const db = this.available();
    if (this.bots) db.exec('DELETE FROM browser_active;DELETE FROM browser_tabs;');
    else
      for (const bot of Object.keys(state.active)) {
        db.prepare('DELETE FROM browser_active WHERE bot=?').run(bot);
        db.prepare('DELETE FROM browser_tabs WHERE bot=?').run(bot);
      }
    const positions = new Map<string, number>();
    for (const tab of state.tabs) {
      const position = positions.get(tab.bot) || 0;
      positions.set(tab.bot, position + 1);
      db.prepare('INSERT INTO browser_tabs VALUES(?,?,?,?,?)').run(
        tab.id,
        tab.bot,
        tab.url,
        tab.title,
        position,
      );
    }
    for (const bot of this.bots ?? Object.keys(state.active))
      db.prepare('INSERT INTO browser_active VALUES(?,?)').run(bot, state.active[bot]);
    db.exec('UPDATE browser_meta SET revision=revision+1 WHERE id=1');
  }
  async read() {
    await this.ready;
    return this.registry();
  }
  async save(value: unknown) {
    await this.ready;
    this.validate(value);
    return this.transaction(() => this.saveRows(value));
  }
  async revision() {
    await this.ready;
    const value = Number(
      this.available().prepare('SELECT revision FROM browser_meta WHERE id=1').get()!.revision,
    );
    if (!Number.isSafeInteger(value) || value < 0) throw new Fault('BROWSER_STATE_UNAVAILABLE');
    return value;
  }
  async claim(id: string, bot: string, signature: string): Promise<'new' | 'claimed' | 'settled'> {
    await this.ready;
    if (!validAgentId(id) || !this.owner(bot) || !/^[a-f0-9]{64}$/.test(signature))
      throw new Fault('INVALID_BROWSER_REQUEST', 400);
    return this.transaction(() => {
      const db = this.available(),
        prior = db.prepare('SELECT * FROM browser_commands WHERE id=?').get(id);
      if (prior) {
        if (prior.bot !== bot || prior.signature !== signature)
          throw new Fault('BROWSER_REQUEST_ID_REUSED');
        if (!['claimed', 'settled'].includes(String(prior.phase)))
          throw new Fault('BROWSER_STATE_UNAVAILABLE');
        return prior.phase as 'claimed' | 'settled';
      }
      // Claim before any browser effect. A claimed record after restart is uncertain and must never be executed again.
      db.prepare(
        "INSERT INTO browser_commands(id,bot,signature,phase) VALUES(?,?,?,'claimed')",
      ).run(id, bot, signature);
      return 'new';
    });
  }
  async finish(id: string, bot: string, state: TabRegistry, error?: string, uncertain = false) {
    await this.ready;
    this.validate(state);
    if (error !== undefined && !/^[A-Z_]{1,80}$/.test(error))
      throw new Fault('INVALID_BROWSER_REQUEST', 400);
    return this.transaction(() => {
      const db = this.available(),
        prior = db.prepare('SELECT phase FROM browser_commands WHERE id=? AND bot=?').get(id, bot);
      if (!prior) throw new Fault('BROWSER_REQUEST_NOT_FOUND', 404);
      if (prior.phase === 'settled') return;
      if (prior.phase !== 'claimed') throw new Fault('BROWSER_STATE_UNAVAILABLE');
      this.saveRows(state);
      db.prepare(
        "UPDATE browser_commands SET phase='settled',error=?,uncertain=? WHERE id=? AND bot=?",
      ).run(error || null, uncertain ? 1 : 0, id, bot);
    });
  }
  async receipt(id: string, bot: string): Promise<TabReceipt | undefined> {
    await this.ready;
    if (!validAgentId(id) || !this.owner(bot)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    const row = this.available()
      .prepare('SELECT phase,error,uncertain FROM browser_commands WHERE id=? AND bot=?')
      .get(id, bot);
    if (!row) return;
    if (!['claimed', 'settled'].includes(String(row.phase)))
      throw new Fault('BROWSER_STATE_UNAVAILABLE');
    return {
      phase: row.phase as 'claimed' | 'settled',
      ...(row.error ? { error: String(row.error), uncertain: row.uncertain === 1 } : {}),
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready;
    this.db?.close();
  }
}
