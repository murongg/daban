import {
  isComputerAck,
  isComputerRequest,
  isComputerState,
  isComputerStatus,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const request = {
  id: 'mock-computer-connect',
  bot: 'mock-custom-bot',
  action: 'connect' as const,
  revision: 0,
};
const computer = {
  bot: request.bot,
  revision: 2,
  phase: 'connected' as const,
  desired: true,
  reserved: true,
  instance: 'mock-computer-instance',
  updatedAt: '2026-01-01T00:00:00Z',
};
const ack = {
  receipt: { id: request.id, bot: request.bot, phase: 'settled' as const },
  state: computer,
};

it('validates only closed computer metadata and keeps physical allocation details private', () => {
  expect(isComputerRequest(request)).toBe(true);
  expect(isComputerRequest({ ...request, slot: 0 })).toBe(false);
  expect(isComputerRequest({ ...request, revision: -1 })).toBe(false);
  expect(isComputerState(computer)).toBe(true);
  expect(isComputerState({ ...computer, instance: undefined })).toBe(false);
  expect(isComputerState({ ...computer, reserved: false })).toBe(false);
  expect(isComputerState({ ...computer, slot: 0 })).toBe(false);
  expect(isComputerStatus({ available: true, revision: 1, limit: 2, items: [computer] })).toBe(
    true,
  );
  expect(
    isComputerStatus({ available: true, revision: 1, limit: 2, items: [computer, computer] }),
  ).toBe(false);
  expect(isComputerAck(ack)).toBe(true);
  expect(isComputerAck({ ...ack, state: { ...computer, bot: 'mock-wrong-bot' } })).toBe(false);
});

it('computer IPC actions are versioned and their receipt is bound to the exact operation and Bot', async () => {
  const command = { type: 'computer.action', request };
  expect(parseCommand(command)).toEqual(command);
  expect(() => parseCommand({ ...command, slot: 0 })).toThrow('INVALID_COMMAND');
  const posted: unknown[] = [];
  let version = 18,
    returned: unknown = ack;
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-computer-token">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return Response.json(returned);
      }
      return Response.json(
        version === 18
          ? {
              clientProtocol: 18,
              mode: 'desktop',
              sharedLogin: false,
              bots: {
                a: { owner: 'agent', epoch: 0, instance: 'mock-a-instance' },
                b: { owner: 'agent', epoch: 0, instance: 'mock-b-instance' },
              },
            }
          : {
              clientProtocol: 19,
              mode: 'agent',
              sharedLogin: false,
              bots: {},
              computers: { available: true, limit: 2, revision: 0, items: [] },
              model: { available: true, bots: {} },
            },
      );
    },
  });
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posted).toEqual([]);
  version = 19;
  expect((await client.status()).phase).toBe('ready');
  expect(await client.invoke(parseCommand(command))).toEqual(ack);
  expect(posted.at(-1)).toEqual(request);
  returned = { ...ack, receipt: { ...ack.receipt, id: 'mock-wrong-operation' } };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
});

it('keeps logical computer routes intact and propagates disconnected ownership rejection without falling back to a legacy screen', async () => {
  const posted: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-route-token">');
      if (init?.method === 'POST') posted.push(url);
      return Response.json({ error: 'COMPUTER_NOT_CONNECTED' }, { status: 503 });
    },
  });
  await expect(
    client.invoke(
      parseCommand({
        type: 'control',
        bot: 'mock-unconnected',
        instance: 'mock-instance',
        epoch: 1,
        owner: 'human',
      }),
    ),
  ).rejects.toThrow('COMPUTER_NOT_CONNECTED');
  expect(posted).toEqual(['http://127.0.0.1:18766/api/bots/mock-unconnected/control']);
});
