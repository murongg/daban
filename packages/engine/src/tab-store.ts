import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publicUrl, validAgentId } from '@daban/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { Fault } from './control.js';
import { configure, type Database, migrate, tables, unwrap } from './database.js';
import { migrations } from './tab-store-migrations.js';
import { browserActive, browserCommands, browserMeta, browserTabs } from './tab-store-schema.js';

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
const names = ['browser_active', 'browser_commands', 'browser_meta', 'browser_tabs'];

// Pre-ORM files: version 1 may hold any subset of the four tables; the old bootstrap completes it.
function legacy(client: DatabaseSync) {
  const version = Number(client.prepare('PRAGMA user_version').get()!.user_version);
  if (version !== 1 || tables(client).some((name) => !names.includes(name)))
    throw new Fault('BROWSER_STATE_UNAVAILABLE');
  client.exec(`CREATE TABLE IF NOT EXISTS browser_tabs(id TEXT PRIMARY KEY,bot TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,position INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS browser_active(bot TEXT PRIMARY KEY,tab TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS browser_commands(id TEXT PRIMARY KEY,bot TEXT NOT NULL,signature TEXT NOT NULL,phase TEXT NOT NULL,error TEXT,uncertain INTEGER) STRICT;
    CREATE TABLE IF NOT EXISTS browser_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;`);
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export class TabStore {
  readonly ready: Promise<unknown>;
  private db?: Database;
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
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { synchronous: 'FULL', busyTimeout: 1000 });
      // Refused files are checked before chmod and WAL so they are retained unchanged.
      this.db = migrate(client, migrations, legacy);
    } catch (error) {
      client.close();
      throw error;
    }
    if (JSON.stringify(tables(this.db)) !== JSON.stringify(names))
      throw new Fault('BROWSER_STATE_UNAVAILABLE');
    await chmod(this.file, 0o600);
    configure(client, { journal: 'WAL' });
    this.db.insert(browserMeta).values({ id: 1, revision: 0 }).onConflictDoNothing().run();
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
      .select({
        id: browserTabs.id,
        bot: browserTabs.bot,
        url: browserTabs.url,
        title: browserTabs.title,
      })
      .from(browserTabs)
      .orderBy(browserTabs.bot, browserTabs.position)
      .limit((this.bots?.length ?? 2000) * 8 + 1)
      .all();
    const active = db
      .select({ bot: browserActive.bot, tab: browserActive.tab })
      .from(browserActive)
      .all();
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
    try {
      // Boxing keeps the generic result distinguishable from a Promise for Drizzle's sync typing.
      return db.transaction(() => ({ result: operation() }), { behavior: 'immediate' }).result;
    } catch (error) {
      throw unwrap(error);
    }
  }
  private saveRows(state: TabRegistry) {
    const db = this.available();
    if (this.bots) {
      db.delete(browserActive).run();
      db.delete(browserTabs).run();
    } else
      for (const bot of Object.keys(state.active)) {
        db.delete(browserActive).where(eq(browserActive.bot, bot)).run();
        db.delete(browserTabs).where(eq(browserTabs.bot, bot)).run();
      }
    const positions = new Map<string, number>();
    for (const tab of state.tabs) {
      const position = positions.get(tab.bot) || 0;
      positions.set(tab.bot, position + 1);
      db.insert(browserTabs)
        .values({ id: tab.id, bot: tab.bot, url: tab.url, title: tab.title, position })
        .run();
    }
    for (const bot of this.bots ?? Object.keys(state.active))
      db.insert(browserActive).values({ bot, tab: state.active[bot] }).run();
    db.update(browserMeta)
      .set({ revision: sql`${browserMeta.revision} + 1` })
      .where(eq(browserMeta.id, 1))
      .run();
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
      this.available()
        .select({ revision: browserMeta.revision })
        .from(browserMeta)
        .where(eq(browserMeta.id, 1))
        .get()!.revision,
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
        prior = db.select().from(browserCommands).where(eq(browserCommands.id, id)).get();
      if (prior) {
        if (prior.bot !== bot || prior.signature !== signature)
          throw new Fault('BROWSER_REQUEST_ID_REUSED');
        if (!['claimed', 'settled'].includes(String(prior.phase)))
          throw new Fault('BROWSER_STATE_UNAVAILABLE');
        return prior.phase as 'claimed' | 'settled';
      }
      // Claim before any browser effect. A claimed record after restart is uncertain and must never be executed again.
      db.insert(browserCommands).values({ id, bot, signature, phase: 'claimed' }).run();
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
        prior = db
          .select({ phase: browserCommands.phase })
          .from(browserCommands)
          .where(and(eq(browserCommands.id, id), eq(browserCommands.bot, bot)))
          .get();
      if (!prior) throw new Fault('BROWSER_REQUEST_NOT_FOUND', 404);
      if (prior.phase === 'settled') return;
      if (prior.phase !== 'claimed') throw new Fault('BROWSER_STATE_UNAVAILABLE');
      this.saveRows(state);
      db.update(browserCommands)
        .set({ phase: 'settled', error: error || null, uncertain: uncertain ? 1 : 0 })
        .where(and(eq(browserCommands.id, id), eq(browserCommands.bot, bot)))
        .run();
    });
  }
  async receipt(id: string, bot: string): Promise<TabReceipt | undefined> {
    await this.ready;
    if (!validAgentId(id) || !this.owner(bot)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    const row = this.available()
      .select({
        phase: browserCommands.phase,
        error: browserCommands.error,
        uncertain: browserCommands.uncertain,
      })
      .from(browserCommands)
      .where(and(eq(browserCommands.id, id), eq(browserCommands.bot, bot)))
      .get();
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
    this.db?.$client.close();
  }
}
