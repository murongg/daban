import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpCommand } from '@daban/protocol';
import { IntegrationTools } from './integration-tools.js';
import { privateClientOptions } from './private-channel.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

export async function createMcpViewFixture(count: number) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'synthetic-mcp-view-'));
  const dataRoot = await secureDirectory(path.join(temporary, 'data'));
  const scope = createHash('sha256').update(temporary).digest('hex');
  const socketPath =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
      : path.join(temporary, 's');
  const app = await startPrototype({
    host: {
      dataRoot,
      socketPath,
      scope,
      nativeWorkspace: path.join(temporary, 'workspace'),
      sdkFile: fileURLToPath(import.meta.url),
    },
  });
  try {
    const models = app.models;
    assert.ok(models);
    await models.profiles.register({
      id: 'mock-a',
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const bearer = {
      requestId: 'mock-save',
      id: 'mock-bearer',
      revision: 0,
      name: 'Synthetic Bearer',
      endpoint: 'https://mcp.example.test/mcp',
      bearer: 'synthetic-bearer',
    };
    await models.integrations.save(bearer, 'mock-a');
    const target = { bot: 'mock-a', connection: 'mock-oauth', revision: 0 };
    const attempt = await models.integrations.beginOAuth(
      { ...target, requestId: 'mock-start', app: 'notion', name: 'Synthetic OAuth' },
      Date.now() + 600000,
    );
    await models.integrations.oauthPhase(target, attempt.attempt, 'waiting');
    await models.integrations.oauthPhase(target, attempt.attempt, 'exchanging');
    await models.integrations.oauthCommit(target, attempt.attempt, {
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
    const bearerTools = [
      { name: 'synthetic_echo', description: 'Synthetic', inputSchema: { type: 'object' } },
    ];
    let offeredBearerTools = bearerTools;
    const appTools = Array.from({ length: count }, (_, index) => ({
      ...bearerTools[0],
      name: `synthetic_oauth_${index}`,
    }));
    const bearerCatalog = await models.integrations.catalog(bearer.id, 1, bearerTools);
    const appCatalog = await models.integrations.catalog(target.connection, 1, appTools);
    let authorizations = 0;
    assert.ok(models.tools.integrations);
    await models.tools.integrations.close();
    models.tools.integrations = new IntegrationTools(models.integrations, models.interactions, {
      authorization: async () => {
        authorizations++;
        return 'synthetic-access';
      },
      remote: async (config) => ({
        start: async () => {},
        tools: async () => (config.endpoint === bearer.endpoint ? offeredBearerTools : appTools),
        call: async () => {
          throw Error('SYNTHETIC_VIEW_MUST_NOT_DISPATCH');
        },
        close: async () => {},
      }),
    });
    const tls = await privateClientOptions(path.join(dataRoot, 'model/control-certificate.pem'));
    const fetcher = async (url: string, init: RequestInit = {}): Promise<Response> =>
      await new Promise<Response>((resolve, reject) => {
        const send = process.platform === 'win32' ? https : http;
        const destination = new URL(url);
        const req = send(
          {
            ...tls,
            socketPath,
            path: destination.pathname + destination.search,
            method: init.method ?? 'GET',
            signal: init.signal ?? undefined,
            headers: Object.fromEntries(new Headers(init.headers)),
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.once('error', reject);
            res.on('end', () =>
              resolve(
                new Response(new Uint8Array(Buffer.concat(chunks)), {
                  status: res.statusCode ?? 500,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
            );
          },
        );
        req.once('error', reject);
        req.end(typeof init.body === 'string' ? init.body : undefined);
      });
    const request = async (command: McpCommand, view?: string) => {
      const response = await fetcher(`${app.url}/api/mcp/${command.type.slice(4)}`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8766',
          'x-prototype-token': app.token,
          'x-daban-client-protocol': '28',
          'content-type': 'application/json',
          ...(view ? { 'x-daban-mcp-view': view } : {}),
        },
        body: JSON.stringify(command),
      });
      const value: unknown = await response.json();
      return { status: response.status, value };
    };
    return {
      app,
      models,
      bearer,
      target,
      bearerCatalog,
      appCatalog,
      request,
      fetcher,
      authorizations: () => authorizations,
      setBearerCount: (size: number) => {
        offeredBearerTools = Array.from({ length: size }, (_, index) => ({
          ...bearerTools[0],
          name: `synthetic_bearer_${index}`,
        }));
      },
      close: async () => {
        await app.close();
        await rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
