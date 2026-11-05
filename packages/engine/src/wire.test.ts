import { mkdtemp, rm } from 'node:fs/promises';
import { type NetConnectOpts, Socket, type TcpNetConnectOpts } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConnectionOptions } from 'node:tls';
import { createSecureContext } from 'node:tls';
import { appProvider } from '@daban/protocol';
import { afterAll, expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { Integrations } from './integrations.js';
import { McpFetch } from './mcp-fetch.js';
import { OAuth } from './oauth.js';
import { OAuthFetch } from './oauth-fetch.js';
import { SearchClient } from './search.js';
import { tlsFixture } from './tls.fixture.js';
import { WireBridge, type WireRoute } from './wire.fixture.js';

const current = vi.hoisted(() => ({ wire: undefined as WireBridge | undefined }));
vi.mock('node:dns/promises', () => ({
  lookup: (host: string, options: { all: true; order: 'verbatim' }) => {
    if (!current.wire) throw new Error('WIRE_INACTIVE');
    return current.wire.lookup(host, options);
  },
}));
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  const connect = (options: NetConnectOpts) => {
    if (!current.wire) throw new Error('WIRE_INACTIVE');
    return current.wire.dial(options, actual.connect);
  };
  return { ...actual, connect, createConnection: connect };
});
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>();
  return {
    ...actual,
    connect: (options: ConnectionOptions) => {
      if (!current.wire) throw new Error('WIRE_INACTIVE');
      return current.wire.secure(options, actual.connect);
    },
  };
});
afterAll(() => {
  vi.doUnmock('node:dns/promises');
  vi.doUnmock('node:net');
  vi.doUnmock('node:tls');
  vi.resetModules();
});

async function routed(routes: WireRoute[], run: (wire: WireBridge) => Promise<unknown>) {
  if (current.wire) throw new Error('WIRE_OVERLAP');
  const wire = new WireBridge(routes);
  // Worker-local only: inherited proxy settings must not redirect these direct-transport fixtures.
  for (const name of [
    'DSH_NETWORK_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
  ])
    vi.stubEnv(name, '');
  current.wire = wire;
  try {
    return await run(wire);
  } finally {
    current.wire = undefined;
    try {
      await wire.close();
    } finally {
      vi.unstubAllEnvs();
    }
  }
}
function mapped(
  peer: Awaited<ReturnType<typeof tlsFixture>>,
  hostname: string,
  address: WireRoute['address'] = '8.8.8.8',
): WireRoute {
  return { hostname, address, destinationPort: Number(new URL(peer.endpoint).port), ca: peer.ca };
}

const route: WireRoute = {
  hostname: 'mcp.example.test',
  address: '8.8.8.8',
  destinationPort: 12345,
  ca: Buffer.from('synthetic test CA marker'),
};
const lookup = { all: true, order: 'verbatim' } as const;
test('wire fixture routes declared DNS while refusing undeclared hosts', async () => {
  const wire = new WireBridge([route]);
  await expect(wire.lookup(route.hostname, lookup)).resolves.toEqual([
    { address: route.address, family: 4 },
  ]);
  await expect(wire.lookup('undeclared.example.test', lookup)).rejects.toThrow(
    'WIRE_UNDECLARED_DNS',
  );
});
test('wire fixture refuses unmapped addresses and ports before opening TCP', () => {
  const wire = new WireBridge([route]);
  const forbidden = (_options: TcpNetConnectOpts): Socket => {
    throw new Error('WIRE_TEST_UNEXPECTED_TCP');
  };
  for (const options of [
    { host: '9.9.9.9', port: 443 },
    { host: route.address, port: 80 },
    { host: route.address, port: 443, localAddress: '127.0.0.1' },
  ])
    expect(() => wire.dial(options, forbidden)).toThrow('WIRE_UNDECLARED_DIAL');
});
test('wire fixture refuses unbound or insecure TLS before opening it', () => {
  const wire = new WireBridge([route]);
  const forbidden = () => {
    throw new Error('WIRE_TEST_UNEXPECTED_TLS');
  };
  expect(() =>
    wire.secure({ servername: route.hostname, rejectUnauthorized: false }, forbidden),
  ).toThrow('WIRE_TLS_UNDECLARED');
});
test('wire fixture binds TLS to the declared socket and preserves its DNS declaration', async () => {
  const input = { ...route };
  const wire = new WireBridge([input]);
  const socket = wire.dial({ host: route.address, port: 443 }, () => new Socket());
  input.hostname = 'changed.example.test';
  try {
    expect(await wire.lookup(route.hostname, lookup)).toEqual([
      { address: route.address, family: 4 },
    ]);
    const forbidden = () => {
      throw new Error('WIRE_TEST_UNEXPECTED_TLS');
    };
    for (const options of [
      { socket, servername: input.hostname, rejectUnauthorized: true },
      { socket, servername: route.hostname, rejectUnauthorized: false },
      {
        socket,
        servername: route.hostname,
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      },
      {
        socket,
        servername: route.hostname,
        rejectUnauthorized: true,
        secureContext: createSecureContext(),
      },
    ])
      expect(() => wire.secure(options, forbidden)).toThrow('WIRE_TLS_UNDECLARED');
  } finally {
    await wire.close();
  }
});
test('wire fixture cannot route DNS after its lifetime closes', async () => {
  const wire = new WireBridge([route]);
  await wire.close();
  await expect(wire.lookup(route.hostname, lookup)).rejects.toThrow('WIRE_CLOSED');
});

