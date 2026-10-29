import {
  isMcpAssignments,
  isMcpCatalog,
  isMcpConnection,
  isMcpHistory,
  isMcpSaved,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

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
