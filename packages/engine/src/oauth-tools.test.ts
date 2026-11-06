import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { IntegrationTools } from './integration-tools.js';
import { Integrations } from './integrations.js';
import { Interactions } from './interactions.js';
import { secureDirectory } from './private-files.js';

test('OAuth credentials are resolved before probing while snapshots never gain secrets or tool authority', async () => {
  const root = await secureDirectory(await mkdtemp(path.join(tmpdir(), 'mock-oauth-tools-')));
  const store = new Integrations(path.join(root, 'integrations.sqlite'));
  const interactions = new Interactions(path.join(root, 'interactions'));
  let resolved = 0;
  const tools = new IntegrationTools(store, interactions, {
    authorization: async () => {
      resolved++;
      return 'synthetic-valid-access';
    },
    remote: async (config) => {
      expect(resolved).toBe(1);
      expect(config.bearer).toBe('synthetic-valid-access');
      return {
        start: async () => {},
        tools: async () => [{ name: 'synthetic_echo', inputSchema: { type: 'object' } }],
        call: async () => {
          throw new Error('must not execute');
        },
        close: async () => {},
      };
    },
  });
  try {
    const target = { bot: 'mock-a', connection: 'mock-notion', revision: 0 };
    const start = await store.beginOAuth(
      { ...target, app: 'notion', name: 'Synthetic App', requestId: 'mock-start' },
      Date.now() + 600000,
    );
    await store.oauthPhase(target, start.attempt, 'waiting');
    await store.oauthPhase(target, start.attempt, 'exchanging');
    await store.oauthCommit(target, start.attempt, {
      issuer: 'https://mcp.notion.com',
      resource: 'https://mcp.notion.com/mcp',
      clientId: 'mock-client',
      accessToken: 'synthetic-expired-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: 1,
      scope: 'default',
      tokenEndpoint: 'https://mcp.notion.com/token',
      redirectUri: 'http://127.0.0.1:45123/callback/mock',
    });
    await tools.probe(target.connection, 1);
    expect(resolved).toBe(1);
    expect((await store.capture(target.bot)).connections).toEqual([]);
    expect(JSON.stringify(await store.capture(target.bot))).not.toMatch(/synthetic-|token|secret/i);
  } finally {
    await tools.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
