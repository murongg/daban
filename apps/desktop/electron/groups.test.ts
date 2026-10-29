import {
  isGroup,
  isGroupActionAck,
  isGroupActionReceipt,
  isGroupActionRequest,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

it('preserves archive metadata from a released28 runtime that only understands its own metadata capability', async () => {
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url, init) => {
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: true,
          revision: 0,
        });
      const modern =
        new Headers(init?.headers as HeadersInit).get('x-daban-client-protocol') === '28';
      return Response.json({
        mode: 'agent',
        clientProtocol: 28,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        recovery: { available: true, revision: 0 },
        skills: { available: true, revision: 0 },
        mcp: { available: true, revision: 0 },
        groups: {
          available: true,
          revision: 1,
          items: [modern ? { ...group, archived: true } : group],
        },
        model: {
          available: true,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          bots: {},
        },
      });
    },
  });
  expect((await client.status()).groups?.items[0].archived).toBe(true);
});

it('validates canonical archived state and strictly coupled lifecycle requests and acknowledgements', () => {
  const request = { id: 'mock-action', group: 'mock-group', action: 'archive', revision: 1 };
  expect(isGroupActionRequest(request)).toBe(true);
  for (const value of [
    { ...request, action: new String('archive') },
    { ...request, action: { toString: 'archive' } },
    { ...request, revision: 0 },
    { ...request, members: ['mock-alpha'] },
  ]) {
    expect(isGroupActionRequest(value)).toBe(false);
  }
  const receipt = { request, revision: 2, completedAt: '2026-01-01T00:00:00Z' };
  expect(isGroupActionReceipt(receipt)).toBe(true);
  expect(isGroupActionReceipt({ ...receipt, revision: 3 })).toBe(false);
  const archived = { ...group, archived: true, revision: 2 };
  expect(isGroup(archived)).toBe(true);
  expect(isGroupActionAck({ group: archived, receipt })).toBe(true);
  expect(isGroupActionAck({ group: { ...archived, archived: false }, receipt })).toBe(false);
  expect(isGroupActionAck({ group: { ...group, revision: 3 }, receipt })).toBe(true);
  expect(isGroupActionAck({ group: { ...archived, id: 'mock-other' }, receipt })).toBe(false);
});

const group = {
  id: 'mock-group',
  name: '合成群',
  members: ['mock-alpha', 'mock-beta'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const message = {
  id: 'mock-send',
  group: group.id,
  sequence: 1,
  sourceId: 'mock-send',
  role: 'user',
  text: '合成人类消息',
  createdAt: '2026-01-01T00:00:00Z',
};
it('gates lifecycle at28, negotiates group metadata and refuses a receipt for a different owned request', async () => {
  let version = 27;
  const request = { id: 'mock-archive', group: group.id, action: 'archive' as const, revision: 1 };
  let result: unknown = {
    group: { ...group, revision: 2, archived: true },
    receipt: { request, revision: 2, completedAt: '2026-01-01T00:00:00Z' },
  };
  const calls: unknown[] = [],
    headers: unknown[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-capability">');
      headers.push(init?.headers);
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: true,
          revision: 0,
        });
      if (init?.method === 'POST') {
        calls.push(JSON.parse(String(init.body)));
        return Response.json(result);
      }
      return Response.json({
        mode: 'agent',
        clientProtocol: version,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        recovery: { available: true, revision: 0 },
        skills: { available: true, revision: 0 },
        mcp: { available: true, revision: 0 },
        groups: { available: true, revision: 1, items: [group] },
        model: {
          available: true,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          bots: {},
        },
      });
    },
  });
  const command = { type: 'group.action' as const, request };
  expect(parseCommand(command)).toEqual(command);
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(calls).toHaveLength(0);
  version = 28;
  expect(await client.invoke(command)).toEqual(result);
  expect(
    headers.some(
      (value) => new Headers(value as HeadersInit).get('x-daban-client-protocol') === '28',
    ),
  ).toBe(true);
  result = {
    group: { ...group, id: 'mock-other', archived: true, revision: 2 },
    receipt: {
      request: { ...request, group: 'mock-other' },
      revision: 2,
      completedAt: '2026-01-01T00:00:00Z',
    },
  };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_GROUP_ACTION_ACK');
  expect(() =>
    parseCommand({ ...command, request: { ...request, members: ['mock-alpha'] } }),
  ).toThrow('INVALID_COMMAND');
});
it('gates group operations, projects the conversation scope and validates exact owned pages and mutation receipts', async () => {
  let protocol = 14;
  let scope: unknown = group.id;
  const page = { group, revision: 1, messages: [message], deliveries: [] };
  let result: unknown = page;
  const posts: unknown[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-group-capability">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: true,
          revision: 0,
        });
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return Response.json(result);
      }
      return Response.json({
        mode: 'desktop',
        clientProtocol: protocol,
        bots: { a: { owner: 'agent', epoch: 0 }, b: { owner: 'agent', epoch: 0 } },
        profiles: [],
        groups: { available: true, revision: 1, items: [group] },
        model: {
          available: true,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          bots: {
            a: {
              running: true,
              phase: 'running',
              conversationId: group.id,
              history: [
                {
                  runId: 'mock-scoped-run',
                  requestId: 'mock-scoped-request',
                  phase: 'completed',
                  prompt: '合成群记录',
                  result: 'MOCK-GROUP-ONLY',
                  conversationId: scope,
                },
              ],
            },
          },
        },
      });
    },
  });
  const read = parseCommand({ type: 'group.read', group: group.id });
  await expect(client.invoke(read)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  protocol = 15;
  const snapshot = await client.status();
  expect(snapshot.groups?.items).toEqual([group]);
  expect(snapshot.agents.a.conversationId).toBe(group.id);
  expect(snapshot.agents.a.history[0].conversationId).toBe(group.id);
  scope = null;
  const invalid = await client.status();
  expect(invalid.phase).toBe('offline');
  expect(invalid.agents).toEqual({});
  scope = group.id;
  expect(await client.invoke(read)).toEqual(page);
  result = { ...page, group: { ...group, id: 'another-group' } };
  await expect(client.invoke(read)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const input = {
    id: message.id,
    group: group.id,
    prompt: message.text,
    recipients: ['mock-alpha'],
  };
  const send = parseCommand({ type: 'group.send', input });
  result = { ...page, accepted: message };
  expect(await client.invoke(send)).toEqual(result);
  result = { ...page, accepted: { ...message, id: 'wrong-source', sourceId: 'wrong-source' } };
  await expect(client.invoke(send)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const cancel = parseCommand({ type: 'group.cancel', group: group.id, sourceId: message.id });
  result = { ...page, cancelledSource: message.id };
  expect(await client.invoke(cancel)).toEqual(result);
  result = { ...page, cancelledSource: 'other-source' };
  await expect(client.invoke(cancel)).rejects.toThrow('INVALID_RUNTIME_STATE');
});

it('rejects caller-provided authors, nested group identities and unsupported member mutations', () => {
  for (const command of [
    {
      type: 'group.send',
      input: {
        id: 'mock-send',
        group: group.id,
        prompt: '合成消息',
        recipients: ['mock-alpha'],
        author: 'mock-beta',
      },
    },
    {
      type: 'group.update',
      group: group.id,
      revision: 1,
      input: { id: 'changed-id', name: '合成群', members: group.members },
    },
    { type: 'group.register', group: { ...group, revision: undefined } },
  ])
    expect(() => parseCommand(command)).toThrow('INVALID_COMMAND');
});
