import {
  isAppOAuthReceipt,
  isMcpAssignments,
  isMcpBindingInput,
  isMcpCatalog,
  isMcpConnection,
  isMcpHistory,
  isMcpSaved,
  isNotionAuthorizeUrl,
  mcpAppsView,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

it('accepts only the reviewed browser destination with PKCE and a literal loopback callback', () => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'mock-client',
    redirect_uri: `http://127.0.0.1:45123/oauth/${'c'.repeat(48)}`,
    state: 'a'.repeat(43),
    code_challenge: 'b'.repeat(43),
    code_challenge_method: 'S256',
    resource: 'https://mcp.notion.com/mcp',
    scope: 'default',
  });
  const url = new URL(`https://mcp.notion.com/authorize?${params}`);
  expect(isNotionAuthorizeUrl(url.href)).toBe(true);
  for (const [key, value] of [
    ['redirect_uri', 'https://evil.example.test/callback'],
    ['redirect_uri', 'http://localhost:45123/callback'],
    ['code_challenge', 'short'],
    ['scope', 'default admin'],
    ['client_secret', 'synthetic-secret'],
  ]) {
    const changed = new URL(url);
    changed.searchParams.set(key, value);
    expect(isNotionAuthorizeUrl(changed.href)).toBe(false);
  }
});

it('accepts the reviewed app commands while closing owner, revision and registration input', () => {
  const input = {
    requestId: 'mock-oauth-start',
    bot: 'mock-a',
    connection: 'mock-notion',
    revision: 0,
    app: 'notion',
    name: 'Synthetic Notion',
  };
  expect(parseCommand({ type: 'app.catalog', bot: 'mock-a' })).toEqual({
    type: 'app.catalog',
    bot: 'mock-a',
  });
  expect(parseCommand({ type: 'app.oauth.start', input })).toEqual({
    type: 'app.oauth.start',
    input,
  });
  for (const invalid of [
    { ...input, app: 'arbitrary' },
    { ...input, name: undefined },
    { ...input, revision: -1 },
    { ...input, local: true },
    { ...input, revision: 1 },
    { ...input, bot: '../mock-a' },
  ])
    expect(() => parseCommand({ type: 'app.oauth.start', input: invalid })).toThrow(
      'INVALID_COMMAND',
    );
  const target = { bot: input.bot, connection: input.connection, revision: 0 };
  expect(
    parseCommand({
      type: 'app.oauth.cancel',
      target,
      attempt: 'mock-attempt',
      requestId: input.requestId,
    }),
  ).toBeTruthy();
  expect(() => parseCommand({ type: 'app.oauth.cancel', target, attempt: 'mock-attempt' })).toThrow(
    'INVALID_COMMAND',
  );
});

it('gates app transport by capability, validates exact receipt owners, and reserves interactive mutations for main', async () => {
  let available = true;
  const posts: unknown[] = [];
  let reply: unknown = {
    bot: 'mock-a',
    apps: [
      {
        id: 'notion',
        publisher: 'Notion',
        origin: 'https://mcp.notion.com',
        auth: 'oauth',
        available: false,
        reason: 'OAUTH_NOT_VERIFIED',
      },
      { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
    ],
    connections: [],
    attempts: [],
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-token">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return Response.json(reply);
      }
      return Response.json({
        clientProtocol: 21,
        mode: 'agent',
        botCapabilities: true,
        sharedLogin: false,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        skills: { available: true, revision: 1 },
        mcp: { available: true, revision: 1 },
        model: { available: true, bots: {} },
        ...(available ? { appConnections: { catalog: true, oauthLoopback: true } } : {}),
      });
    },
  });
  expect((await client.status()).appConnections).toEqual({ catalog: true, oauthLoopback: true });
  const command = parseCommand({ type: 'app.catalog', bot: 'mock-a' });
  expect(await client.invoke(command)).toEqual(reply);
  reply = { ...(reply as object), bot: 'mock-b' };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  available = false;
  const count = posts.length;
  await expect(client.invoke(command)).rejects.toThrow('OAUTH_UNAVAILABLE');
  expect(posts.length).toBe(count);
  await expect(
    client.invoke(
      parseCommand({
        type: 'app.oauth.start',
        input: {
          bot: 'mock-a',
          connection: 'mock-notion',
          revision: 0,
          requestId: 'mock-start',
          app: 'notion',
          name: 'Synthetic',
        },
      }),
    ),
  ).rejects.toThrow('OAUTH_INTERACTIVE_REQUIRED');
  const receipt = {
    bot: 'mock-a',
    connection: 'mock-notion',
    revision: 0,
    requestId: 'mock-start',
    attempt: 'mock-attempt',
    phase: 'waiting',
  };
  expect(isAppOAuthReceipt(receipt)).toBe(true);
  for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'code', 'verifier', 'url'])
    expect(isAppOAuthReceipt({ ...receipt, [key]: 'synthetic-secret' })).toBe(false);
});

