import { createHash } from 'node:crypto';
import { disconnected } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

test('explicit project scope survives the actual Electron task command parser', () => {
  const input: unknown = {
    type: 'task.start',
    bot: 'mock-bot',
    task: {
      requestId: 'mock-task',
      prompt: 'SYNTHETIC TASK',
      project: { projectId: 'mock-project', revision: 1 },
    },
  };
  expect(parseCommand(input)).toStrictEqual(input);
});

test('a matching filename and checksum cannot substitute a download from another project', async () => {
  const bytes = Buffer.from('mock');
  const result = {
    path: 'result.txt',
    name: 'result.txt',
    size: bytes.length,
    modified: '2026-01-01T00:00:00.000Z',
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    project: { projectId: 'mock-alpha', revision: 1 },
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => Response.json(result),
  });
  vi.spyOn(client, 'status').mockResolvedValue({ ...disconnected('ready'), protocolVersion: 44 });
  await expect(
    client.invoke({
      type: 'files.download',
      path: 'result.txt',
      project: { projectId: 'mock-beta', revision: 1 },
    }),
  ).rejects.toThrow('INVALID_RUNTIME_FILE');
});
