import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { Integrations, type OAuthGrant } from './integrations.js';
import { secureDirectory } from './private-files.js';

const input = {
  bot: 'mock-a',
  connection: 'mock-notion',
  revision: 0,
  requestId: 'mock-start',
  app: 'notion',
  name: 'Synthetic App',
} as const;
const target = { bot: input.bot, connection: input.connection, revision: 0 };
const grant: OAuthGrant = {
  issuer: 'https://mcp.notion.com',
  resource: 'https://mcp.notion.com/mcp',
  clientId: 'mock-client',
  clientSecret: 'synthetic-client-secret',
  redirectUri: 'http://127.0.0.1:45123/callback/mock',
  tokenEndpoint: 'https://mcp.notion.com/token',
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  expiresAt: Date.now() + 600000,
  scope: 'default',
};
test('OAuth reservations deduplicate starts, isolate owners, and create no placeholder connection', async () => {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-store-')));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  try {
    const first = await store.beginOAuth(input, Date.now() + 600000);
    expect(await store.beginOAuth(input, Date.now() + 500000)).toEqual(first);
    expect((await store.list(false, input.bot)).items).toEqual([]);
    expect(await store.pendingOAuth('mock-b')).toEqual([]);
    expect((await store.pendingOAuth(input.bot))[0].input).toEqual(input);
    await expect(
      store.beginOAuth({ ...input, name: 'Other' }, Date.now() + 600000),
    ).rejects.toMatchObject({ code: 'OAUTH_REQUEST_ID_REUSED' });
    await expect(
      store.oauthAttempt({ ...target, bot: 'mock-b' }, first.attempt),
    ).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_NOT_FOUND' });
    await expect(
      store.save(
        {
          requestId: 'mock-save',
          id: 'mock-other',
          revision: 0,
          name: input.name,
          endpoint: 'https://mcp.example.test/mcp',
        },
        input.bot,
      ),
    ).rejects.toMatchObject({ code: 'MCP_NAME_CONFLICT' });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('OAuth transactions survive restart as interrupted without recreating registrations or accepting late tokens', async () => {
  const root = await secureDirectory(
    await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-restart-')),
  );
  const file = path.join(root, 'integrations.sqlite');
  let store = new Integrations(file);
  try {
    const first = await store.beginOAuth(input, Date.now() + 600000);
    await store.close();
    store = new Integrations(file);
    expect((await store.oauthAttempt(target, first.attempt)).phase).toBe('interrupted');
    expect((await store.beginOAuth(input, Date.now() + 600000)).phase).toBe('interrupted');
    await expect(store.oauthCommit(target, first.attempt, grant)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_INACTIVE',
    });
    expect((await store.list(false, input.bot)).items).toEqual([]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('grant commit preserves old public contracts, fences Bearer edits and disconnect revokes captured authority', async () => {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-commit-')));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  try {
    const operation = await store.beginOAuth(input, Date.now() + 600000);
    await store.oauthPhase(target, operation.attempt, 'waiting');
    await store.oauthPhase(target, operation.attempt, 'exchanging');
    expect((await store.oauthCommit(target, operation.attempt, grant)).revision).toBe(0);
    const current = await store.read(input.connection, input.bot);
    expect(current.credentialConfigured).toBe(true);
    expect(JSON.stringify(current)).not.toMatch(
      /synthetic-access|synthetic-refresh|clientSecret|authKind/,
    );
    await expect(
      store.save(
        { requestId: 'mock-old-save', id: current.id, revision: 1, name: current.name },
        input.bot,
      ),
    ).rejects.toMatchObject({ code: 'OAUTH_MANAGED_CONNECTION' });
    const catalog = await store.catalog(current.id, 1, [
      { name: 'synthetic_echo', inputSchema: { type: 'object' } },
    ]);
    await store.bind(input.bot, {
      connection: current.id,
      configRevision: 1,
      bindingRevision: 0,
      enabled: true,
      tools: ['synthetic_echo'],
      catalogDigest: catalog.current.catalogDigest,
    });
    const captured = (await store.capture(input.bot)).connections[0];
    await store.oauthRefreshBegin(current.id, 1);
    expect((await store.capture(input.bot)).connections).toHaveLength(1);
    expect((await store.assignments(input.bot)).items[0].available).toBe(true);
    await store.oauthRefreshCommit(current.id, 1, {
      ...grant,
      accessToken: 'synthetic-new-access',
      refreshToken: 'synthetic-new-refresh',
    });
    expect((await store.read(current.id, input.bot)).revision).toBe(1);
    expect((await store.assertLive(input.bot, captured, 'synthetic_echo')).bearer).toBe(
      'synthetic-new-access',
    );
    const disconnectTarget = { ...target, revision: 1 };
    const receipt = await store.disconnectOAuth(disconnectTarget, 'mock-disconnect');
    expect(await store.disconnectOAuth(disconnectTarget, 'mock-disconnect')).toEqual(receipt);
    await expect(store.assertLive(input.bot, captured, 'synthetic_echo')).rejects.toMatchObject({
      code: 'MCP_AUTHORITY_CHANGED',
    });
    expect((await store.oauthGrant(current.id))?.accessToken).toBe('');
    expect((await store.oauthGrant(current.id))?.clientSecret).toBe(null);
    expect((await store.oauthStates(input.bot))[0].state).toBe('disconnected');
    expect((await store.assignments(input.bot)).items[0].available).toBe(false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['disconnect', 'archive', 'revoke'] as const)(
  'a concurrent %s fences an older refresh without restoring credentials or rolling back its epoch',
  async (action) => {
    const root = await secureDirectory(
      await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-refresh-fence-')),
    );
    const file = path.join(root, 'integrations.sqlite');
    let store = new Integrations(file);
    try {
      const operation = await store.beginOAuth(input, Date.now() + 600000);
      await store.oauthPhase(target, operation.attempt, 'waiting');
      await store.oauthPhase(target, operation.attempt, 'exchanging');
      await store.oauthCommit(target, operation.attempt, grant);
      await store.oauthRefreshBegin(input.connection, 1);
      const tokens = {
        accessToken: 'synthetic-rotated-access',
        refreshToken: 'synthetic-rotated-refresh',
        expiresAt: Date.now() + 600000,
        scope: grant.scope,
      };
      const refreshing = store.oauthRefreshCommit(input.connection, 1, tokens);
      // This normal yield exposed a grant read that could outlive disconnect or revocation.
      await Promise.resolve();
      const revoking =
        action === 'disconnect'
          ? store.disconnectOAuth({ ...target, revision: 1 }, 'mock-disconnect')
          : action === 'archive'
            ? store.archive(input.connection, 1, input.bot)
            : store.oauthReconnectRequired(input.connection, 1);
      const outcomes = await Promise.allSettled([refreshing, revoking]);
      expect(outcomes[1].status).toBe('fulfilled');
      const expectedState = action === 'revoke' ? 'reconnect-required' : 'disconnected';
      const expectedEpoch = action === 'revoke' ? 1 : 2;
      const saved = await store.oauthGrant(input.connection);
      expect(saved).toMatchObject({
        state: expectedState,
        epoch: expectedEpoch,
        accessToken: '',
        refreshToken: null,
      });
      if (action !== 'revoke') expect(saved?.clientSecret).toBe(null);
      expect((await store.read(input.connection, input.bot)).revision).toBe(expectedEpoch);
      await expect(store.oauthRefreshCommit(input.connection, 1, tokens)).rejects.toMatchObject({
        code: 'OAUTH_CONFLICT',
      });
      expect(await store.oauthGrant(input.connection)).toEqual(saved);
      if (action === 'disconnect') {
        expect(
          await store.disconnectOAuth({ ...target, revision: 1 }, 'mock-disconnect'),
        ).toMatchObject({ disconnected: true, revision: 1 });
      }
      await store.close();
      store = new Integrations(file);
      expect((await store.status()).available).toBe(true);
      expect(await store.oauthGrant(input.connection)).toEqual(saved);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('archive and cancellation defeat late exchange, and OAuth secrets cannot enter catalogs', async () => {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-race-')));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  try {
    const first = await store.beginOAuth(input, Date.now() + 600000);
    await store.oauthPhase(target, first.attempt, 'cancelled');
    await expect(store.oauthCommit(target, first.attempt, grant)).rejects.toMatchObject({
      code: 'OAUTH_ATTEMPT_INACTIVE',
    });
    const second = await store.beginOAuth(
      { ...input, requestId: 'mock-second' },
      Date.now() + 600000,
    );
    await store.oauthPhase(target, second.attempt, 'waiting');
    await store.oauthPhase(target, second.attempt, 'exchanging');
    await store.oauthCommit(target, second.attempt, grant);
    await expect(
      store.catalog(input.connection, 1, [
        {
          name: 'synthetic_echo',
          description: grant.refreshToken,
          inputSchema: { type: 'object' },
        },
      ]),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_IN_CATALOG' });
    const reconnectTarget = { ...target, revision: 1 };
    const reconnect = await store.beginOAuth(
      { ...input, revision: 1, name: undefined, requestId: 'mock-reconnect' },
      Date.now() + 600000,
    );
    await store.oauthPhase(reconnectTarget, reconnect.attempt, 'waiting');
    await store.oauthPhase(reconnectTarget, reconnect.attempt, 'exchanging');
    await store.archive(input.connection, 1, input.bot);
    expect((await store.oauthGrant(input.connection))?.accessToken).toBe('');
    await expect(
      store.oauthCommit(reconnectTarget, reconnect.attempt, grant),
    ).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_INACTIVE' });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt persisted OAuth authority stays unavailable rather than forwarding credentials to another resource', async () => {
  const root = await secureDirectory(
    await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-corrupt-')),
  );
  const file = path.join(root, 'integrations.sqlite');
  let store = new Integrations(file);
  try {
    const operation = await store.beginOAuth(input, Date.now() + 600000);
    await store.oauthPhase(target, operation.attempt, 'waiting');
    await store.oauthPhase(target, operation.attempt, 'exchanging');
    await store.oauthCommit(target, operation.attempt, grant);
    await store.close();
    const corrupt = new DatabaseSync(file);
    corrupt.exec("UPDATE oauth_grants SET resource='https://evil.example.test/mcp'");
    corrupt.close();
    store = new Integrations(file);
    expect((await store.status()).available).toBe(false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace account survives reopening and gives each Bot only its own explicit tool selection', async () => {
  const root = await secureDirectory(
    await mkdtemp(path.join(tmpdir(), 'synthetic-workspace-app-')),
  );
  const file = path.join(root, 'integrations.sqlite');
  let store = new Integrations(file);
  const workspace = {
    connection: 'mock-workspace',
    revision: 0,
    requestId: 'mock-workspace-start',
    app: 'notion',
    name: 'Synthetic workspace account',
  } as const;
  try {
    await store.save(
      {
        id: 'mock-private',
        revision: 0,
        requestId: 'mock-private-save',
        name: 'Synthetic private MCP',
        endpoint: 'https://private.example.test/mcp',
      },
      'mock-a',
    );
    const attempt = await store.beginOAuth(workspace, Date.now() + 600000);
    await expect(
      store.oauthAttempt({ ...workspace, bot: input.bot }, attempt.attempt),
    ).rejects.toMatchObject({ code: 'OAUTH_ATTEMPT_NOT_FOUND' });
    const ref = { connection: workspace.connection, revision: 0 };
    await store.oauthPhase(ref, attempt.attempt, 'waiting');
    await store.oauthPhase(ref, attempt.attempt, 'exchanging');
    await store.oauthCommit(ref, attempt.attempt, grant);
    const catalog = await store.catalog(ref.connection, 1, [
      { name: 'synthetic_read', inputSchema: { type: 'object' } },
      { name: 'synthetic_list', inputSchema: { type: 'object' } },
    ]);
    for (const bot of ['mock-a', 'mock-b']) {
      expect((await store.capture(bot)).connections).toEqual([]);
      expect(
        (await store.assignments(bot)).items.find((item) => item.connection.id === ref.connection),
      ).toMatchObject({ enabled: false, tools: [] });
    }
    const selection = {
      connection: ref.connection,
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: catalog.current.catalogDigest,
      enabled: true,
      tools: ['synthetic_read'],
    };
    await store.bind('mock-a', selection);
    await store.bind('mock-b', { ...selection, tools: ['synthetic_list'] });
    await store.close();
    store = new Integrations(file);
    expect((await store.list(false, undefined, 'apps', true)).items).toEqual([
      expect.objectContaining({ id: 'mock-private', ownerBot: 'mock-a', boundBots: [] }),
      expect.objectContaining({ id: ref.connection, boundBots: ['mock-a', 'mock-b'] }),
    ]);
    expect((await store.assignments('mock-b')).items.map((item) => item.connection.id)).toEqual([
      ref.connection,
    ]);
    expect((await store.capture('mock-a')).connections[0].tools.map((tool) => tool.name)).toEqual([
      'synthetic_read',
    ]);
    expect((await store.capture('mock-b')).connections[0].tools.map((tool) => tool.name)).toEqual([
      'synthetic_list',
    ]);
    await store.bind('mock-a', { ...selection, bindingRevision: 1, enabled: false });
    expect((await store.capture('mock-a')).connections).toEqual([]);
    expect((await store.capture('mock-b')).connections).toHaveLength(1);
    await expect(
      store.disconnectOAuth({ ...ref, revision: 1, bot: 'mock-b' }, 'mock-b-disconnect'),
    ).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_MISMATCH' });
    await store.disconnectOAuth({ ...ref, revision: 1 }, 'mock-workspace-disconnect');
    expect((await store.capture('mock-b')).connections).toEqual([]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