const connection = {
  id: 'mock-connection',
  name: '合成服务',
  revision: 1,
  origin: 'https://mcp.example.test',
  credentialConfigured: true,
  deleted: false,
  health: 'ready',
  toolCount: 1,
  catalogDigest: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const tool = {
  name: 'synthetic_echo',
  alias: `ext_${'b'.repeat(20)}`,
  description: '合成回声',
  inputSchema: { type: 'object' },
  digest: 'c'.repeat(64),
};
const entry = {
  connection,
  revision: 1,
  enabled: true,
  available: true,
  tools: [tool.name],
  catalogDigest: connection.catalogDigest,
};
const saved = {
  receipt: { id: 'mock-save', connection: connection.id, revision: 1 },
  current: connection,
};

it.each([77, 128])(
  'validates all %i candidate tools in the public list and catalog envelopes',
  (count) => {
    const candidates = Array.from({ length: count }, (_, index) => ({
      ...tool,
      name: `synthetic_capacity_${index}`,
      alias: `ext_${index.toString(16).padStart(20, '0')}`,
    }));
    const current = { ...connection, toolCount: count };
    expect(isMcpConnection(current)).toBe(true);
    expect(isMcpCatalog({ current, tools: candidates })).toBe(true);
  },
);

it('keeps the candidate catalog finite and the independent binding budget at 32', () => {
  expect(isMcpConnection({ ...connection, toolCount: 129 })).toBe(false);
  const input = {
    connection: connection.id,
    configRevision: 1,
    bindingRevision: 0,
    catalogDigest: connection.catalogDigest,
    enabled: true,
    tools: Array.from({ length: 32 }, (_, index) => `synthetic_capacity_${index}`),
  };
  expect(isMcpBindingInput(input)).toBe(true);
  expect(isMcpBindingInput({ ...input, tools: [...input.tools, 'synthetic_capacity_32'] })).toBe(
    false,
  );
});

it('accepts closed MCP metadata and exact owner envelopes but never private config or extra authority', () => {
  expect(isMcpConnection(connection)).toBe(true);
  expect(
    isMcpConnection({ ...connection, endpoint: 'https://mcp.example.test/private?key=synthetic' }),
  ).toBe(false);
  expect(isMcpConnection({ ...connection, origin: 'https://mcp.example.test/private' })).toBe(
    false,
  );
  expect(isMcpConnection({ ...connection, bearer: 'synthetic-secret' })).toBe(false);
  expect(isMcpSaved(saved)).toBe(true);
  expect(isMcpSaved({ ...saved, receipt: { ...saved.receipt, connection: 'mock-other' } })).toBe(
    false,
  );
  expect(isMcpCatalog({ current: connection, tools: [tool] })).toBe(true);
  expect(isMcpCatalog({ current: connection, tools: [{ ...tool, name: 'mock\0tool' }] })).toBe(
    false,
  );
  expect(
    isMcpCatalog({
      current: connection,
      tools: [{ ...tool, inputSchema: { type: 'object', description: 'x'.repeat(34000) } }],
    }),
  ).toBe(false);
  expect(isMcpCatalog({ current: connection, tools: [tool, tool] })).toBe(false);
  expect(isMcpAssignments({ bot: 'mock-a', revision: 1, items: [entry] })).toBe(true);
  expect(
    isMcpAssignments({ bot: 'mock-a', revision: 1, items: [{ ...entry, enabled: false }] }),
  ).toBe(false);
  expect(isMcpHistory({ bot: 'mock-a', items: [] })).toBe(true);
  expect(isMcpHistory({ bot: 'mock-a', items: [], bearer: 'synthetic' })).toBe(false);
});

it('closes MCP commands at IPC and keeps input credentials out of response contracts', () => {
  const commands = [
    { type: 'mcp.list', includeDeleted: false },
    {
      type: 'mcp.save',
      input: {
        requestId: 'mock-save',
        id: connection.id,
        revision: 0,
        name: connection.name,
        endpoint: 'https://mcp.example.test/mcp?key=synthetic',
        bearer: 'synthetic-bearer',
      },
    },
    { type: 'mcp.saved', id: 'mock-save', connection: connection.id },
    { type: 'mcp.catalog', id: connection.id },
    { type: 'mcp.check', id: connection.id, revision: 1 },
    { type: 'mcp.bindings', bot: 'mock-a' },
    {
      type: 'mcp.bind',
      bot: 'mock-a',
      input: {
        connection: connection.id,
        configRevision: 1,
        bindingRevision: 0,
        enabled: true,
        tools: [tool.name],
        catalogDigest: connection.catalogDigest,
      },
    },
    { type: 'mcp.archive', id: connection.id, revision: 1 },
    { type: 'mcp.restore', id: connection.id, revision: 2 },
    { type: 'mcp.calls', bot: 'mock-a', connection: connection.id },
    { type: 'mcp.receipt', bot: 'mock-a', run: 'mock-run', id: 'mock-call' },
  ];
  for (const command of commands) {
    expect(parseCommand(command)).toEqual(command);
    expect(() => parseCommand({ ...command, permissions: 'all' })).toThrow('INVALID_COMMAND');
  }
  expect(() => parseCommand({ type: 'mcp.check', id: connection.id, revision: 0 })).toThrow(
    'INVALID_COMMAND',
  );
  expect(() =>
    parseCommand({
      type: 'mcp.save',
      input: { ...commands[1].input, endpoint: 'http://127.0.0.1/' },
    }),
  ).toThrow('INVALID_COMMAND');
  expect(() => parseCommand({ type: 'mcp.invoke', bot: 'mock-a', tool: tool.name })).toThrow(
    'INVALID_COMMAND',
  );
});

it('versions MCP transport and rejects stale, foreign or credential-bearing replies', async () => {
  let protocol = 20;
  let returned: unknown = saved;
  const posted: unknown[] = [];
  const sentHeaders: Headers[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-mcp-token">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      if (init?.method === 'POST') {
        sentHeaders.push(new Headers(init.headers));
        posted.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
        return Response.json(returned);
      }
      return Response.json({
        clientProtocol: protocol,
        mode: 'agent',
        sharedLogin: false,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        skills: { available: true, revision: 1 },
        mcp: { available: true, revision: 1 },
        model: { available: true, bots: {} },
      });
    },
  });
  const command = parseCommand({
    type: 'mcp.save',
    input: {
      requestId: 'mock-save',
      id: connection.id,
      revision: 0,
      name: connection.name,
      endpoint: 'https://mcp.example.test/mcp',
      bearer: 'synthetic-token',
    },
  });
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posted).toEqual([]);
  protocol = 21;
  expect((await client.status()).mcp?.available).toBe(true);
  expect(await client.invoke(command)).toEqual(saved);
  expect(posted.at(-1)).toEqual({ path: '/api/mcp/save', body: command });
  expect(sentHeaders.at(-1)?.get(mcpAppsView.header)).toBe(mcpAppsView.value);
  expect(sentHeaders.at(-1)?.get('x-daban-client-protocol')).toBe('28');
  returned = { ...saved, current: { ...connection, bearer: 'synthetic-secret' } };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { ...saved, receipt: { ...saved.receipt, id: 'mock-foreign-save' } };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { bot: 'mock-b', revision: 1, items: [entry] };
  await expect(
    client.invoke(parseCommand({ type: 'mcp.bindings', bot: 'mock-a' })),
  ).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { bot: 'mock-a', entry: { ...entry, revision: 1, tools: ['mock-foreign-tool'] } };
  await expect(
    client.invoke(
      parseCommand({
        type: 'mcp.bind',
        bot: 'mock-a',
        input: {
          connection: connection.id,
          configRevision: 1,
          bindingRevision: 0,
          enabled: true,
          tools: [tool.name],
          catalogDigest: connection.catalogDigest,
        },
      }),
    ),
  ).rejects.toThrow('INVALID_RUNTIME_STATE');
});
