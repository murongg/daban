import { isBotLifecycleAck } from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const request = { id: 'mock-archive', bot: 'mock-a', action: 'archive', revision: 1 };
const profile = {
  id: 'mock-a',
  name: '合成归档助手',
  instructions: '',
  memory: 'SYNTHETIC-MEMORY',
  color: 'mint',
  revision: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T01:00:00Z',
  archived: true,
  lifecycle: { id: request.id, action: 'archive', phase: 'complete', baseRevision: 1 },
};
const ack = { profile, receipt: { ...profile.lifecycle, bot: profile.id } };

it('closes lifecycle IPC and prevents profile edits or imports from setting archive authority', () => {
  expect(parseCommand({ type: 'bot.action', request })).toEqual({ type: 'bot.action', request });
  expect(parseCommand({ type: 'bot.receipt', bot: request.bot, id: request.id })).toEqual({
    type: 'bot.receipt',
    bot: request.bot,
    id: request.id,
  });
  expect(() =>
    parseCommand({ type: 'bot.action', request: { ...request, eraseFiles: true } }),
  ).toThrow('INVALID_COMMAND');
  expect(() => parseCommand({ type: 'bot.action', request: { ...request, revision: 0 } })).toThrow(
    'INVALID_COMMAND',
  );
  expect(() => parseCommand({ type: 'bot.action', request, confirmation: 'close-apps' })).toThrow(
    'INVALID_COMMAND',
  );
  expect(() =>
    parseCommand({ type: 'bot.update', bot: request.bot, revision: 1, patch: { archived: false } }),
  ).toThrow('INVALID_COMMAND');
  expect(() => parseCommand({ type: 'bot.register', profile })).toThrow('INVALID_COMMAND');
  expect(isBotLifecycleAck(ack)).toBe(true);
  expect(isBotLifecycleAck({ ...ack, receipt: { ...ack.receipt, phase: 'pending' } })).toBe(false);
});

it('versions lifecycle transport and requires complete exact-target mutation receipts', async () => {
  let protocol = 21;
  let returned: unknown = ack;
  const posted: unknown[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-lifecycle-token">');
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
        skills: { available: true, revision: 0 },
        mcp: { available: true, revision: 0 },
        profiles: [],
        model: { available: true, bots: {} },
      });
    },
  });
  const command = parseCommand({ type: 'bot.action', request });
  await expect(client.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posted).toEqual([]);
  protocol = 22;
  expect(await client.invoke(command)).toEqual(ack);
  expect(posted.at(-1)).toEqual({ path: '/api/bots/mock-a/lifecycle', body: request });
  returned = { ...ack, receipt: { ...ack.receipt, bot: 'mock-b' } };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = {
    profile: { ...profile, lifecycle: { ...profile.lifecycle, id: 'mock-foreign' } },
    receipt: { ...ack.receipt, id: 'mock-foreign' },
  };
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const pending = {
    profile: { ...profile, revision: 2, lifecycle: { ...profile.lifecycle, phase: 'pending' } },
    receipt: { ...ack.receipt, phase: 'pending' },
  };
  expect(isBotLifecycleAck(pending)).toBe(true);
  returned = pending;
  await expect(client.invoke(command)).rejects.toThrow('INVALID_RUNTIME_STATE');
  const lookup = parseCommand({ type: 'bot.receipt', bot: request.bot, id: request.id });
  expect(await client.invoke(lookup)).toEqual(pending);
  expect(posted.at(-1)).toEqual({
    path: '/api/bots/mock-a/lifecycle-receipt',
    body: { id: request.id },
  });
});
