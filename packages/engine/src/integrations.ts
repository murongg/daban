import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isMcpReceipt,
  type McpBindingInput,
  type McpConnection,
  type McpReceipt,
  type McpSave,
  validAgentId,
} from '@daban/protocol';
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { Fault } from './control.js';
import { configure, type Database, migrate, tables } from './database.js';
import { migrations } from './integrations-migrations.js';
import {
  callReceipts,
  configCommands,
  integrationBindings,
  integrationMeta,
  integrations,
} from './integrations-schema.js';
import { canonicalJson, type McpTool, mcpCatalog, mcpDigest } from './mcp-catalog.js';
import { publicAddress } from './network.js';

export type { McpBindingInput, McpConnection, McpSave } from '@daban/protocol';
export interface McpCapture {
  connection: string;
  revision: number;
  bindingRevision: number;
  catalogDigest: string;
  name: string;
  origin: string;
  tools: McpTool[];
}
export interface McpSnapshot {
  available: boolean;
  key: string;
  connections: McpCapture[];
  warnings: string[];
}
export interface McpClaim {
  id: string;
  bot: string;
  run: string;
  session: string;
  connection: string;
  configRevision: number;
  tool: string;
  arguments: Record<string, unknown>;
  preview: string;
}
export type McpOutcome = {
  phase: 'settled' | 'denied' | 'cancelled' | 'unknown';
  result?: string;
  error?: string;
};
type Row = Record<string, unknown>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown, zero = false) =>
  Number.isSafeInteger(value) &&
  Number(value) >= (zero ? 0 : 1) &&
  Number(value) < Number.MAX_SAFE_INTEGER - 1;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const code = (value: unknown) =>
  value === undefined || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value));
function endpoint(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) throw new Fault('INVALID_MCP_CONFIG', 400);
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (isIP(host) && !publicAddress(host))
    )
      throw new Error('invalid endpoint');
    return url.href;
  } catch {
    throw new Fault('INVALID_MCP_CONFIG', 400);
  }
}
export function mcpSecrets(config: { endpoint: string; bearer?: string }) {
  const url = new URL(config.endpoint);
  return [
    ...new Set(
      [
        config.endpoint,
        ...url.searchParams.values(),
        ...url.pathname.split('/').filter((value) => value.length >= 8),
        config.bearer ?? '',
      ].filter(Boolean),
    ),
  ];
}
const storeTables =
  'call_receipts,config_commands,integration_bindings,integration_meta,integrations';
const legacyColumns = [
  'id',
  'revision',
  'name',
  'name_key',
  'endpoint',
  'bearer',
  'deleted',
  'health',
  'catalog',
  'digest',
  'checked',
  'error',
  'created',
  'updated',
];

// Pre-ORM files carried user_version 1 or 2; version 1 gains the owner column and owner-scoped names.
function legacy(client: DatabaseSync) {
  const version = Number(client.prepare('PRAGMA user_version').get()!.user_version);
  if (![1, 2].includes(version) || tables(client).join(',') !== storeTables)
    throw new Error('invalid schema');
  const columns = client
    .prepare('PRAGMA table_info(integrations)')
    .all()
    .map((item) => String(item.name))
    .sort()
    .join(',');
  const expected = [...legacyColumns, ...(version >= 2 ? ['owner'] : [])].sort().join(',');
  if (columns !== expected) throw new Error('invalid ownership columns');
  if (!client.prepare('SELECT id FROM integration_meta WHERE id=1').get())
    throw new Fault('MCP_STORE_UNAVAILABLE', 503);
  if (version === 1)
    client.exec(`ALTER TABLE integrations RENAME TO integrations_v1;
      CREATE TABLE integrations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,endpoint TEXT NOT NULL,bearer TEXT,deleted INTEGER NOT NULL,health TEXT NOT NULL,catalog TEXT NOT NULL,digest TEXT,checked TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,owner TEXT);
      INSERT INTO integrations SELECT id,revision,name,name_key,endpoint,bearer,deleted,health,catalog,digest,checked,error,created,updated,NULL FROM integrations_v1;
      DROP TABLE integrations_v1;
      CREATE UNIQUE INDEX integration_owner_name ON integrations(COALESCE(owner,''),name_key);`);
}