test('default OAuth MCP and Search transports reach only mapped TLS peers with original URL and headers', async () => {
  const paths: string[] = [];
  const peer = await tlsFixture((req, res) => {
    paths.push(req.url ?? '');
    expect(req.headers.host).toBe('mcp.example.test');
    expect(req.headers['proxy-authorization']).toBeUndefined();
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/metadata' ? { issuer: 'https://mcp.example.test' } : { tools: [] },
      ),
    );
  });
  let supplier: Awaited<ReturnType<typeof tlsFixture>> | undefined;
  try {
    supplier = await tlsFixture((req, res) => {
      paths.push('search');
      expect(req.url).toBe('/res/v1/web/search?q=synthetic+query&count=5&result_filter=web');
      expect(req.headers.host).toBe('api.search.brave.com');
      expect(req.headers['x-subscription-token']).toBe('synthetic-search-key');
      expect(req.headers['proxy-authorization']).toBeUndefined();
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          web: {
            results: [{ url: 'https://source.example.test/page', title: 'Synthetic result' }],
          },
        }),
      );
    }, 'api.search.brave.com');
    const source = supplier;
    await routed(
      [mapped(peer, 'mcp.example.test'), mapped(source, 'api.search.brave.com', '8.8.4.4')],
      async (wire) => {
        expect(
          await new OAuthFetch(['https://mcp.example.test/metadata']).request(
            'https://mcp.example.test/metadata',
          ),
        ).toEqual({ status: 200, data: { issuer: 'https://mcp.example.test' } });
        expect(
          await (
            await new McpFetch('https://mcp.example.test/mcp?view=synthetic').fetch(
              'https://mcp.example.test/mcp?view=synthetic',
              { method: 'POST', body: '{"method":"tools/list"}' },
            )
          ).json(),
        ).toEqual({ tools: [] });
        expect(
          await new SearchClient().query('brave', 'synthetic-search-key', 'synthetic query'),
        ).toMatchObject({ sources: [{ url: 'https://source.example.test/page' }] });
        expect(paths).toEqual(['/metadata', '/mcp?view=synthetic', 'search']);
        expect(wire.handshakes).toEqual([
          'mcp.example.test',
          'mcp.example.test',
          'api.search.brave.com',
        ]);
        expect(wire.dials).toEqual([
          { address: '8.8.8.8', port: 443 },
          { address: '8.8.8.8', port: 443 },
          { address: '8.8.4.4', port: 443 },
        ]);
      },
    );
  } finally {
    await Promise.all([peer.close(), supplier?.close()]);
  }
});

test.each(['wrong-ca', 'wrong-hostname'] as const)(
  'real TLS rejects %s before any HTTP bytes leave',
  async (mode) => {
    let effects = 0;
    const peer = await tlsFixture(
      (_req, res) => {
        effects++;
        res.end('{}');
      },
      mode === 'wrong-hostname' ? 'other.example.test' : 'mcp.example.test',
    );
    let other: Awaited<ReturnType<typeof tlsFixture>> | undefined;
    try {
      other = await tlsFixture((_req, res) => res.end('{}'), 'unrelated.example.test');
      const declared = mapped(peer, 'mcp.example.test');
      if (mode === 'wrong-ca') declared.ca = other.ca;
      await routed([declared], async (wire) => {
        await expect(
          new McpFetch('https://mcp.example.test/mcp').fetch('https://mcp.example.test/mcp', {
            method: 'POST',
            body: '{"method":"tools/list"}',
          }),
        ).rejects.toMatchObject({
          code:
            mode === 'wrong-hostname'
              ? 'ERR_TLS_CERT_ALTNAME_INVALID'
              : expect.stringMatching(/CERT|SELF_SIGNED/),
        });
        expect(wire.handshakes).toEqual([]);
        expect(wire.tlsErrors).toHaveLength(1);
        expect(effects).toBe(0);
      });
    } finally {
      await Promise.all([peer.close(), other?.close()]);
    }
  },
);

