import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { ApprovalRules } from './approval-rules.js';
import { migrate } from './database.js';
import { IntegrationTools } from './integration-tools.js';
import { Integrations } from './integrations.js';
import { migrations } from './integrations-migrations.js';
import { Interactions } from './interactions.js';
import { mcpCatalog, mcpDigest } from './mcp-catalog.js';
import { privateMetadata, secureDirectory } from './private-files.js';

const save = {
  requestId: 'mock-create',
  id: 'mock-connection',
  revision: 0,
  name: '合成连接',
  endpoint: 'https://mcp.example.test/private/synthetic-path-token?key=synthetic-query-secret',
  bearer: 'synthetic-bearer-secret',
};
const tools = [
  {
    name: 'synthetic_echo',
    description: '返回合成输入',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
];

test.each(['fresh', 'approval', 'oauth', 'combined'] as const)(
  '%s historical integrations state upgrades both branches once and reopens with original data',
  async (mode) => {
    const root = await secureDirectory(
      await mkdtemp(path.join(tmpdir(), 'synthetic-integration-upgrade-')),
    );
    const file = path.join(root, 'integrations.sqlite');
    const bot = 'mock-bot',
      connection = 'mock-upgrade';
    const hasApproval = mode === 'approval' || mode === 'combined';
    const hasOAuth = mode === 'oauth' || mode === 'combined';
    const catalog = mcpCatalog(connection, tools, []);
    const digest = mcpDigest(catalog);
    const rules = new ApprovalRules(path.join(root, 'rules.sqlite'));
    const decision = await rules.evaluate({
      scope: { kind: 'bot', bot },
      trigger: 'interactive',
      mode: 'ask',
      baseline: 'ask',
      allowEligible: false,
      selector: {
        kind: 'mcp',
        connection,
        configRevision: 1,
        catalogDigest: digest,
        tool: 'synthetic_echo',
        inputHash: mcpDigest({ value: 'Synthetic' }),
      },
    });
    let store: Integrations | undefined;
    try {
      if (mode !== 'fresh') {
        const old = new DatabaseSync(file);
        try {
          const selected = migrations.filter((migration) => {
            const name = migration.name ?? '';
            return (
              name.endsWith('_baseline') ||
              (hasApproval && name.endsWith('_approval-decision')) ||
              (hasOAuth && name.endsWith('_oauth'))
            );
          });
          expect(selected).toHaveLength(mode === 'combined' ? 3 : 2);
          migrate(old, selected);
          const at = '2026-01-01T00:00:00.000Z';
          old
            .prepare(
              'INSERT INTO integrations(id,revision,name,name_key,endpoint,bearer,deleted,health,catalog,digest,created,updated,owner) VALUES(?,1,?,?,?,?,0,?,?,?,?,?,?)',
            )
            .run(
              connection,
              'Synthetic upgrade',
              'synthetic upgrade',
              hasOAuth ? 'https://mcp.notion.com/mcp' : 'https://mcp.example.test/mcp',
              'synthetic-bearer',
              'ready',
              JSON.stringify(catalog),
              digest,
              at,
              at,
              bot,
            );
          old
            .prepare(
              'INSERT INTO integration_bindings(bot,connection,revision,config_revision,digest,tools,enabled) VALUES(?,?,3,1,?,?,0)',
            )
            .run(bot, connection, digest, JSON.stringify(['synthetic_echo']));
          old
            .prepare('INSERT INTO config_commands VALUES(?,?,?,1)')
            .run('mock-old-save', 'a'.repeat(64), connection);
          old
            .prepare(
              'INSERT INTO call_receipts(id,hash,semantic,bot,run,session,connection,config_revision,tool,phase,preview,result,created,updated) VALUES(?,?,?,?,?,?,?,1,?,?,?, ?,?,?)',
            )
            .run(
              'mock-old-call',
              'b'.repeat(64),
              'c'.repeat(64),
              bot,
              'mock-run',
              'mock-session',
              connection,
              'synthetic_echo',
              'settled',
              JSON.stringify({ value: 'Synthetic' }),
              JSON.stringify({
                isError: false,
                content: [{ type: 'text', text: 'Synthetic result' }],
              }),
              at,
              at,
            );
          if (hasApproval)
            old.prepare('UPDATE call_receipts SET policyDecision=?').run(JSON.stringify(decision));
          if (hasOAuth) {
            old
              .prepare("UPDATE integrations SET auth_kind='oauth',credential_epoch=1,bearer=NULL")
              .run();
            old
              .prepare(
                "INSERT INTO oauth_grants(connection,epoch,state,issuer,resource,client_id,client_secret,redirect_uri,token_endpoint,access_token,refresh_token,expires_at,scope) VALUES(?,1,'connected',?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                connection,
                'https://mcp.notion.com',
                'https://mcp.notion.com/mcp',
                'mock-client',
                'synthetic-client-secret',
                'http://127.0.0.1:45123/oauth/mock',
                'https://mcp.notion.com/token',
                'synthetic-access',
                'synthetic-refresh',
                Date.now() + 3600000,
                'default',
              );
          }
          old.exec('UPDATE integration_meta SET revision=7');
        } finally {
          old.close();
        }
      }
      let previousJournal: unknown;
      for (let open = 0; open < 2; open++) {
        store = new Integrations(file);
        await store.ready;
        expect((await store.status()).available).toBe(true);
        if (mode !== 'fresh') {
          expect(await store.read(connection, bot)).toMatchObject({
            ownerBot: bot,
            revision: 1,
            catalogDigest: digest,
          });
          expect((await store.catalogView(connection, bot)).tools).toEqual(catalog);
          expect((await store.assignments(bot)).items[0]).toMatchObject({
            revision: 3,
            enabled: false,
            tools: ['synthetic_echo'],
          });
          expect((await store.saved('mock-old-save', connection, bot)).receipt.revision).toBe(1);
          const receipt = await store.receipt(bot, 'mock-run', 'mock-old-call');
          expect(receipt).toMatchObject({
            phase: 'settled',
            preview: JSON.stringify({ value: 'Synthetic' }),
          });
          expect(receipt.policyDecision).toEqual(hasApproval ? decision : undefined);
          if (hasOAuth)
            expect(await store.oauthGrant(connection)).toMatchObject({
              epoch: 1,
              state: 'connected',
              accessToken: 'synthetic-access',
              refreshToken: 'synthetic-refresh',
              clientSecret: 'synthetic-client-secret',
              scope: 'default',
            });
          else expect((await store.privateConfig(connection)).bearer).toBe('synthetic-bearer');
        }
        await store.close();
        store = undefined;
        const audit = new DatabaseSync(file, { readOnly: true });
        try {
          const names = audit
            .prepare('SELECT name,hash FROM __drizzle_migrations ORDER BY name')
            .all();
          expect(names).toEqual(
            migrations
              .map((migration) => ({ name: migration.name, hash: migration.hash }))
              .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          );
          if (open) expect(names).toEqual(previousJournal);
          previousJournal = names;
          expect(
            audit
              .prepare('PRAGMA table_info(call_receipts)')
              .all()
              .map((column) => column.name),
          ).toContain('policyDecision');
          expect(
            audit
              .prepare('PRAGMA table_info(integrations)')
              .all()
              .map((column) => column.name),
          ).toEqual(expect.arrayContaining(['auth_kind', 'credential_epoch']));
        } finally {
          audit.close();
        }
      }
    } finally {
      await store?.close();
      await rules.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
async function fixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'synthetic-integrations-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  return {
    root,
    store,
    close: async () => {
      await store.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
const legacyTables = `CREATE TABLE integration_bindings(bot TEXT NOT NULL,connection TEXT NOT NULL,revision INTEGER NOT NULL,config_revision INTEGER NOT NULL,digest TEXT,tools TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(bot,connection));
  CREATE TABLE config_commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,connection TEXT NOT NULL,revision INTEGER NOT NULL);
  CREATE TABLE call_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,semantic TEXT NOT NULL,bot TEXT NOT NULL,run TEXT NOT NULL,session TEXT NOT NULL,connection TEXT NOT NULL,config_revision INTEGER NOT NULL,tool TEXT NOT NULL,phase TEXT NOT NULL,preview TEXT NOT NULL,result TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE INDEX receipt_owner ON call_receipts(bot,run,semantic);
  CREATE TABLE integration_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
  INSERT INTO integration_meta VALUES(1,3);`;
const legacyIntegrations = {
  1: 'CREATE TABLE integrations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,endpoint TEXT NOT NULL,bearer TEXT,deleted INTEGER NOT NULL,health TEXT NOT NULL,catalog TEXT NOT NULL,digest TEXT,checked TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);',
  2: "CREATE TABLE integrations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,endpoint TEXT NOT NULL,bearer TEXT,deleted INTEGER NOT NULL,health TEXT NOT NULL,catalog TEXT NOT NULL,digest TEXT,checked TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,owner TEXT); CREATE UNIQUE INDEX integration_owner_name ON integrations(COALESCE(owner,''),name_key);",
};
// Builds a file exactly as a pre-ORM build left it at the given user_version.
function legacyFile(file: string, version: 1 | 2, extra = '') {
  const old = new DatabaseSync(file);
  const at = '2026-01-01T00:00:00.000Z';
  old.exec(
    `${legacyIntegrations[version]} ${legacyTables} PRAGMA user_version=${version}; ${extra}`,
  );
  old
    .prepare(
      "INSERT INTO integrations(id,revision,name,name_key,endpoint,bearer,deleted,health,catalog,digest,checked,error,created,updated) VALUES(?,1,?,?,?,NULL,0,'unchecked','[]',NULL,NULL,NULL,?,?)",
    )
    .run('mock-legacy', 'Mock Legacy', 'mock legacy', 'https://mcp.example.test/mcp', at, at);
  old
    .prepare("INSERT INTO integration_bindings VALUES('mock-a',?,1,1,NULL,'[]',0)")
    .run('mock-legacy');
  old
    .prepare('INSERT INTO config_commands VALUES(?,?,?,1)')
    .run('mock-old-save', 'a'.repeat(64), 'mock-legacy');
  old
    .prepare(
      "INSERT INTO call_receipts VALUES(?,?,?,'mock-a','mock-run','mock-session','mock-legacy',1,'synthetic_echo','dispatched','{}',NULL,NULL,?,?)",
    )
    .run('mock-old-call', 'b'.repeat(64), 'c'.repeat(64), at, at);
  old.close();
}
test.each([1, 2] as const)(
  'a pre-ORM user_version %i MCP file keeps its connections, receipts and owner rules after the schema baseline',
  async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-integrations-legacy-'));
    const file = path.join(root, 'integrations.sqlite');
    legacyFile(file, version);
    let store = new Integrations(file);
    try {
      expect(await store.status()).toStrictEqual({ available: true, revision: 3 });
      expect((await store.read('mock-legacy')).name).toBe('Mock Legacy');
      expect((await store.saved('mock-old-save', 'mock-legacy')).receipt.revision).toBe(1);
      expect((await store.receipt('mock-a', 'mock-run', 'mock-old-call')).phase).toBe('unknown');
      expect((await store.assignments('mock-a')).items[0].revision).toBe(1);
      const renamed = await store.save({
        requestId: 'mock-rename',
        id: 'mock-legacy',
        revision: 1,
        name: 'Mock Shared',
      });
      expect(renamed.current.revision).toBe(2);
      await expect(
        store.save({ ...save, requestId: 'mock-duplicate', name: 'mock shared' }),
      ).rejects.toMatchObject({ code: 'MCP_NAME_CONFLICT' });
      const owned = await store.save({ ...save, name: 'Mock Shared' }, 'mock-a');
      expect(owned.current.ownerBot).toBe('mock-a');
      await store.close();
      store = new Integrations(file);
      expect((await store.status()).revision).toBe(5);
      expect((await store.list(false, 'mock-a')).items.map((item) => item.id).sort()).toStrictEqual(
        [save.id, 'mock-legacy'],
      );
      expect((await store.list()).items.map((item) => item.id)).toStrictEqual(['mock-legacy']);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test('pre-ORM MCP files the old schema checks rejected remain unavailable and unconverted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-integrations-rejected-'));
  try {
    const cases: [string, (file: string) => unknown][] = [
      ['newer', (file) => legacyFile(file, 2, 'PRAGMA user_version=3;')],
      ['extra', (file) => legacyFile(file, 1, 'CREATE TABLE mock_extra(id TEXT);')],
      ['meta', (file) => legacyFile(file, 2, 'DELETE FROM integration_meta;')],
      [
        'unversioned',
        (file) => {
          const old = new DatabaseSync(file);
          old.exec('CREATE TABLE mock_other(id TEXT);');
          old.close();
        },
      ],
    ];
    for (const [name, build] of cases) {
      const file = path.join(root, `${name}.sqlite`);
      build(file);
      const store = new Integrations(file);
      expect((await store.status()).available).toBe(false);
      await store.close();
      const check = new DatabaseSync(file);
      expect(
        check.prepare("SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'").get(),
      ).toBe(undefined);
      check.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('a migrated MCP file cannot recreate missing revision authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-integrations-authority-'));
  const file = path.join(root, 'integrations.sqlite');
  let store = new Integrations(file);
  try {
    await store.save(save);
    expect(await store.status()).toStrictEqual({ available: true, revision: 1 });
    await store.close();
    const corrupt = new DatabaseSync(file);
    corrupt.exec('DELETE FROM integration_meta');
    corrupt.close();

    store = new Integrations(file);
    expect(await store.status()).toStrictEqual({
      available: false,
      error: 'MCP_STORE_UNAVAILABLE',
    });
    await expect(store.read(save.id)).rejects.toMatchObject({ code: 'MCP_STORE_UNAVAILABLE' });
    await expect(store.save(save)).rejects.toMatchObject({ code: 'MCP_STORE_UNAVAILABLE' });
    await store.close();

    const inspect = new DatabaseSync(file, { readOnly: true });
    try {
      expect(inspect.prepare('SELECT COUNT(*) AS n FROM integration_meta').get()!.n).toBe(0);
      expect(inspect.prepare('SELECT id FROM integrations').get()!.id).toBe(save.id);
      expect(inspect.prepare('SELECT id FROM config_commands').get()!.id).toBe(save.requestId);
    } finally {
      inspect.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('private MCP settings never echo endpoint parameters or credentials; exact save retries are read-only and stale edits preserve the new config', async () => {
  const f = await fixture();
  try {
    const first = await f.store.save(save);
    expect(first.current.origin).toBe('https://mcp.example.test');
    expect(first.current.credentialConfigured).toBe(true);
    expect(first.current.revision).toBe(1);
    expect(JSON.stringify(first).includes('synthetic-query-secret')).toBe(false);
    expect(JSON.stringify(first).includes('synthetic-bearer-secret')).toBe(false);
    expect(JSON.stringify(first).includes('synthetic-path-token')).toBe(false);
    expect(await f.store.save(save)).toStrictEqual(first);
    await expect(f.store.save({ ...save, name: 'changed same operation' })).rejects.toMatchObject({
      code: 'MCP_REQUEST_ID_REUSED',
    });
    const renamed = await f.store.save({
      requestId: 'mock-rename',
      id: save.id,
      revision: 1,
      name: '新的合成名称',
    });
    expect(renamed.current.revision).toBe(2);
    expect((await f.store.privateConfig(save.id)).bearer).toBe(save.bearer);
    expect((await f.store.privateConfig(save.id)).endpoint).toBe(save.endpoint);
    await expect(
      f.store.save({
        requestId: 'mock-stale',
        id: save.id,
        revision: 1,
        name: '过时名称',
        bearer: 'synthetic-stale-secret',
      }),
    ).rejects.toMatchObject({ code: 'MCP_CONFLICT' });
    expect((await f.store.privateConfig(save.id)).bearer).toBe(save.bearer);
    await f.store.save({
      requestId: 'mock-clear',
      id: save.id,
      revision: 2,
      name: '新的合成名称',
      bearer: null,
    });
    expect((await f.store.privateConfig(save.id)).bearer).toBe(undefined);
    const file = path.join(f.root, 'integrations.sqlite');
    expect(await privateMetadata(file, await stat(file), 0o600)).toBe(true);
  } finally {
    await f.close();
  }
});
test('only reviewed catalogs can enable selected tools for a Bot, and catalog changes or recycle never silently restore authority', async () => {
  const f = await fixture();
  try {
    await f.store.save(save);
    const catalog = await f.store.catalog(save.id, 1, tools);
    expect(catalog.current.health).toBe('ready');
    expect(catalog.tools.length).toBe(1);
    expect(catalog.tools[0].alias).toMatch(/^ext_[a-f0-9]{20}$/);
    expect((await f.store.capture('mock-a')).connections.length).toBe(0);
    const binding = {
      connection: save.id,
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: catalog.current.catalogDigest!,
      tools: ['synthetic_echo'],
      enabled: true,
    };
    await f.store.bind('mock-a', binding);
    const captured = await f.store.capture('mock-a');
    expect(captured.connections[0].tools[0].name).toBe('synthetic_echo');
    expect((await f.store.capture('mock-b')).connections.length).toBe(0);
    await expect(
      f.store.bind('mock-b', { ...binding, tools: ['not_reviewed'] }),
    ).rejects.toMatchObject({
      code: 'MCP_TOOL_NOT_FOUND',
    });
    await expect(f.store.bind('mock-a', { ...binding, enabled: false })).rejects.toMatchObject({
      code: 'MCP_BINDING_CONFLICT',
    });
    await f.store.catalog(save.id, 1, [{ ...tools[0], description: '更新后的合成目录' }]);
    expect((await f.store.capture('mock-a')).connections.length).toBe(0);
    expect((await f.store.capture('mock-a')).warnings.length).toBe(1);
    expect(captured.connections[0].tools[0].description).toBe('返回合成输入');
    const archived = await f.store.archive(save.id, 1);
    expect(archived.deleted).toBe(true);
    const restored = await f.store.restore(save.id, archived.revision);
    expect(restored.deleted).toBe(false);
    expect((await f.store.assignments('mock-a')).items[0].enabled).toBe(false);
    expect((await f.store.capture('mock-a')).connections.length).toBe(0);
  } finally {
    await f.close();
  }
});

test.each([64, 77])(
  'a %i-tool candidate catalog reopens intact without automatically exposing more than the 32 explicitly bound tools',
  async (count) => {
    const f = await fixture();
    let reopened: Integrations | undefined;
    try {
      await f.store.save(save, 'mock-a');
      const input = Array.from({ length: count }, (_, index) => ({
        ...tools[0],
        name: `synthetic_capacity_${index}`,
      }));
      const catalog = await f.store.catalog(save.id, 1, input);
      expect(catalog.current.toolCount).toBe(count);
      expect((await f.store.capture('mock-a')).connections).toEqual([]);
      const selected = input.slice(0, 32).map((entry) => entry.name);
      await f.store.bind('mock-a', {
        connection: save.id,
        configRevision: 1,
        bindingRevision: 0,
        catalogDigest: catalog.current.catalogDigest,
        tools: selected,
        enabled: true,
      });
      expect((await f.store.capture('mock-a')).connections[0].tools).toHaveLength(32);
      await f.store.close();
      reopened = new Integrations(f.store.file);
      await reopened.ready;
      expect((await reopened.list(false, 'mock-a')).items[0].toolCount).toBe(count);
      expect((await reopened.catalogView(save.id, 'mock-a')).tools).toEqual(catalog.tools);
      const restored = await reopened.capture('mock-a');
      expect(restored.connections[0].tools.map((entry) => entry.name)).toEqual(
        [...selected].sort(),
      );
      await expect(
        reopened.bind('mock-a', {
          connection: save.id,
          configRevision: 1,
          bindingRevision: 1,
          catalogDigest: catalog.current.catalogDigest,
          tools: [...selected, input[32].name],
          enabled: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MCP_BINDING' });
      expect((await reopened.capture('mock-a')).connections).toEqual(restored.connections);
    } finally {
      await reopened?.close();
      await f.close();
    }
  },
);

test('the existing 32-tool selection budget remains global to a Bot across multiple reviewed bindings', async () => {
  const f = await fixture();
  try {
    for (const suffix of ['first', 'second']) {
      const id = `mock-${suffix}`;
      await f.store.save(
        { ...save, id, requestId: `mock-save-${suffix}`, name: `Synthetic ${suffix}` },
        'mock-a',
      );
      const definitions = Array.from({ length: 32 }, (_, index) => ({
        ...tools[0],
        name: `synthetic_${suffix}_${index}`,
      }));
      const catalog = await f.store.catalog(id, 1, definitions);
      await f.store.bind('mock-a', {
        connection: id,
        configRevision: 1,
        bindingRevision: 0,
        catalogDigest: catalog.current.catalogDigest,
        tools: definitions.slice(0, 16).map((entry) => entry.name),
        enabled: true,
      });
    }
    const captured = await f.store.capture('mock-a');
    expect(captured.connections).toHaveLength(2);
    expect(captured.connections.every((entry) => entry.tools.length === 16)).toBe(true);
    expect(captured.connections.flatMap((entry) => entry.tools)).toHaveLength(32);
    const second = (await f.store.catalogView('mock-second', 'mock-a')).current;
    await expect(
      f.store.bind('mock-a', {
        connection: second.id,
        configRevision: second.revision,
        bindingRevision: 1,
        catalogDigest: second.catalogDigest,
        tools: Array.from({ length: 17 }, (_, index) => `synthetic_second_${index}`),
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'MCP_TOOL_LIMIT' });
    expect((await f.store.capture('mock-a')).connections).toEqual(captured.connections);
  } finally {
    await f.close();
  }
});

test('binding admission totals enabled connections, releases replaced selections, and keeps other Bots independent', async () => {
  const f = await fixture();
  const interactions = new Interactions(path.join(f.root, 'synthetic-budget-interactions'));
  const service = new IntegrationTools(f.store, interactions);
  await interactions.ready;
  try {
    const catalogs = new Map<string, Awaited<ReturnType<Integrations['catalog']>>>();
    for (const [id, bot] of [
      ['mock-budget-a', 'mock-a'],
      ['mock-budget-b', 'mock-a'],
      ['mock-budget-c', 'mock-b'],
    ]) {
      await f.store.save({ ...save, id, requestId: `save-${id}`, name: `Synthetic ${id}` }, bot);
      catalogs.set(
        id,
        await f.store.catalog(
          id,
          1,
          Array.from({ length: 32 }, (_, index) => ({ ...tools[0], name: `synthetic_${index}` })),
        ),
      );
    }
    const input = (id: string, revision: number, count: number, enabled = true) => ({
      connection: id,
      configRevision: 1,
      bindingRevision: revision,
      catalogDigest: catalogs.get(id)!.current.catalogDigest,
      tools: Array.from({ length: count }, (_, index) => `synthetic_${index}`),
      enabled,
    });
    await f.store.bind('mock-a', input('mock-budget-a', 0, 32));
    const before = await f.store.status();
    await expect(f.store.bind('mock-a', input('mock-budget-b', 0, 1))).rejects.toMatchObject({
      code: 'MCP_TOOL_LIMIT',
    });
    expect(await f.store.status()).toEqual(before);
    expect(
      (await f.store.assignments('mock-a')).items.find(
        (entry) => entry.connection.id === 'mock-budget-b',
      ),
    ).toMatchObject({ revision: 0, enabled: false, tools: [] });
    const offered = async (bot: string) =>
      service.list({ bot, abort: new AbortController(), integrations: await f.store.capture(bot) });
    expect(await offered('mock-a')).toHaveLength(32);
    await f.store.bind('mock-b', input('mock-budget-c', 0, 32));
    expect(await offered('mock-b')).toHaveLength(32);
    expect(await offered('mock-a')).toHaveLength(32);
    await f.store.bind('mock-a', input('mock-budget-a', 1, 16));
    await f.store.bind('mock-a', input('mock-budget-b', 0, 16));
    expect(await offered('mock-a')).toHaveLength(32);
    await f.store.bind('mock-a', input('mock-budget-a', 2, 0, false));
    await f.store.bind('mock-a', input('mock-budget-b', 1, 32));
    expect(await offered('mock-a')).toHaveLength(32);
    expect(await offered('mock-b')).toHaveLength(32);
  } finally {
    await service.close();
    await f.close();
  }
});
test('schemas cannot echo a saved credential into the public tool catalog and invalid endpoints cannot overwrite existing secrets', async () => {
  const f = await fixture();
  try {
    await f.store.save(save);
    await expect(
      f.store.catalog(save.id, 1, [{ ...tools[0], description: save.bearer }]),
    ).rejects.toMatchObject({
      code: 'MCP_SECRET_IN_CATALOG',
    });
    for (const endpoint of [
      'http://mcp.example.test/',
      'https://user:pass@mcp.example.test/',
      'https://127.0.0.1/mcp',
      'https://169.254.169.254/mcp',
      'https://mcp.example.test/#fragment',
    ])
      await expect(
        f.store.save({
          ...save,
          requestId: `mock-invalid-${Buffer.from(endpoint).toString('hex').slice(0, 30)}`,
          revision: 1,
          endpoint,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MCP_CONFIG' });
    expect((await f.store.privateConfig(save.id)).bearer).toBe(save.bearer);
  } finally {
    await f.close();
  }
});
test('MCP effect claims are scoped and exact; unknown dispatch is never replayed with another wire id in the same run', async () => {
  const f = await fixture();
  try {
    await f.store.save(save);
    const input = {
      id: 'mock-call',
      bot: 'mock-a',
      run: 'mock-run',
      session: 'mock-session',
      connection: save.id,
      configRevision: 1,
      tool: 'synthetic_echo',
      arguments: { value: 'synthetic' },
      preview: '{"value":"synthetic"}',
    };
    expect((await f.store.claim(input)).fresh).toBe(true);
    expect((await f.store.claim(input)).fresh).toBe(false);
    await expect(
      f.store.claim({ ...input, arguments: { value: 'changed' } }),
    ).rejects.toMatchObject({
      code: 'MCP_REQUEST_ID_REUSED',
    });
    await f.store.dispatched(input.id);
    await f.store.finish(input.id, { phase: 'unknown', error: 'MCP_OUTCOME_UNKNOWN' });
    await expect(f.store.claim({ ...input, id: 'mock-retry-new-id' })).rejects.toMatchObject({
      code: 'MCP_OUTCOME_UNKNOWN',
    });
    expect((await f.store.claim({ ...input, id: 'mock-b-call', bot: 'mock-b' })).fresh).toBe(true);
    const exact = await f.store.receipt('mock-a', 'mock-run', input.id);
    expect(exact.phase).toBe('unknown');
    await expect(f.store.receipt('mock-b', 'mock-run', input.id)).rejects.toMatchObject({
      code: 'MCP_REQUEST_NOT_FOUND',
    });
  } finally {
    await f.close();
  }
});
test('restart retains uncertain MCP effects and a corrupt database is never re-created or treated as a valid empty configuration', async () => {
  const f = await fixture();
  let store = f.store;
  try {
    await store.save(save);
    await store.claim({
      id: 'mock-interrupted',
      bot: 'mock-a',
      run: 'mock-run',
      session: 'mock-session',
      connection: save.id,
      configRevision: 1,
      tool: 'synthetic_echo',
      arguments: {},
      preview: '{}',
    });
    await store.dispatched('mock-interrupted');
    await store.close();
    store = new Integrations(path.join(f.root, 'integrations.sqlite'));
    expect((await store.receipt('mock-a', 'mock-run', 'mock-interrupted')).phase).toBe('unknown');
    await store.close();
    const raw = Buffer.from('SYNTHETIC-CORRUPT-INTEGRATIONS');
    await writeFile(path.join(f.root, 'integrations.sqlite'), raw, { mode: 0o600 });
    store = new Integrations(path.join(f.root, 'integrations.sqlite'));
    expect((await store.status()).available).toBe(false);
    expect((await store.capture('mock-a')).available).toBe(false);
    expect(await readFile(path.join(f.root, 'integrations.sqlite'))).toStrictEqual(raw);
  } finally {
    await store.close();
    await f.close();
  }
});

test('catalog privacy checks include JSON-escaped secret values', async () => {
  const f = await fixture();
  try {
    const bearer = 'synthetic"quoted\\credential';
    await f.store.save({ ...save, bearer });
    await expect(
      f.store.catalog(save.id, 1, [{ ...tools[0], description: `echo ${bearer}` }]),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_IN_CATALOG' });
    expect((await f.store.read(save.id)).toolCount).toBe(0);
  } finally {
    await f.close();
  }
});

test('changing connection configuration fences the captured tool session before the Bot binding is reviewed again', async () => {
  const f = await fixture();
  try {
    await f.store.save(save);
    const catalog = await f.store.catalog(save.id, 1, tools);
    await f.store.bind('mock-a', {
      connection: save.id,
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: catalog.current.catalogDigest!,
      tools: [tools[0].name],
      enabled: true,
    });
    const before = await f.store.capture('mock-a');
    await f.store.save({
      ...save,
      requestId: 'mock-changed-config',
      revision: 1,
      name: '合成修改连接',
    });
    const changed = await f.store.capture('mock-a');
    expect(changed.connections.length).toBe(0);
    expect(changed.key).not.toBe(before.key);
    expect(before.connections.length).toBe(1);
  } finally {
    await f.close();
  }
});

test('a failed change observer cannot turn a committed configuration into a failed save', async () => {
  const f = await fixture();
  const original = console.error;
  const notices: unknown[][] = [];
  console.error = (...args) => {
    notices.push(args);
  };
  try {
    f.store.onChange = () => {
      throw new Error('synthetic observer failure');
    };
    const first = await f.store.save(save);
    expect(first.receipt.revision).toBe(1);
    f.store.onChange = async () => {
      throw new Error('synthetic async failure');
    };
    const next = await f.store.save({
      ...save,
      requestId: 'mock-observer-edit',
      revision: 1,
      name: '合成新名称',
    });
    expect(next.current.revision).toBe(2);
    expect(notices.length).toBe(2);
    expect(JSON.stringify(notices).includes(save.bearer)).toBe(false);
  } finally {
    console.error = original;
    await f.close();
  }
});

test('call history stays bounded, omits result bodies and isolates each Bot and connection', async () => {
  const f = await fixture();
  try {
    await f.store.save(save);
    for (let index = 0; index < 25; index++) {
      const id = `mock-history-${String(index).padStart(2, '0')}`;
      await f.store.claim({
        id,
        bot: 'mock-a',
        run: 'mock-history-run',
        session: 'mock-history-session',
        connection: save.id,
        configRevision: 1,
        tool: 'synthetic_echo',
        arguments: { value: index },
        preview: JSON.stringify({ value: '合成'.repeat(2000) }),
      });
      await f.store.finish(id, { phase: 'settled', result: 'SYNTHETIC-RESULT-BODY' });
    }
    const history = await f.store.calls('mock-a', save.id);
    expect(history.bot).toBe('mock-a');
    expect(history.items.length).toBe(20);
    expect(history.items[0].id).toBe('mock-history-24');
    expect.assert(
      history.items.every((item) => item.preview.length <= 1400 && item.result === undefined),
    );
    expect((await f.store.calls('mock-b', save.id)).items.length).toBe(0);
    expect((await f.store.calls('mock-a', 'mock-other-connection')).items.length).toBe(0);
    expect((await f.store.receipt('mock-a', 'mock-history-run', 'mock-history-00')).result).toBe(
      'SYNTHETIC-RESULT-BODY',
    );
  } finally {
    await f.close();
  }
});