export class Integrations {
  // shortcut: one runtime writes a data root; add a process lease before allowing multiple services.
  readonly ready: Promise<unknown>;
  onChange?: (connection: string, bot?: string, kind?: 'config' | 'catalog' | 'binding') => unknown;
  private async notify(
    connection: string,
    bot: string | undefined,
    kind: 'config' | 'catalog' | 'binding',
  ) {
    try {
      await this.onChange?.(connection, bot, kind);
    } catch {
      // Configuration already committed; observer failures must not turn its acknowledgement into a retry.
      console.error('MCP_CHANGE_OBSERVER_FAILED');
    }
  }
  private db?: Database;
  private failed = false;
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load().catch(() => {
      this.failed = true;
    });
  }
  private available() {
    if (!this.db || this.failed || this.closed) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return this.db;
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
      if (!info.isFile() || info.nlink !== 1) throw new Error('invalid store');
    } finally {
      await handle.close();
    }
    await chmod(this.file, 0o600);
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.db = migrate(client, migrations, legacy);
      // Only the baseline seeds revision authority; recreating it on reopen would hide corruption.
      this.verify(this.db);
      // Neither an uncommitted decision nor a dispatched external effect is replayed after service reconstruction.
      const dispatched = sql`${callReceipts.phase} = 'dispatched'`;
      this.db
        .update(callReceipts)
        .set({
          phase: sql`CASE WHEN ${dispatched} THEN 'unknown' ELSE 'cancelled' END`,
          error: sql`CASE WHEN ${dispatched} THEN 'MCP_OUTCOME_UNKNOWN' ELSE 'MCP_CANCELLED' END`,
          updated: new Date().toISOString(),
        })
        .where(inArray(callReceipts.phase, ['claimed', 'dispatched']))
        .run();
    } catch (error) {
      this.db = undefined;
      client.close();
      throw error;
    }
  }
  private verify(db: Database) {
    if (tables(db).join(',') !== storeTables) throw new Error('invalid schema');
    this.currentRevision();
    if (db.select({ count: count() }).from(integrations).get()!.count > 50)
      throw new Error('store limit');
    for (const row of db.select().from(integrations).all()) {
      this.config(row);
      this.public(row);
    }
    for (const row of db.select().from(integrationBindings).all()) {
      const connection = validAgentId(row.connection)
        ? db.select().from(integrations).where(eq(integrations.id, row.connection)).get()
        : undefined;
      if (
        !validAgentId(row.bot) ||
        !validAgentId(row.connection) ||
        !revision(row.revision) ||
        !revision(row.configRevision) ||
        ![0, 1].includes(Number(row.enabled)) ||
        !connection
      )
        throw new Error('invalid binding');
      if (this.owner(connection) && this.owner(connection) !== row.bot)
        throw new Error('invalid owner binding');
      const names: unknown = JSON.parse(String(row.tools));
      if (
        !Array.isArray(names) ||
        names.length > 32 ||
        names.some((name) => typeof name !== 'string') ||
        new Set(names).size !== names.length ||
        (row.enabled === 1 && !hash(row.digest))
      )
        throw new Error('invalid binding');
    }
  }
  private owner(row: Row) {
    if (row.owner === null || row.owner === undefined) return undefined;
    if (!validAgentId(row.owner)) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return row.owner;
  }
  private scoped(id: string, bot?: string) {
    if (bot !== undefined && !validAgentId(bot)) throw new Fault('INVALID_MCP_CONFIG', 400);
    const row = this.row(id);
    if (this.owner(row) !== undefined && this.owner(row) !== bot)
      throw new Fault('MCP_NOT_FOUND', 404);
    return row;
  }
  // Shared connections plus the ones a Bot owns; `owner = NULL` never matches, as in the old SQL.
  private visible(bot: string | undefined) {
    return bot === undefined
      ? isNull(integrations.owner)
      : or(isNull(integrations.owner), eq(integrations.owner, bot));
  }
  private currentRevision() {
    const value = this.available()
      .select({ revision: integrationMeta.revision })
      .from(integrationMeta)
      .where(eq(integrationMeta.id, 1))
      .get()?.revision;
    if (!revision(value, true)) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return Number(value);
  }
  private transaction(action: () => unknown) {
    this.available().transaction(
      (tx) => {
        action();
        if (this.currentRevision() >= Number.MAX_SAFE_INTEGER - 2)
          throw new Fault('MCP_STORAGE_LIMIT');
        tx.update(integrationMeta)
          .set({ revision: sql`${integrationMeta.revision} + 1` })
          .where(eq(integrationMeta.id, 1))
          .run();
      },
      { behavior: 'immediate' },
    );
  }
  private row(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_MCP_CONFIG', 400);
    const row = this.available().select().from(integrations).where(eq(integrations.id, id)).get();
    if (!row) throw new Fault('MCP_NOT_FOUND', 404);
    return row;
  }
  private config(row: Row) {
    if (
      !validAgentId(row.id) ||
      !revision(row.revision) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 60 ||
      ![0, 1].includes(Number(row.deleted)) ||
      !['unchecked', 'ready', 'unavailable'].includes(String(row.health))
    )
      throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    const url = endpoint(row.endpoint),
      bearer = row.bearer === null ? undefined : row.bearer;
    if (
      bearer !== undefined &&
      (typeof bearer !== 'string' || !/^[\x21-\x7e]+$/.test(bearer) || bearer.length > 4096)
    )
      throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    const parsed: unknown = JSON.parse(String(row.catalog));
    if (!Array.isArray(parsed)) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    const tools = mcpCatalog(
      String(row.id),
      parsed,
      mcpSecrets({ endpoint: url, bearer: bearer as string | undefined }),
    );
    if (
      (row.digest !== null && (!hash(row.digest) || row.digest !== mcpDigest(tools))) ||
      (row.health === 'ready' && !hash(row.digest))
    )
      throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return {
      id: String(row.id),
      revision: Number(row.revision),
      name: row.name,
      endpoint: url,
      bearer: bearer as string | undefined,
      deleted: row.deleted === 1,
      tools,
      catalogDigest: row.digest === null ? undefined : String(row.digest),
    };
  }
  private public(row: Row): McpConnection {
    const config = this.config(row);
    if (
      !code(row.error === null ? undefined : row.error) ||
      [row.created, row.updated, ...(row.checked === null ? [] : [row.checked])].some(
        (value) => typeof value !== 'string' || !Number.isFinite(Date.parse(value)),
      )
    )
      throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return {
      id: config.id,
      name: config.name,
      revision: config.revision,
      origin: new URL(config.endpoint).origin,
      ...(this.owner(row) ? { ownerBot: this.owner(row) } : {}),
      credentialConfigured: !!config.bearer || !!new URL(config.endpoint).search,
      deleted: config.deleted,
      health: row.health as McpConnection['health'],
      toolCount: config.tools.length,
      ...(config.catalogDigest ? { catalogDigest: config.catalogDigest } : {}),
      ...(row.checked ? { checkedAt: String(row.checked) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: String(row.created),
      updatedAt: String(row.updated),
    };
  }
  async status() {
    await this.ready;
    try {
      return { available: true, revision: this.currentRevision() };
    } catch {
      return { available: false, error: 'MCP_STORE_UNAVAILABLE' };
    }
  }
  async read(id: string, bot?: string) {
    await this.ready;
    return this.public(this.scoped(id, bot));
  }
  async list(includeDeleted = false, bot?: string) {
    await this.ready;
    if (bot !== undefined && !validAgentId(bot)) throw new Fault('INVALID_MCP_CONFIG', 400);
    return {
      revision: this.currentRevision(),
      items: this.available()
        .select()
        .from(integrations)
        .where(and(eq(integrations.deleted, Number(includeDeleted)), this.visible(bot)))
        .orderBy(integrations.name)
        .all()
        .map((row) => this.public(row)),
    };
  }
  async privateConfig(id: string) {
    await this.ready;
    return this.config(this.row(id));
  }
  async catalogView(id: string, bot?: string) {
    await this.ready;
    const row = this.scoped(id, bot);
    return { current: this.public(row), tools: this.config(row).tools };
  }
  async saved(id: string, connection: string, bot?: string) {
    await this.ready;
    if (!validAgentId(id) || !validAgentId(connection)) throw new Fault('INVALID_MCP_CONFIG', 400);
    const receipt = this.available()
      .select()
      .from(configCommands)
      .where(and(eq(configCommands.id, id), eq(configCommands.connection, connection)))
      .get();
    if (!receipt) throw new Fault('MCP_SAVE_NOT_FOUND', 404);
    return {
      receipt: { id, connection, revision: Number(receipt.revision) },
      current: this.public(this.scoped(connection, bot)),
    };
  }
  async save(input: McpSave, bot?: string) {
    await this.ready;
    if (bot !== undefined && !validAgentId(bot)) throw new Fault('INVALID_MCP_CONFIG', 400);
    if (
      !object(input) ||
      Object.keys(input).some(
        (key) => !['requestId', 'id', 'revision', 'name', 'endpoint', 'bearer'].includes(key),
      ) ||
      !validAgentId(input.requestId) ||
      !validAgentId(input.id) ||
      !revision(input.revision, true) ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > 60 ||
      input.name.includes('\0') ||
      (input.endpoint !== undefined && typeof input.endpoint !== 'string') ||
      (input.bearer !== undefined &&
        input.bearer !== null &&
        (typeof input.bearer !== 'string' ||
          input.bearer.length > 4096 ||
          (input.bearer !== '' && !/^[\x21-\x7e]+$/.test(input.bearer))))
    )
      throw new Fault('INVALID_MCP_CONFIG', 400);
    if (input.endpoint !== undefined) endpoint(input.endpoint);
    const db = this.available(),
      fingerprint = mcpDigest(JSON.parse(JSON.stringify(bot === undefined ? input : [bot, input])));
    const prior = db
      .select()
      .from(configCommands)
      .where(eq(configCommands.id, input.requestId))
      .get();
    if (prior) {
      if (prior.hash !== fingerprint || prior.connection !== input.id)
        throw new Fault('MCP_REQUEST_ID_REUSED');
      return {
        receipt: { id: input.requestId, connection: input.id, revision: Number(prior.revision) },
        current: this.public(this.scoped(input.id, bot)),
      };
    }
    const row = db.select().from(integrations).where(eq(integrations.id, input.id)).get();
    if (row) {
      this.scoped(input.id, bot);
      if (bot !== undefined && !this.owner(row)) throw new Fault('MCP_SHARED_READ_ONLY', 409);
    }
    if ((row?.revision ?? 0) !== input.revision) throw new Fault('MCP_CONFLICT');
    if (row?.deleted === 1) throw new Fault('MCP_ARCHIVED');
    if (!row && db.select({ count: count() }).from(integrations).get()!.count >= 50)
      throw new Fault('MCP_CONNECTION_LIMIT');
    if (db.select({ count: count() }).from(configCommands).get()!.count >= 10000)
      throw new Fault('MCP_STORAGE_LIMIT');
    const old = row ? this.config(row) : undefined,
      url = input.endpoint === undefined ? old?.endpoint : endpoint(input.endpoint);
    if (!url) throw new Fault('INVALID_MCP_CONFIG', 400);
    const bearer = input.bearer === null ? undefined : input.bearer || old?.bearer,
      name = input.name.trim(),
      nameKey = name.normalize('NFC').toLowerCase();
    const scope = row ? this.owner(row) : bot;
    if (
      db
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(
            eq(integrations.nameKey, nameKey),
            scope === undefined ? isNull(integrations.owner) : eq(integrations.owner, scope),
            ne(integrations.id, input.id),
          ),
        )
        .get()
    )
      throw new Fault('MCP_NAME_CONFLICT');
    const changed = !old || url !== old.endpoint || bearer !== old.bearer;
    const next = input.revision + 1,
      now = new Date().toISOString();
    this.transaction(() => {
      if (!row)
        db.insert(integrations)
          .values({
            id: input.id,
            revision: next,
            name,
            nameKey,
            endpoint: url,
            bearer: bearer ?? null,
            deleted: 0,
            health: 'unchecked',
            catalog: '[]',
            digest: null,
            checked: null,
            error: null,
            created: now,
            updated: now,
            owner: bot ?? null,
          })
          .run();
      else
        db.update(integrations)
          .set({
            revision: next,
            name,
            nameKey,
            endpoint: url,
            bearer: bearer ?? null,
            health: changed ? 'unchecked' : String(row.health),
            catalog: changed ? '[]' : String(row.catalog),
            digest: changed ? null : row.digest,
            checked: changed ? null : row.checked,
            error: null,
            updated: now,
          })
          .where(eq(integrations.id, input.id))
          .run();
      db.insert(configCommands)
        .values({ id: input.requestId, hash: fingerprint, connection: input.id, revision: next })
        .run();
    });
    await this.notify(input.id, undefined, 'config');
    return {
      receipt: { id: input.requestId, connection: input.id, revision: next },
      current: this.public(this.row(input.id)),
    };
  }
  async catalog(id: string, expected: number, input: unknown) {
    await this.ready;
    const row = this.row(id);
    if (row.revision !== expected) throw new Fault('MCP_CONFLICT');
    if (row.deleted === 1) throw new Fault('MCP_ARCHIVED');
    const config = this.config(row),
      tools = mcpCatalog(id, input, mcpSecrets(config)),
      digest = mcpDigest(tools),
      changed = digest !== row.digest;
    this.transaction(() =>
      this.available()
        .update(integrations)
        .set({
          catalog: JSON.stringify(tools),
          digest,
          health: 'ready',
          checked: new Date().toISOString(),
          error: null,
          updated: new Date().toISOString(),
        })
        .where(eq(integrations.id, id))
        .run(),
    );
    if (changed) await this.notify(id, undefined, 'catalog');
    return { current: this.public(this.row(id)), tools };
  }
  async health(id: string, expected: number, error: string) {
    await this.ready;
    const row = this.row(id);
    if (row.revision !== expected) throw new Fault('MCP_CONFLICT');
    if (!code(error)) throw new Fault('INVALID_MCP_CONFIG', 400);
    this.transaction(() =>
      this.available()
        .update(integrations)
        .set({ health: 'unavailable', checked: new Date().toISOString(), error })
        .where(eq(integrations.id, id))
        .run(),
    );
    return this.public(this.row(id));
  }
  private binding(bot: string, id: string) {
    return this.available()
      .select()
      .from(integrationBindings)
      .where(and(eq(integrationBindings.bot, bot), eq(integrationBindings.connection, id)))
      .get();
  }
  async assignments(bot: string) {
    await this.ready;
    if (!validAgentId(bot)) throw new Fault('INVALID_MCP_CONFIG', 400);
    return {
      bot,
      revision: this.currentRevision(),
      items: this.available()
        .select()
        .from(integrations)
        .where(and(eq(integrations.deleted, 0), this.visible(bot)))
        .orderBy(integrations.name)
        .all()
        .map((row) => {
          const connection = this.public(row),
            binding = this.binding(bot, connection.id);
          return {
            connection,
            revision: Number(binding?.revision ?? 0),
            enabled: binding?.enabled === 1,
            tools: binding ? (JSON.parse(String(binding.tools)) as string[]) : [],
            catalogDigest: binding?.digest ? String(binding.digest) : undefined,
            available:
              binding?.enabled === 1 &&
              binding.configRevision === connection.revision &&
              binding.digest === connection.catalogDigest,
          };
        }),
    };
  }
  async bind(bot: string, input: McpBindingInput) {
    await this.ready;
    if (
      !validAgentId(bot) ||
      !object(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'connection',
            'configRevision',
            'bindingRevision',
            'catalogDigest',
            'tools',
            'enabled',
          ].includes(key),
      ) ||
      !validAgentId(input.connection) ||
      !revision(input.configRevision) ||
      !revision(input.bindingRevision, true) ||
      typeof input.enabled !== 'boolean' ||
      !Array.isArray(input.tools) ||
      input.tools.length > 32 ||
      input.tools.some((name) => typeof name !== 'string' || !name || name.length > 200) ||
      new Set(input.tools).size !== input.tools.length
    )
      throw new Fault('INVALID_MCP_BINDING', 400);
    const row = this.scoped(input.connection, bot);
    if (row.revision !== input.configRevision) throw new Fault('MCP_CONFLICT');
    if (row.deleted === 1) throw new Fault('MCP_ARCHIVED');
    const config = this.config(row),
      old = this.binding(bot, input.connection);
    if ((old?.revision ?? 0) !== input.bindingRevision) throw new Fault('MCP_BINDING_CONFLICT');
    if (input.enabled) {
      if (
        !input.tools.length ||
        !hash(input.catalogDigest) ||
        input.catalogDigest !== config.catalogDigest ||
        row.health !== 'ready'
      )
        throw new Fault('MCP_REVIEW_REQUIRED');
      if (input.tools.some((name) => !config.tools.some((tool) => tool.name === name)))
        throw new Fault('MCP_TOOL_NOT_FOUND');
      const others = this.available()
        .select({ tools: integrationBindings.tools })
        .from(integrationBindings)
        .where(
          and(
            eq(integrationBindings.bot, bot),
            ne(integrationBindings.connection, input.connection),
            eq(integrationBindings.enabled, 1),
          ),
        )
        .all()
        .reduce((count, row) => count + (JSON.parse(String(row.tools)) as string[]).length, 0);
      if (others + input.tools.length > 32) throw new Fault('MCP_TOOL_LIMIT');
    }
    this.transaction(() =>
      this.available()
        .insert(integrationBindings)
        .values({
          bot,
          connection: input.connection,
          revision: input.bindingRevision + 1,
          configRevision: input.configRevision,
          digest: input.catalogDigest ?? null,
          tools: JSON.stringify(input.tools),
          enabled: Number(input.enabled),
        })
        .onConflictDoUpdate({
          target: [integrationBindings.bot, integrationBindings.connection],
          set: {
            revision: sql`excluded.revision`,
            configRevision: sql`excluded.config_revision`,
            digest: sql`excluded.digest`,
            tools: sql`excluded.tools`,
            enabled: sql`excluded.enabled`,
          },
        })
        .run(),
    );
    await this.notify(input.connection, bot, 'binding');
    return (await this.assignments(bot)).items.find(
      (item) => item.connection.id === input.connection,
    )!;
  }
  private async deleted(id: string, expected: number, value: boolean, bot?: string) {
    await this.ready;
    const row = this.scoped(id, bot);
    if (bot !== undefined && !this.owner(row)) throw new Fault('MCP_SHARED_READ_ONLY', 409);
    if (row.revision !== expected) throw new Fault('MCP_CONFLICT');
    if (!revision(expected)) throw new Fault('INVALID_MCP_CONFIG', 400);
    if ((row.deleted === 1) !== value)
      this.transaction(() => {
        const db = this.available();
        db.update(integrations)
          .set({
            deleted: Number(value),
            revision: sql`${integrations.revision} + 1`,
            updated: new Date().toISOString(),
          })
          .where(eq(integrations.id, id))
          .run();
        if (value)
          db.update(integrationBindings)
            .set({ enabled: 0, revision: sql`${integrationBindings.revision} + 1` })
            .where(eq(integrationBindings.connection, id))
            .run();
      });
    await this.notify(id, undefined, 'config');
    return this.public(this.row(id));
  }
  archive(id: string, expected: number, bot?: string) {
    return this.deleted(id, expected, true, bot);
  }
  restore(id: string, expected: number, bot?: string) {
    return this.deleted(id, expected, false, bot);
  }
  async capture(bot: string): Promise<McpSnapshot> {
    await this.ready;
    if (!validAgentId(bot)) throw new Fault('INVALID_MCP_BINDING', 400);
    try {
      const connections: McpCapture[] = [],
        warnings: string[] = [];
      const rows = this.available()
        .select()
        .from(integrationBindings)
        .where(and(eq(integrationBindings.bot, bot), eq(integrationBindings.enabled, 1)))
        .orderBy(integrationBindings.connection)
        .all();
      for (const binding of rows) {
        const row = this.scoped(String(binding.connection), bot),
          config = this.config(row);
        if (
          config.deleted ||
          binding.configRevision !== config.revision ||
          !config.catalogDigest ||
          binding.digest !== config.catalogDigest
        ) {
          warnings.push(
            `${config.name}: configuration or tool catalog has changed; recheck before use.`,
          );
          continue;
        }
        const selected = JSON.parse(String(binding.tools)) as string[];
        if (selected.some((name) => !config.tools.some((tool) => tool.name === name))) {
          warnings.push(`${config.name}: tool selection needs to be rechecked before use.`);
          continue;
        }
        connections.push({
          connection: config.id,
          revision: config.revision,
          bindingRevision: Number(binding.revision),
          catalogDigest: config.catalogDigest,
          name: config.name,
          origin: new URL(config.endpoint).origin,
          tools: config.tools.filter((tool) => selected.includes(tool.name)),
        });
      }
      return {
        available: true,
        key: rows.length
          ? mcpDigest([
              rows.map((row) => [row.connection, row.revision, row.configRevision, row.digest]),
              // A stale binding can keep its row revision while its live tool authority disappears.
              connections.map((entry) => [entry.connection, entry.revision, entry.catalogDigest]),
            ])
          : '',
        connections,
        warnings,
      };
    } catch {
      return {
        available: false,
        key: 'unavailable',
        connections: [],
        warnings: [
          'MCP connections are unavailable; ordinary conversation and existing workspace tools remain available.',
        ],
      };
    }
  }
  async assertLive(bot: string, capture: McpCapture, tool: string) {
    await this.ready;
    return this.assertLiveNow(bot, capture, tool);
  }
  assertLiveNow(bot: string, capture: McpCapture, tool: string) {
    const config = this.config(this.scoped(capture.connection, bot)),
      binding = this.binding(bot, capture.connection);
    if (
      config.deleted ||
      config.revision !== capture.revision ||
      config.catalogDigest !== capture.catalogDigest ||
      !binding ||
      binding.enabled !== 1 ||
      binding.revision !== capture.bindingRevision ||
      binding.configRevision !== capture.revision ||
      binding.digest !== capture.catalogDigest ||
      !(JSON.parse(String(binding.tools)) as string[]).includes(tool)
    )
      throw new Fault('MCP_AUTHORITY_CHANGED');
    return config;
  }
  private call(id: string) {
    const row = this.available().select().from(callReceipts).where(eq(callReceipts.id, id)).get();
    if (!row) throw new Fault('MCP_REQUEST_NOT_FOUND', 404);
    return row;
  }
  private receiptRow(row: Row): McpReceipt {
    const value = {
      id: String(row.id),
      bot: String(row.bot),
      run: String(row.run),
      session: String(row.session),
      connection: String(row.connection),
      configRevision: Number(row.configRevision),
      tool: String(row.tool),
      phase: String(row.phase),
      preview: String(row.preview),
      ...(row.result !== null ? { result: String(row.result) } : {}),
      ...(row.error !== null ? { error: String(row.error) } : {}),
      createdAt: String(row.created),
      updatedAt: String(row.updated),
    };
    if (!isMcpReceipt(value)) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return value;
  }
  async claim(input: McpClaim) {
    await this.ready;
    if (
      ![input.id, input.bot, input.run, input.connection].every(validAgentId) ||
      typeof input.session !== 'string' ||
      input.session.length > 200 ||
      !revision(input.configRevision) ||
      typeof input.tool !== 'string' ||
      input.tool.length > 200 ||
      !object(input.arguments) ||
      typeof input.preview !== 'string' ||
      Buffer.byteLength(input.preview) > 64000
    )
      throw new Fault('INVALID_MCP_CALL', 400);
    const args = canonicalJson(input.arguments);
    if (Buffer.byteLength(args) > 64000) throw new Fault('INVALID_MCP_CALL', 400);
    const semantic = mcpDigest([
        input.bot,
        input.run,
        input.connection,
        input.tool,
        input.arguments,
      ]),
      fingerprint = mcpDigest([semantic, input.id, input.session, input.configRevision]);
    const db = this.available(),
      old = db.select().from(callReceipts).where(eq(callReceipts.id, input.id)).get();
    if (old) {
      if (old.hash !== fingerprint) throw new Fault('MCP_REQUEST_ID_REUSED');
      return { fresh: false, receipt: this.receiptRow(old) };
    }
    const pending = db
      .select({ phase: callReceipts.phase })
      .from(callReceipts)
      .where(
        and(
          eq(callReceipts.bot, input.bot),
          eq(callReceipts.run, input.run),
          eq(callReceipts.semantic, semantic),
          inArray(callReceipts.phase, ['claimed', 'dispatched', 'unknown']),
        ),
      )
      .limit(1)
      .get();
    if (pending)
      throw new Fault(pending.phase === 'claimed' ? 'MCP_CALL_PENDING' : 'MCP_OUTCOME_UNKNOWN');
    if (db.select({ count: count() }).from(callReceipts).get()!.count >= 10000)
      throw new Fault('MCP_STORAGE_LIMIT');
    const config = this.config(this.row(input.connection));
    if (config.deleted || config.revision !== input.configRevision)
      throw new Fault('MCP_AUTHORITY_CHANGED');
    const now = new Date().toISOString();
    this.transaction(() =>
      db
        .insert(callReceipts)
        .values({
          id: input.id,
          hash: fingerprint,
          semantic,
          bot: input.bot,
          run: input.run,
          session: input.session,
          connection: input.connection,
          configRevision: input.configRevision,
          tool: input.tool,
          phase: 'claimed',
          preview: input.preview,
          result: null,
          error: null,
          created: now,
          updated: now,
        })
        .run(),
    );
    return { fresh: true, receipt: this.receiptRow(this.call(input.id)) };
  }
  async dispatched(id: string) {
    await this.ready;
    const row = this.call(id);
    if (row.phase !== 'claimed') throw new Fault('MCP_REPLAY_BLOCKED');
    const config = this.config(this.row(String(row.connection)));
    if (config.deleted || config.revision !== row.configRevision)
      throw new Fault('MCP_AUTHORITY_CHANGED');
    this.transaction(() =>
      this.available()
        .update(callReceipts)
        .set({ phase: 'dispatched', updated: new Date().toISOString() })
        .where(eq(callReceipts.id, id))
        .run(),
    );
  }
  async finish(id: string, outcome: McpOutcome) {
    await this.ready;
    const row = this.call(id);
    if (
      !['settled', 'denied', 'cancelled', 'unknown'].includes(outcome.phase) ||
      !code(outcome.error) ||
      (outcome.result !== undefined &&
        (typeof outcome.result !== 'string' || Buffer.byteLength(outcome.result) > 1024 * 1024))
    )
      throw new Fault('INVALID_MCP_RECEIPT', 400);
    if (!['claimed', 'dispatched'].includes(String(row.phase))) {
      if (
        row.phase !== outcome.phase ||
        (row.result ?? undefined) !== outcome.result ||
        (row.error ?? undefined) !== outcome.error
      )
        throw new Fault('MCP_RECEIPT_CONFLICT');
      return this.receiptRow(row);
    }
    if (outcome.phase === 'unknown' && row.phase !== 'dispatched')
      throw new Fault('INVALID_MCP_RECEIPT', 400);
    this.transaction(() =>
      this.available()
        .update(callReceipts)
        .set({
          phase: outcome.phase,
          result: outcome.result ?? null,
          error: outcome.error ?? null,
          updated: new Date().toISOString(),
        })
        .where(eq(callReceipts.id, id))
        .run(),
    );
    return this.receiptRow(this.call(id));
  }
  async receipt(bot: string, run: string, id: string) {
    await this.ready;
    const row = this.call(id);
    if (row.bot !== bot || row.run !== run) throw new Fault('MCP_REQUEST_NOT_FOUND', 404);
    return this.receiptRow(row);
  }
  async calls(bot: string, connection?: string) {
    await this.ready;
    if (!validAgentId(bot) || (connection !== undefined && !validAgentId(connection)))
      throw new Fault('INVALID_MCP_CONFIG', 400);
    const rows = this.available()
      .select({
        id: callReceipts.id,
        bot: callReceipts.bot,
        run: callReceipts.run,
        session: callReceipts.session,
        connection: callReceipts.connection,
        configRevision: callReceipts.configRevision,
        tool: callReceipts.tool,
        phase: callReceipts.phase,
        preview: sql<string>`SUBSTR(${callReceipts.preview},1,1400)`,
        error: callReceipts.error,
        created: callReceipts.created,
        updated: callReceipts.updated,
      })
      .from(callReceipts)
      .where(
        and(
          eq(callReceipts.bot, bot),
          connection ? eq(callReceipts.connection, connection) : undefined,
        ),
      )
      .orderBy(desc(callReceipts.created), desc(callReceipts.id))
      .limit(20)
      .all();
    // History omits result bodies.
    return { bot, items: rows.map((row) => this.receiptRow({ ...row, result: null })) };
  }
  async close() {
    this.closed = true;
    await this.ready;
    this.db?.$client.close();
    this.db = undefined;
  }
}