test.each(['oauth', 'mcp', 'search'] as const)(
  'default %s still refuses actual private DNS input before TCP',
  async (kind) => {
    const hostname = kind === 'search' ? 'api.search.brave.com' : route.hostname;
    await routed([{ ...route, hostname, resolved: '127.0.0.1' }], async (wire) => {
      const operation =
        kind === 'oauth'
          ? new OAuthFetch(['https://mcp.example.test/metadata']).request(
              'https://mcp.example.test/metadata',
            )
          : kind === 'mcp'
            ? new McpFetch('https://mcp.example.test/mcp').fetch('https://mcp.example.test/mcp', {
                method: 'POST',
                body: '{"method":"tools/list"}',
              })
            : new SearchClient().query('brave', 'synthetic-search-key', 'synthetic query');
      await expect(operation).rejects.toMatchObject({
        code:
          kind === 'oauth'
            ? 'OAUTH_NETWORK_BLOCKED'
            : kind === 'mcp'
              ? 'MCP_NETWORK_BLOCKED'
              : 'SEARCH_UNAVAILABLE',
      });
      expect(wire.dials).toEqual([]);
    });
  },
);

test('fixed OAuth and MCP URLs refuse undeclared destinations before any wire dial', async () => {
  await routed([route], async (wire) => {
    await expect(
      new OAuthFetch(['https://mcp.example.test/metadata']).request(
        'https://undeclared.example.test/metadata',
      ),
    ).rejects.toMatchObject({ code: 'OAUTH_NETWORK_BLOCKED' });
    await expect(
      new McpFetch('https://mcp.example.test/mcp').fetch('https://mcp.example.test/other', {
        method: 'POST',
      }),
    ).rejects.toMatchObject({ code: 'MCP_NETWORK_BLOCKED' });
    await expect(
      new OAuthFetch(['https://undeclared.example.test/metadata']).request(
        'https://undeclared.example.test/metadata',
      ),
    ).rejects.toMatchObject({ code: 'OAUTH_NETWORK_BLOCKED' });
    await expect(
      new McpFetch('https://9.9.9.9/mcp').fetch('https://9.9.9.9/mcp', { method: 'POST' }),
    ).rejects.toThrow('WIRE_UNDECLARED_DIAL');
    expect(wire.dials).toEqual([]);
  });
});

test('MCP pre-send owner callback blocks bytes and a transport-unknown effect cannot replay', async () => {
  let effects = 0,
    dispatched = 0;
  const peer = await tlsFixture((req) => {
    effects++;
    req.socket.destroy();
  });
  try {
    await routed([mapped(peer, route.hostname)], async (wire) => {
      const endpoint = 'https://mcp.example.test/mcp';
      const init = {
        method: 'POST',
        body: '{"method":"tools/call","params":{"name":"synthetic_echo"}}',
      };
      let owner = true;
      const blocked = new McpFetch(endpoint, {
        onDispatch: async () => {
          dispatched++;
          await Promise.resolve();
          owner = false;
        },
        authorize: () => {
          if (!owner) throw new Error('SYNTHETIC_OWNER_REVOKED');
        },
      });
      await expect(blocked.fetch(endpoint, init)).rejects.toThrow('SYNTHETIC_OWNER_REVOKED');
      expect(wire.handshakes).toHaveLength(1);
      expect(effects).toBe(0);
      const uncertain = new McpFetch(endpoint, {
        onDispatch: async () => {
          dispatched++;
        },
        authorize: () => undefined,
      });
      await expect(uncertain.fetch(endpoint, init)).rejects.toThrow();
      expect(effects).toBe(1);
      await expect(uncertain.fetch(endpoint, init)).rejects.toMatchObject({
        code: 'MCP_REPLAY_BLOCKED',
      });
      expect(effects).toBe(1);
      expect(dispatched).toBe(2);
    });
  } finally {
    await peer.close();
  }
});

