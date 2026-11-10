import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AppCommand,
  appProviders,
  appReceiptMatches,
  isAppAuthorizeUrl,
  isAppCatalog,
  isAppDirectory,
  isAppOAuthReceipt,
  isMcpList,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';
import { secureDirectory } from './private-files.js';

test('Host app reads are public metadata while OAuth mutations require independent interactive authority', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-oa-'));
  const root = await secureDirectory(path.join(temporary, 'p'));
  const scope = createHash('sha256').update(root).digest('hex');
  const socketPath =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
      : path.join(root, 's');
  const app = await startNativeAgent({
    dataRoot: root,
    nativeWorkspace: path.join(root, 'workspace'),
    socketPath,
    scope,
    sdkFile: fileURLToPath(import.meta.url),
  });
  const token = (await readFile(path.join(root, 'model/control-token'), 'utf8')).trim();
  const tls = await privateClientOptions(path.join(root, 'model/control-certificate.pem'));
  const call = (
    route: string,
    command?: object,
    interactive?: string,
    extraHeaders: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
      const request = (process.platform === 'win32' ? https : http)(
        {
          ...tls,
          socketPath,
          path: route,
          method: command ? 'POST' : 'GET',
          headers: {
            host: '127.0.0.1:8766',
            'x-prototype-token': token,
            'content-type': 'application/json',
            'x-daban-mcp-view': 'apps',
            ...extraHeaders,
            ...(interactive ? { 'x-daban-app-control': interactive } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(command ? JSON.stringify(command) : undefined);
    });
  try {
    await app.models.profiles.register({
      id: 'mock-a',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    expect((await call('/api/state')).value.appWorkspace).toBe(true);
    expect((await call('/api/state')).value.appConnections).toEqual({
      catalog: true,
      oauthLoopback: true,
    });
    const catalog = await call('/api/mcp/app', { type: 'app.catalog', bot: 'mock-a' });
    expect(catalog.status).toBe(200);
    expect(catalog.value.attempts).toEqual([]);
    expect(JSON.stringify(catalog.value)).not.toMatch(/token|secret|authorize/);
    const input = {
      app: 'notion',
      name: 'Synthetic Notion',
      bot: 'mock-a',
      connection: 'mock-notion',
      revision: 0,
      requestId: 'mock-start',
    };
    const blocked = await call('/api/mcp/app', { type: 'app.oauth.start', input });
    expect(blocked.status).toBe(403);
    expect(blocked.value.error).toBe('OAUTH_INTERACTIVE_REQUIRED');
    expect(
      (await call('/api/mcp/app', { type: 'app.oauth.start', input, local: true }, token)).status,
    ).toBe(400);
    const key = (await readFile(path.join(root, 'model/app-control-token'), 'utf8')).trim();
    expect(key).not.toBe(token);
    expect(
      (
        await call(
          '/api/mcp/app',
          {
            type: 'app.disconnect',
            target: { bot: 'mock-a', connection: 'mock-notion', revision: 1 },
            requestId: 'mock-disconnect',
          },
          token,
        )
      ).status,
    ).toBe(403);
    expect((await app.models.integrations.list(false, 'mock-a')).items).toEqual([]);
    const store = app.models.integrations;
    const target = { bot: 'mock-a', connection: 'mock-notion', revision: 0 };
    const attempt = await store.beginOAuth({ ...input, app: 'notion' }, Date.now() + 600000);
    await store.oauthPhase(target, attempt.attempt, 'waiting');
    await store.oauthPhase(target, attempt.attempt, 'exchanging');
    await store.oauthCommit(target, attempt.attempt, {
      issuer: 'https://mcp.notion.com',
      resource: 'https://mcp.notion.com/mcp',
      tokenEndpoint: 'https://mcp.notion.com/token',
      clientId: 'mock-client',
      redirectUri: 'http://127.0.0.1:45123/oauth/mock',
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      scope: 'default',
      expiresAt: Date.now() + 3600000,
    });
    const archive = { type: 'mcp.archive', bot: target.bot, id: target.connection, revision: 1 };
    expect((await call('/api/mcp/archive', archive)).status).toBe(403);
    expect((await store.read(target.connection, target.bot)).deleted).toBe(false);
    expect((await call('/api/mcp/archive', archive, key)).status).toBe(200);
    const counts = new Map<string, number>();
    const challenges = new Map<string, string>();
    app.models.oauth.options.request = async (url, body) => {
      const provider = appProviders.find((entry) =>
        [entry.resourceMetadata, entry.metadata, entry.register, entry.token].includes(url),
      );
      if (!provider) throw Error('SYNTHETIC_ENDPOINT_ONLY');
      if (url === provider.resourceMetadata)
        return {
          status: 200,
          data: { resource: provider.resource, authorization_servers: [provider.issuer] },
        };
      if (url === provider.metadata)
        return {
          status: 200,
          data: {
            issuer: provider.issuer,
            authorization_endpoint: provider.authorize,
            token_endpoint: provider.token,
            registration_endpoint: provider.register,
            code_challenge_methods_supported: ['S256'],
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
          },
        };
      if (url === provider.register) {
        counts.set(provider.id, (counts.get(provider.id) ?? 0) + 1);
        return {
          status: 201,
          data: {
            client_id: `mock-${provider.id}`,
            token_endpoint_auth_method: provider.clientAuthentication,
            ...(provider.clientAuthentication === 'client_secret_post'
              ? { client_secret: 'synthetic-client-secret' }
              : {}),
          },
        };
      }
      if (!(body instanceof URLSearchParams)) throw Error('SYNTHETIC_FORM_REQUIRED');
      expect(body.get('resource')).toBe(provider.resource);
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
        challenges.get(provider.id),
      );
      return {
        status: 200,
        data: {
          access_token: `synthetic-${provider.id}-access`,
          refresh_token: `synthetic-${provider.id}-refresh`,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: provider.scope,
        },
      };
    };
    const invoke = async (command: AppCommand, proof?: string) => {
      const response = await call(
        ['app.directory', 'app.oauth.connect'].includes(command.type)
          ? '/api/mcp/apps'
          : '/api/mcp/app',
        command,
        proof,
      );
      if (response.status !== 200) throw Error(String(response.value.error));
      return response.value;
    };
    expect((await call('/api/mcp/apps')).value).toEqual({ protocol: 'app-directory-v2' });
    const providers = appProviders.filter((entry) => entry.id !== 'notion');
    const connects = providers.map(
      (provider): AppCommand => ({
        type: 'app.oauth.connect',
        input: {
          app: provider.id,
          ...(provider.id === 'sentry' ? {} : { bot: 'mock-a' }),
          connection: `mock-${provider.id}`,
          revision: 0,
          requestId: `mock-${provider.id}-start`,
          name: `Synthetic ${provider.id}`,
        },
      }),
    );
    for (const command of connects) {
      expect((await call('/api/mcp/app', command, key)).status).toBe(400);
      expect((await call('/api/mcp/apps', command)).status).toBe(403);
      await expect(invoke(command)).rejects.toThrow('OAUTH_INTERACTIVE_REQUIRED');
    }
    expect(counts.size).toBe(0);
    const replies = await Promise.all(
      connects.map(async (command) => {
        if (command.type !== 'app.oauth.connect') throw Error('SYNTHETIC_CONNECT_REQUIRED');
        const value = await invoke(command, key);
        const receipt = value.receipt;
        if (
          !isAppOAuthReceipt(receipt) ||
          !appReceiptMatches(receipt, command.input) ||
          receipt.requestId !== command.input.requestId
        )
          throw Error('SYNTHETIC_RECEIPT_MISMATCH');
        const authorize = value.authorize;
        if (
          !authorize ||
          typeof authorize !== 'object' ||
          !('url' in authorize) ||
          typeof authorize.url !== 'string' ||
          !('expiresAt' in authorize) ||
          typeof authorize.expiresAt !== 'number'
        )
          throw Error('SYNTHETIC_AUTHORIZATION_MISSING');
        expect(isAppAuthorizeUrl(authorize.url, command.input.app)).toBe(true);
        expect(authorize.expiresAt).toBeGreaterThan(Date.now());
        return { receipt, authorize: { url: authorize.url, expiresAt: authorize.expiresAt } };
      }),
    );
    expect(await invoke({ type: 'app.directory', bot: 'mock-a' })).toMatchObject({
      connections: [],
      attemptsMore: false,
    });
    await Promise.all(
      replies.map(async (reply, index) => {
        const provider = providers[index];
        expect(reply.receipt.phase).toBe('waiting');
        const url = new URL(reply.authorize!.url);
        challenges.set(provider.id, url.searchParams.get('code_challenge')!);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', 'synthetic-code');
        if (provider.issuerRequired) callback.searchParams.set('iss', provider.issuer);
        expect((await fetch(callback)).status).toBe(200);
      }),
    );
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1]);
    const workspace = await invoke({ type: 'app.directory' });
    expect(isAppDirectory(workspace)).toBe(true);
    expect(workspace).not.toHaveProperty('bot');
    expect(workspace.connections).toHaveLength(providers.length);
    expect(workspace.connections).toContainEqual(
      expect.objectContaining({ app: 'linear', ownerBot: 'mock-a' }),
    );
    if (!isAppDirectory(workspace)) throw Error('SYNTHETIC_INVALID_DIRECTORY');
    expect(workspace.connections.find((row) => row.app === 'sentry')).not.toHaveProperty(
      'ownerBot',
    );
    const settings = await call('/api/mcp/list', { type: 'mcp.list', allOwners: true });
    expect(isMcpList(settings.value)).toBe(true);
    expect(settings.value.items).toContainEqual(
      expect.objectContaining({ id: 'mock-linear', ownerBot: 'mock-a', boundBots: [] }),
    );
    expect(settings.value.items).toContainEqual(
      expect.objectContaining({ id: 'mock-sentry', boundBots: [] }),
    );
    const directory = await invoke({ type: 'app.directory', bot: 'mock-a' });
    expect(directory).toMatchObject({
      connections: expect.arrayContaining(
        providers
          .filter((provider) => provider.id !== 'sentry')
          .map((provider) =>
            expect.objectContaining({ app: provider.id, state: 'connected', revision: 1 }),
          ),
      ),
    });
    expect(directory.connections).toHaveLength(providers.length - 1);
    expect(JSON.stringify(workspace)).not.toMatch(
      /synthetic-.*-(access|refresh)|clientId|clientSecret|authorize/,
    );
    const legacy = await invoke({ type: 'app.catalog', bot: 'mock-a' });
    expect(isAppCatalog(legacy)).toBe(true);
    expect((legacy as { connections: unknown[] }).connections).toEqual([]);
    expect((legacy as { apps: unknown[] }).apps).toHaveLength(2);
    await invoke(
      {
        type: 'app.disconnect',
        target: { bot: 'mock-a', connection: 'mock-miro', revision: 1 },
        requestId: 'mock-miro-disconnect',
      },
      key,
    );
    expect(
      await store.oauthRegistration(
        { bot: 'mock-a', connection: 'mock-miro', revision: 0 },
        'miro',
      ),
    ).toBeUndefined();
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
