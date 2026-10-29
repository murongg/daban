import { disconnected, isMemoryPage, isMemoryQuery, recoveryReader } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const version = (revision: number) => ({
  revision,
  content: `SYNTHETIC PREF ${revision}`,
  source: 'edit' as const,
  createdAt: '2026-01-01T00:00:00Z',
});
it('rejects sparse preference snapshots before treating them as complete history', () => {
  expect(
    isMemoryPage({
      bot: 'mock-a',
      profileRevision: 8,
      currentRevision: 7,
      items: Array(2),
      limited: false,
    }),
  ).toBe(false);
});
it('admits only human read commands and validates bounded complete preference pages without coercion', async () => {
  const command = { type: 'memory.history', bot: 'mock-a', query: {} };
  expect(parseCommand(command)).toEqual(command);
  expect(recoveryReader(parseCommand(command))).toBe(true);
  for (const query of [{ before: '2' }, { before: 0 }, { before: NaN }, { path: '/mock' }]) {
    expect(isMemoryQuery(query)).toBe(false);
    expect(() => parseCommand({ ...command, query })).toThrow('INVALID_COMMAND');
  }
  expect(() => parseCommand({ ...command, bot: '../mock' })).toThrow('INVALID_COMMAND');
  expect(() => parseCommand({ ...command, restore: true })).toThrow('INVALID_COMMAND');
  const page = {
    bot: 'mock-a',
    profileRevision: 8,
    currentRevision: 7,
    items: [7, 6, 5, 4, 3].map(version),
    limited: true,
    nextBefore: 3,
  };
  expect(isMemoryPage(page)).toBe(true);
  for (const invalid of [
    { ...page, extra: true },
    { ...page, currentRevision: 9 },
    { ...page, nextBefore: 4 },
    { ...page, items: Array(2) },
    { ...page, items: [version(6), version(7)] },
    { ...page, items: [{ ...version(7), source: { toString: () => 'edit' } }] },
    { ...page, items: [{ ...version(7), revision: '7' }] },
  ])
    expect(isMemoryPage(invalid)).toBe(false);
  let result: unknown = page;
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(result));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const status = disconnected('ready');
  status.protocolVersion = 31;
  vi.spyOn(client, 'status').mockImplementation(async () => status);
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(fetcher).not.toHaveBeenCalled();
  status.protocolVersion = 32;
  expect(await client.invoke(parseCommand(command))).toEqual(page);
  expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe('/api/memory/history');
  result = { ...page, bot: 'mock-other' };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_MEMORY_HISTORY');
  result = { ...page, items: [version(6)] };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_MEMORY_HISTORY');
  result = page;
  await expect(client.invoke(parseCommand({ ...command, query: { before: 7 } }))).rejects.toThrow(
    'INVALID_MEMORY_HISTORY',
  );
  result = { ...page, items: [version(2), version(1)], nextBefore: undefined };
  expect(await client.invoke(parseCommand({ ...command, query: { before: 3 } }))).toEqual(result);
});
