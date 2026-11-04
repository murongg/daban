import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const call = (route: string, command?: object, interactive?: string) =>
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
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
