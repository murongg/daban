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
import { Fault } from './control.js';
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
  private db?: DatabaseSync;
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
    this.db = new DatabaseSync(this.file);
    const db = this.db;
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
      .sort();
    if (
      (version === 0 && tables.length) ||
      (version !== 0 && version !== 1) ||
      (version === 1 &&
        tables.join(',') !==
          'call_receipts,config_commands,integration_bindings,integration_meta,integrations')
    )
      throw new Error('invalid schema');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if (version === 0)
      db.exec(`CREATE TABLE integrations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,endpoint TEXT NOT NULL,bearer TEXT,deleted INTEGER NOT NULL,health TEXT NOT NULL,catalog TEXT NOT NULL,digest TEXT,checked TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE integration_bindings(bot TEXT NOT NULL,connection TEXT NOT NULL,revision INTEGER NOT NULL,config_revision INTEGER NOT NULL,digest TEXT,tools TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(bot,connection));
      CREATE TABLE config_commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,connection TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE call_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,semantic TEXT NOT NULL,bot TEXT NOT NULL,run TEXT NOT NULL,session TEXT NOT NULL,connection TEXT NOT NULL,config_revision INTEGER NOT NULL,tool TEXT NOT NULL,phase TEXT NOT NULL,preview TEXT NOT NULL,result TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE INDEX receipt_owner ON call_receipts(bot,run,semantic);
      CREATE TABLE integration_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT INTO integration_meta VALUES(1,0); PRAGMA user_version=1;`);
    this.currentRevision();
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM integrations').get()!.count) > 50)
      throw new Error('store limit');
    for (const row of db.prepare('SELECT * FROM integrations').all()) {
      this.config(row);
      this.public(row);
    }
    for (const row of db.prepare('SELECT * FROM integration_bindings').all()) {
      if (
        !validAgentId(row.bot) ||
        !validAgentId(row.connection) ||
        !revision(row.revision) ||
        !revision(row.config_revision) ||
        ![0, 1].includes(Number(row.enabled)) ||
        !db.prepare('SELECT id FROM integrations WHERE id=?').get(String(row.connection))
      )
        throw new Error('invalid binding');
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
    // Neither an uncommitted decision nor a dispatched external effect is replayed after service reconstruction.
    db.prepare(
      "UPDATE call_receipts SET phase=CASE WHEN phase='dispatched' THEN 'unknown' ELSE 'cancelled' END,error=CASE WHEN phase='dispatched' THEN 'MCP_OUTCOME_UNKNOWN' ELSE 'MCP_CANCELLED' END,updated=? WHERE phase IN ('claimed','dispatched')",
    ).run(new Date().toISOString());
  }
  private currentRevision() {
    const value = this.available()
      .prepare('SELECT revision FROM integration_meta WHERE id=1')
      .get()?.revision;
    if (!revision(value, true)) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
    return Number(value);
  }
  private transaction<T>(action: () => T) {
    const db = this.available();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      if (this.currentRevision() >= Number.MAX_SAFE_INTEGER - 2)
        throw new Fault('MCP_STORAGE_LIMIT');
      db.prepare('UPDATE integration_meta SET revision=revision+1 WHERE id=1').run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  private row(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_MCP_CONFIG', 400);
    const row = this.available().prepare('SELECT * FROM integrations WHERE id=?').get(id);
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
  async read(id: string) {
    await this.ready;
    return this.public(this.row(id));
  }
  async list(includeDeleted = false) {
    await this.ready;
    return {
      revision: this.currentRevision(),
      items: this.available()
        .prepare('SELECT * FROM integrations WHERE deleted=? ORDER BY name')
        .all(Number(includeDeleted))
        .map((row) => this.public(row)),
    };
  }
  async privateConfig(id: string) {
    await this.ready;
    return this.config(this.row(id));
  }
  async catalogView(id: string) {
    await this.ready;
    const row = this.row(id);
    return { current: this.public(row), tools: this.config(row).tools };
  }
  async saved(id: string, connection: string) {
    await this.ready;
    if (!validAgentId(id) || !validAgentId(connection)) throw new Fault('INVALID_MCP_CONFIG', 400);
    const receipt = this.available()
      .prepare('SELECT * FROM config_commands WHERE id=? AND connection=?')
      .get(id, connection);
    if (!receipt) throw new Fault('MCP_SAVE_NOT_FOUND', 404);
    return {
      receipt: { id, connection, revision: Number(receipt.revision) },
      current: this.public(this.row(connection)),
    };
  }
  async save(input: McpSave) {
    await this.ready;
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
      fingerprint = mcpDigest(JSON.parse(JSON.stringify(input)));
    const prior = db.prepare('SELECT * FROM config_commands WHERE id=?').get(input.requestId);
    if (prior) {
      if (prior.hash !== fingerprint || prior.connection !== input.id)
        throw new Fault('MCP_REQUEST_ID_REUSED');
      return {
        receipt: { id: input.requestId, connection: input.id, revision: Number(prior.revision) },
        current: this.public(this.row(input.id)),
      };
    }
    const row = db.prepare('SELECT * FROM integrations WHERE id=?').get(input.id);
    if ((row?.revision ?? 0) !== input.revision) throw new Fault('MCP_CONFLICT');
    if (row?.deleted === 1) throw new Fault('MCP_ARCHIVED');
    if (!row && Number(db.prepare('SELECT COUNT(*) AS count FROM integrations').get()!.count) >= 50)
      throw new Fault('MCP_CONNECTION_LIMIT');
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM config_commands').get()!.count) >= 10000)
      throw new Fault('MCP_STORAGE_LIMIT');
    const old = row ? this.config(row) : undefined,
      url = input.endpoint === undefined ? old?.endpoint : endpoint(input.endpoint);
    if (!url) throw new Fault('INVALID_MCP_CONFIG', 400);
    const bearer = input.bearer === null ? undefined : input.bearer || old?.bearer,
      name = input.name.trim(),
      nameKey = name.normalize('NFC').toLowerCase();
    if (db.prepare('SELECT id FROM integrations WHERE name_key=? AND id<>?').get(nameKey, input.id))
      throw new Fault('MCP_NAME_CONFLICT');
    const changed = !old || url !== old.endpoint || bearer !== old.bearer;
    const next = input.revision + 1,
      now = new Date().toISOString();
    this.transaction(() => {
      if (!row)
        db.prepare(
          "INSERT INTO integrations VALUES(?,?,?,?,?,?,0,'unchecked','[]',NULL,NULL,NULL,?,?)",
        ).run(input.id, next, name, nameKey, url, bearer ?? null, now, now);
      else
        db.prepare(
          'UPDATE integrations SET revision=?,name=?,name_key=?,endpoint=?,bearer=?,health=?,catalog=?,digest=?,checked=?,error=NULL,updated=? WHERE id=?',
        ).run(
          next,
          name,
          nameKey,
          url,
          bearer ?? null,
          changed ? 'unchecked' : String(row.health),
          changed ? '[]' : String(row.catalog),
          changed ? null : (row.digest as string | null),
          changed ? null : (row.checked as string | null),
          now,
          input.id,
        );
      db.prepare('INSERT INTO config_commands VALUES(?,?,?,?)').run(
        input.requestId,
        fingerprint,
        input.id,
        next,
      );
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
        .prepare(
          "UPDATE integrations SET catalog=?,digest=?,health='ready',checked=?,error=NULL,updated=? WHERE id=?",
        )
        .run(JSON.stringify(tools), digest, new Date().toISOString(), new Date().toISOString(), id),
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
        .prepare("UPDATE integrations SET health='unavailable',checked=?,error=? WHERE id=?")
        .run(new Date().toISOString(), error, id),
    );
    return this.public(this.row(id));
  }
  private binding(bot: string, id: string) {
    return this.available()
      .prepare('SELECT * FROM integration_bindings WHERE bot=? AND connection=?')
      .get(bot, id);
  }
  async assignments(bot: string) {
    await this.ready;
    if (!validAgentId(bot)) throw new Fault('INVALID_MCP_CONFIG', 400);
    return {
      bot,
      revision: this.currentRevision(),
      items: this.available()
        .prepare('SELECT * FROM integrations WHERE deleted=0 ORDER BY name')
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
              binding.config_revision === connection.revision &&
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
    const row = this.row(input.connection);
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
        .prepare(
          'SELECT tools FROM integration_bindings WHERE bot=? AND connection<>? AND enabled=1',
        )
        .all(bot, input.connection)
        .reduce((count, row) => count + (JSON.parse(String(row.tools)) as string[]).length, 0);
      if (others + input.tools.length > 32) throw new Fault('MCP_TOOL_LIMIT');
    }
    this.transaction(() =>
      this.available()
        .prepare(
          'INSERT INTO integration_bindings VALUES(?,?,?,?,?,?,?) ON CONFLICT(bot,connection) DO UPDATE SET revision=excluded.revision,config_revision=excluded.config_revision,digest=excluded.digest,tools=excluded.tools,enabled=excluded.enabled',
        )
        .run(
          bot,
          input.connection,
          input.bindingRevision + 1,
          input.configRevision,
          input.catalogDigest ?? null,
          JSON.stringify(input.tools),
          Number(input.enabled),
        ),
    );
    await this.notify(input.connection, bot, 'binding');
    return (await this.assignments(bot)).items.find(
      (item) => item.connection.id === input.connection,
    )!;
  }
  private async deleted(id: string, expected: number, value: boolean) {
    await this.ready;
    const row = this.row(id);
    if (row.revision !== expected) throw new Fault('MCP_CONFLICT');
    if (!revision(expected)) throw new Fault('INVALID_MCP_CONFIG', 400);
    if ((row.deleted === 1) !== value)
      this.transaction(() => {
        const db = this.available();
        db.prepare(
          'UPDATE integrations SET deleted=?,revision=revision+1,updated=? WHERE id=?',
        ).run(Number(value), new Date().toISOString(), id);
        if (value)
          db.prepare(
            'UPDATE integration_bindings SET enabled=0,revision=revision+1 WHERE connection=?',
          ).run(id);
      });
    await this.notify(id, undefined, 'config');
    return this.public(this.row(id));
  }
  archive(id: string, expected: number) {
    return this.deleted(id, expected, true);
  }
  restore(id: string, expected: number) {
    return this.deleted(id, expected, false);
  }
  async capture(bot: string): Promise<McpSnapshot> {
    await this.ready;
    if (!validAgentId(bot)) throw new Fault('INVALID_MCP_BINDING', 400);
    try {
      const connections: McpCapture[] = [],
        warnings: string[] = [];
      const rows = this.available()
        .prepare('SELECT * FROM integration_bindings WHERE bot=? AND enabled=1 ORDER BY connection')
        .all(bot);
      for (const binding of rows) {
        const row = this.row(String(binding.connection)),
          config = this.config(row);
        if (
          config.deleted ||
          binding.config_revision !== config.revision ||
          !config.catalogDigest ||
          binding.digest !== config.catalogDigest
        ) {
          warnings.push(`${config.name}的配置或工具目录已变化，需要重新核对。`);
          continue;
        }
        const selected = JSON.parse(String(binding.tools)) as string[];
        if (selected.some((name) => !config.tools.some((tool) => tool.name === name))) {
          warnings.push(`${config.name}的工具选择需要重新核对。`);
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
              rows.map((row) => [row.connection, row.revision, row.config_revision, row.digest]),
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
        warnings: ['MCP 连接暂不可用；普通对话和已有工作区工具仍可使用。'],
      };
    }
  }
  async assertLive(bot: string, capture: McpCapture, tool: string) {
    await this.ready;
    const config = this.config(this.row(capture.connection)),
      binding = this.binding(bot, capture.connection);
    if (
      config.deleted ||
      config.revision !== capture.revision ||
      config.catalogDigest !== capture.catalogDigest ||
      !binding ||
      binding.enabled !== 1 ||
      binding.revision !== capture.bindingRevision ||
      binding.config_revision !== capture.revision ||
      binding.digest !== capture.catalogDigest ||
      !(JSON.parse(String(binding.tools)) as string[]).includes(tool)
    )
      throw new Fault('MCP_AUTHORITY_CHANGED');
    return config;
  }
  private call(id: string) {
    const row = this.available().prepare('SELECT * FROM call_receipts WHERE id=?').get(id);
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
      configRevision: Number(row.config_revision),
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
      old = db.prepare('SELECT * FROM call_receipts WHERE id=?').get(input.id);
    if (old) {
      if (old.hash !== fingerprint) throw new Fault('MCP_REQUEST_ID_REUSED');
      return { fresh: false, receipt: this.receiptRow(old) };
    }
    const pending = db
      .prepare(
        "SELECT phase FROM call_receipts WHERE bot=? AND run=? AND semantic=? AND phase IN ('claimed','dispatched','unknown') LIMIT 1",
      )
      .get(input.bot, input.run, semantic);
    if (pending)
      throw new Fault(pending.phase === 'claimed' ? 'MCP_CALL_PENDING' : 'MCP_OUTCOME_UNKNOWN');
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM call_receipts').get()!.count) >= 10000)
      throw new Fault('MCP_STORAGE_LIMIT');
    const config = this.config(this.row(input.connection));
    if (config.deleted || config.revision !== input.configRevision)
      throw new Fault('MCP_AUTHORITY_CHANGED');
    const now = new Date().toISOString();
    this.transaction(() =>
      db
        .prepare("INSERT INTO call_receipts VALUES(?,?,?,?,?,?,?,?,?,'claimed',?,NULL,NULL,?,?)")
        .run(
          input.id,
          fingerprint,
          semantic,
          input.bot,
          input.run,
          input.session,
          input.connection,
          input.configRevision,
          input.tool,
          input.preview,
          now,
          now,
        ),
    );
    return { fresh: true, receipt: this.receiptRow(this.call(input.id)) };
  }
  async dispatched(id: string) {
    await this.ready;
    const row = this.call(id);
    if (row.phase !== 'claimed') throw new Fault('MCP_REPLAY_BLOCKED');
    const config = this.config(this.row(String(row.connection)));
    if (config.deleted || config.revision !== row.config_revision)
      throw new Fault('MCP_AUTHORITY_CHANGED');
    this.transaction(() =>
      this.available()
        .prepare("UPDATE call_receipts SET phase='dispatched',updated=? WHERE id=?")
        .run(new Date().toISOString(), id),
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
        .prepare('UPDATE call_receipts SET phase=?,result=?,error=?,updated=? WHERE id=?')
        .run(
          outcome.phase,
          outcome.result ?? null,
          outcome.error ?? null,
          new Date().toISOString(),
          id,
        ),
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
    const query = `SELECT id,hash,semantic,bot,run,session,connection,config_revision,tool,phase,
      SUBSTR(preview,1,1400) AS preview,NULL AS result,error,created,updated
      FROM call_receipts WHERE bot=?${connection ? ' AND connection=?' : ''}
      ORDER BY created DESC,id DESC LIMIT 20`;
    const rows = this.available()
      .prepare(query)
      .all(bot, ...(connection ? [connection] : []));
    return { bot, items: rows.map((row) => this.receiptRow(row)) };
  }
  async close() {
    this.closed = true;
    await this.ready;
    this.db?.close();
    this.db = undefined;
  }
}