test('Search rechecks its actual send gate after verified TLS and emits no withdrawn request', async () => {
  let effects = 0;
  const peer = await tlsFixture((_req, res) => {
    effects++;
    res.end('{}');
  }, 'api.search.brave.com');
  try {
    await routed([mapped(peer, 'api.search.brave.com')], async (wire) => {
      await expect(
        new SearchClient().query(
          'brave',
          'synthetic-search-key',
          'synthetic query',
          undefined,
          5,
          () => {
            if (wire.handshakes.length) throw new Error('SYNTHETIC_SEARCH_OWNER_REVOKED');
          },
        ),
      ).rejects.toThrow('SYNTHETIC_SEARCH_OWNER_REVOKED');
      expect(wire.handshakes).toEqual(['api.search.brave.com']);
      expect(effects).toBe(0);
    });
  } finally {
    await peer.close();
  }
});

test.each(['valid', 'wrong-resource', 'wrong-issuer', 'owner-revoked'] as const)(
  'default OAuth metadata and owner validation remain real over mapped TLS: %s',
  async (mode) => {
    const provider = appProvider('linear')!;
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-wire-oauth-'));
    const store = new Integrations(path.join(root, 'integrations.sqlite'));
    const requests: {
      path: string;
      method: string;
      body: string;
      host?: string;
      contentType?: string;
    }[] = [];
    let owner = true;
    const oauth = new OAuth(store, {
      assertOwner: () => {
        if (!owner) throw new Fault('OAUTH_OWNER_UNAVAILABLE');
      },
    });
    let peer: Awaited<ReturnType<typeof tlsFixture>> | undefined;
    try {
      peer = await tlsFixture(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({
          path: req.url ?? '',
          method: req.method ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          host: req.headers.host,
          contentType: req.headers['content-type'],
        });
        res.setHeader('content-type', 'application/json');
        if (req.url === new URL(provider.resourceMetadata).pathname) {
          if (mode === 'owner-revoked') owner = false;
          res.end(
            JSON.stringify({
              resource:
                mode === 'wrong-resource' ? 'https://other.example.test/mcp' : provider.resource,
              authorization_servers: [provider.issuer],
            }),
          );
        } else if (req.url === new URL(provider.metadata).pathname) {
          res.end(
            JSON.stringify({
              issuer: mode === 'wrong-issuer' ? 'https://other.example.test' : provider.issuer,
              authorization_endpoint: provider.authorize,
              token_endpoint: provider.token,
              registration_endpoint: provider.register,
              code_challenge_methods_supported: ['S256'],
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
            }),
          );
        } else if (req.url === new URL(provider.register).pathname) {
          res.writeHead(201);
          res.end(
            JSON.stringify({
              client_id: 'synthetic-registered-client',
              token_endpoint_auth_method: provider.clientAuthentication,
            }),
          );
        } else {
          res.writeHead(403);
          res.end('{}');
        }
      }, 'mcp.linear.app');
      const source = peer;
      await routed([mapped(source, 'mcp.linear.app')], async (wire) => {
        const result = await oauth.start({
          app: 'linear',
          bot: 'mock-wire',
          connection: 'mock-linear',
          revision: 0,
          requestId: 'mock-wire-start',
          name: 'Synthetic wire account',
        });
        expect(requests.every((request) => request.host === 'mcp.linear.app')).toBe(true);
        expect(requests.some((request) => request.path === new URL(provider.token).pathname)).toBe(
          false,
        );
        expect(wire.handshakes).toHaveLength(requests.length);
        if (mode === 'valid') {
          expect(result.receipt.phase).toBe('waiting');
          expect(
            new URL(result.authorize!.url).origin + new URL(result.authorize!.url).pathname,
          ).toBe(provider.authorize);
          expect(new URL(result.authorize!.url).searchParams.get('code_challenge_method')).toBe(
            'S256',
          );
          expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
          expect(requests[2].contentType).toBe('application/json');
          expect(JSON.parse(requests[2].body)).toMatchObject({
            client_name: 'Daban',
            token_endpoint_auth_method: 'none',
          });
        } else {
          expect(result.receipt).toMatchObject({
            phase: 'failed',
            error: mode === 'owner-revoked' ? 'OAUTH_OWNER_UNAVAILABLE' : 'OAUTH_METADATA_REJECTED',
          });
          expect(result.authorize).toBeUndefined();
          expect(requests).toHaveLength(mode === 'owner-revoked' ? 1 : 2);
        }
      });
    } finally {
      await oauth.close();
      await store.close();
      await peer?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
