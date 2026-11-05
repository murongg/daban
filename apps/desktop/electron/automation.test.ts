import { disconnected, type RuntimeCommand, recoveryReader } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

test('automation mutations and receipt queries are exact commands, never caller selected provenance', () => {
  const command: unknown = {
    type: 'schedule.monitor',
    id: 'mock-schedule',
    revision: 1,
    policy: { kind: 'changes', signalPath: 'mock.txt' },
  };
  expect(parseCommand(command)).toStrictEqual(command);
  expect(() =>
    parseCommand({
      type: 'schedule.monitor',
      id: 'mock-schedule',
      revision: 1,
      policy: { kind: 'changes' },
    }),
  ).toThrow('INVALID_COMMAND');
  expect(() =>
    parseCommand({
      type: 'task.start',
      bot: 'mock-bot',
      task: { requestId: 'mock-task', prompt: 'Synthetic', automation: command },
    }),
  ).toThrow('INVALID_COMMAND');
});

test('unsupported Hosts reject monitoring locally before sending a mutation', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  vi.spyOn(client, 'status').mockResolvedValue({ ...disconnected('ready'), protocolVersion: 45 });
  const command: RuntimeCommand = {
    type: 'schedule.monitor',
    id: 'mock-schedule',
    revision: 1,
    policy: { kind: 'changes', signalPath: 'mock.txt' },
  };
  await expect(client.invoke(command)).rejects.toThrow('AUTOMATION_UPGRADE_REQUIRED');
  expect(fetcher).not.toHaveBeenCalled();
});

test('original receipt reads remain observations during recovery', () => {
  expect(
    recoveryReader({ type: 'schedule.receipt', id: 'mock-schedule', firing: 'mock-firing' }),
  ).toBe(true);
  expect(
    recoveryReader({
      type: 'schedule.monitor',
      id: 'mock-schedule',
      revision: 1,
      policy: { kind: 'all' },
    }),
  ).toBe(false);
});
