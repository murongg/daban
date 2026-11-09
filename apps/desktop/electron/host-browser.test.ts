import {
  disconnected,
  isBrowserView,
  isHostBrowserRequest,
  isHostBrowserStatus,
} from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const state = {
  bot: 'mock-bot',
  available: true,
  instance: 'mock-browser',
  revision: 1,
  active: 'mock-tab',
  tabs: [{ id: 'mock-tab', url: 'about:blank', title: '', generation: 0 }],
};

it('accepts only closed host browser requests and rejects extra authority or unsafe input', () => {
  for (const request of [
    { action: 'open', bot: 'mock-bot' },
    { action: 'state', bot: 'mock-bot' },
    { action: 'autoStart', bot: 'mock-bot' },
    { action: 'autoStart', bot: 'mock-bot', enabled: true },
    {
      action: 'target',
      bot: 'mock-bot',
      epoch: 2,
      binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 0 },
    },
    { action: 'control', bot: 'mock-bot', instance: 'mock-browser', epoch: 1, owner: 'human' },
    {
      action: 'command',
      bot: 'mock-bot',
      request: {
        action: 'navigate',
        epoch: 1,
        instance: 'mock-browser',
        id: 'mock-intent',
        tab: 'mock-tab',
        url: 'https://example.test',
      },
    },
  ]) {
    expect(isHostBrowserRequest(request)).toBe(true);
    expect(parseCommand({ type: 'hostBrowser', request })).toEqual({
      type: 'hostBrowser',
      request,
    });
    expect(isHostBrowserRequest({ ...request, token: 'synthetic-forged-token' })).toBe(false);
  }
  for (const request of [
    { action: 'open', bot: '../escape' },
    { action: 'autoStart', bot: 'mock-bot', enabled: 'true' },
    { action: 'control', bot: 'mock-bot', instance: 'mock-browser', epoch: 1, owner: 'admin' },
    { action: 'close', bot: 'mock-bot' },
    {
      action: 'input',
      bot: 'mock-bot',
      epoch: 1,
      binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 0 },
      input: { type: 'evaluate', script: 'synthetic()' },
    },
  ])
    expect(isHostBrowserRequest(request)).toBe(false);
});

it('validates the Bot and requested value in an auto-start setting reply', async () => {
  let reply = { bot: 'mock-other', enabled: true };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:8766',
    agent: true,
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => Response.json(reply),
  });
  vi.spyOn(client, 'status').mockResolvedValue({
    ...disconnected('ready'),
    hostBrowser: { available: true, connections: [] },
  });
  const command = {
    type: 'hostBrowser',
    request: { action: 'autoStart', bot: 'mock-bot', enabled: true },
  } as const;
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
  reply = { bot: 'mock-bot', enabled: false };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
  reply = { bot: 'mock-bot', enabled: true };
  await expect(client.invoke(parseCommand(command))).resolves.toEqual(reply);
});

it('binds each advertised host browser connection to its own Bot and rejects duplicate identities', () => {
  const connection = { bot: 'mock-bot', epoch: 1, owner: 'human', state };
  expect(isHostBrowserStatus({ available: true, connections: [connection] })).toBe(true);
  expect(
    isHostBrowserStatus({ available: true, connections: [{ ...connection, bot: 'mock-other' }] }),
  ).toBe(false);
  expect(isHostBrowserStatus({ available: true, connections: [connection, connection] })).toBe(
    false,
  );
  expect(isHostBrowserStatus({ available: false, connections: [connection] })).toBe(false);
});

it('accepts bounded native viewport images and an explicit embedded-browser capability', () => {
  const view = {
    bot: 'mock-bot',
    epoch: 2,
    binding: { instance: 'mock-browser', tab: 'mock-tab', generation: 0 },
    image: 'data:image/jpeg;base64,c3ludGhldGlj',
    width: 700,
    height: 467,
  };
  expect(isBrowserView(view)).toBe(true);
  for (const size of [0, -1, 960.5, 4097])
    expect(isBrowserView({ ...view, width: size })).toBe(false);
  expect(isHostBrowserStatus({ available: true, embedded: true, connections: [] })).toBe(true);
  expect(isHostBrowserStatus({ available: true, embedded: 'true', connections: [] })).toBe(false);
});

it('refuses unavailable host browser calls before sending and rejects cross-Bot replies', async () => {
  let reply = state;
  const fetcher = vi.fn(async () => Response.json(reply));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:8766',
    agent: true,
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot = disconnected('ready');
  const status = vi.spyOn(client, 'status').mockResolvedValue(snapshot);
  await expect(
    client.invoke({ type: 'hostBrowser', request: { action: 'state', bot: 'mock-bot' } }),
  ).rejects.toThrow('HOST_BROWSER_UNAVAILABLE');
  expect(fetcher).not.toHaveBeenCalled();
  status.mockResolvedValue({ ...snapshot, hostBrowser: { available: true, connections: [] } });
  expect(
    await client.invoke({ type: 'hostBrowser', request: { action: 'state', bot: 'mock-bot' } }),
  ).toEqual(state);
  reply = { ...state, bot: 'mock-foreign' };
  await expect(
    client.invoke({ type: 'hostBrowser', request: { action: 'state', bot: 'mock-bot' } }),
  ).rejects.toThrow('INVALID_RUNTIME_STATE');
});
