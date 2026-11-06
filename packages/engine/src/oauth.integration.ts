import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appProviders } from '@daban/protocol';
import { IntegrationTools } from './integration-tools.js';
import { Integrations } from './integrations.js';
import { Interactions } from './interactions.js';
import { McpRemote } from './mcp.js';
import { OAuth } from './oauth.js';
import { secureDirectory } from './private-files.js';
import { tlsFixture } from './tls.fixture.js';

for (const provider of appProviders) {
  for (const responseStatus of [200, 401, 403]) {
    test(`synthetic ${provider.id} OAuth -> review -> one approved HTTPS effect -> disconnect (${responseStatus})`, async () => {
      const root = await secureDirectory(
        await mkdtemp(path.join(tmpdir(), 'synthetic-oauth-loop-')),
      );
      const store = new Integrations(path.join(root, 'integrations.sqlite'));
      const interactions = new Interactions(path.join(root, 'interactions'));
      let effects = 0,
        tokenExchanges = 0;
      const fixture = await tlsFixture(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer synthetic-access');
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (message.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }
        if (message.method === 'tools/call') {
          effects++;
          if (responseStatus !== 200) {
            res.writeHead(responseStatus, {
              'content-type': 'application/json',
              'www-authenticate': 'Bearer error="insufficient_scope"',
            });
            res.end('{"error":"synthetic_rejection"}');
            return;
          }
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'synthetic', version: '1.0' },
              }
            : message.method === 'tools/list'
              ? {
                  tools: [
                    {
                      name: 'synthetic_echo',
                      description: 'Synthetic echo',
                      inputSchema: { type: 'object' },
                    },
                  ],
                }
              : { content: [{ type: 'text', text: 'SYNTHETIC_RESULT' }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            message.method === 'server/discover'
              ? {
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32601, message: 'Synthetic legacy' },
                }
              : { jsonrpc: '2.0', id: message.id, result },
          ),
        );
      });
      const oauth = new OAuth(store, {
        request: async (url) => {
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
          if (url === provider.register)
            return {
              status: 201,
              data: {
                client_id: 'mock-client',
                token_endpoint_auth_method:
                  provider.id === 'notion' ? 'none' : provider.clientAuthentication,
                ...(provider.id !== 'notion' &&
                provider.clientAuthentication === 'client_secret_post'
                  ? { client_secret: 'synthetic-client-secret' }
                  : {}),
              },
            };
          tokenExchanges++;
          return {
            status: 200,
            data: {
              access_token: 'synthetic-access',
              refresh_token: 'synthetic-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: provider.scope,
            },
          };
        },
      });
      const tools = new IntegrationTools(store, interactions, {
        authorization: (id) => oauth.token(id),
        remote: async (config, options) =>
          new McpRemote({ ...config, endpoint: fixture.endpoint }, { ...fixture, ...options }),
      });
      const target = { bot: 'mock-a', connection: 'mock-notion', revision: 0 };
      try {
        const started = await oauth.start({
          ...target,
          requestId: 'mock-start',
          app: provider.id,
          name: 'Synthetic Notion',
        });
        assert.ok(started.authorize);
        const url = new URL(started.authorize.url);
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.search = new URLSearchParams({
          state: url.searchParams.get('state')!,
          iss: provider.issuer,
          code: 'synthetic-code',
        }).toString();
        assert.equal((await fetch(callback)).status, 200);
        assert.equal(tokenExchanges, 1);
        assert.equal(effects, 0);
        assert.deepEqual((await store.capture(target.bot)).connections, []);
        await tools.probe(target.connection, 1);
        assert.deepEqual((await store.capture(target.bot)).connections, []);
        const catalog = await store.catalogView(target.connection, target.bot);
        await store.bind(target.bot, {
          connection: target.connection,
          configRevision: 1,
          bindingRevision: 0,
          enabled: true,
          tools: ['synthetic_echo'],
          catalogDigest: catalog.current.catalogDigest,
        });
        const run = {
          id: 'mock-run',
          bot: target.bot,
          sessionId: 'mock-session',
          abort: new AbortController(),
          integrations: await store.capture(target.bot),
        };
        assert.doesNotMatch(JSON.stringify(run.integrations), /synthetic-access|synthetic-refresh/);
        const alias = run.integrations.connections[0].tools[0].alias;
        const pending = tools.invoke(run, alias, {}, 'mock-wire');
        let approvals = await interactions.list();
        for (let i = 0; !approvals.length && i < 100; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          approvals = await interactions.list();
        }
        assert.equal(approvals.length, 1);
        assert.equal(effects, 0);
        await interactions.reply(run.bot, run.id, approvals[0].id, {
          kind: 'decision',
          allow: true,
        });
        const result = await pending;
        assert.equal(effects, 1);
        assert.equal(result.isError, responseStatus !== 200);
        if (responseStatus !== 200)
          assert.match(
            JSON.stringify(result),
            new RegExp(responseStatus === 401 ? 'MCP_RECONNECT_REQUIRED' : 'MCP_SCOPE_REQUIRED'),
          );
        assert.deepEqual(await tools.invoke(run, alias, {}, 'mock-wire'), result);
        if (responseStatus !== 200) {
          assert.equal((await store.calls(run.bot)).items[0].phase, 'unknown');
          await tools.invoke(run, alias, {}, 'mock-other-wire');
        }
        assert.equal(effects, 1);
        assert.equal(tokenExchanges, 1);
        await store.disconnectOAuth({ ...target, revision: 1 }, 'mock-disconnect');
        assert.equal((await tools.invoke(run, alias, {}, 'mock-after-disconnect')).isError, true);
        assert.equal(effects, 1);
        assert.deepEqual((await store.capture(run.bot)).connections, []);
      } finally {
        await tools.close();
        await oauth.close();
        await store.close();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
