import { disconnected, type LocalFolder } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { suggestedFolderPath } from './folder-picker';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const folder: LocalFolder = {
  id: 'mock-folder',
  bot: 'mock-a',
  name: 'mock-project',
  path: '/mock/project',
};
it('allows a native folder picker intent but rejects renderer paths and forged authority', () => {
  expect(parseCommand({ type: 'folders.pick', bot: 'mock-a' })).toEqual({
    type: 'folders.pick',
    bot: 'mock-a',
  });
  for (const command of [
    { type: 'folders.pick', bot: 'mock-a', path: '/private' },
    { type: 'folders.connect', bot: 'mock-a', path: '/private' },
    { type: 'folders.disconnect', bot: 'mock-a', id: 'mock-folder', all: true },
  ])
    expect(() => parseCommand(command)).toThrow('INVALID_COMMAND');
});

it('accepts only a bounded suggested folder path for the native picker', () => {
  expect(
    parseCommand({ type: 'folders.pick', bot: 'mock-a', suggestedPath: '/mock/project' }),
  ).toEqual({ type: 'folders.pick', bot: 'mock-a', suggestedPath: '/mock/project' });
  for (const suggestedPath of ['x'.repeat(4097), '/mock/project\0'])
    expect(() => parseCommand({ type: 'folders.pick', bot: 'mock-a', suggestedPath })).toThrow(
      'INVALID_COMMAND',
    );
});

it('uses only an absolute, traversal-free local path as the native picker suggestion', () => {
  expect(suggestedFolderPath('/mock/project')).toBe('/mock/project');
  expect(suggestedFolderPath('/mock/../private')).toBeUndefined();
  expect(suggestedFolderPath('file:///mock/project')).toBeUndefined();
  expect(suggestedFolderPath('/mock/\0private')).toBeUndefined();
});

it('validates folder status ownership and uses the host-only connection method', async () => {
  let reply: unknown = { bot: 'mock-a', folders: [folder], operations: [] };
  const posted: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:8766',
    agent: true,
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) => {
      posted.push(url);
      return Response.json(reply);
    },
  });
  vi.spyOn(client, 'status').mockResolvedValue({ ...disconnected('ready'), localFolders: true });
  expect(await client.invoke({ type: 'folders.status', bot: 'mock-a' })).toMatchObject({
    folders: [folder],
  });
  reply = { bot: 'mock-b', folders: [], operations: [] };
  await expect(client.invoke({ type: 'folders.status', bot: 'mock-a' })).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
  reply = folder;
  expect(await client.connectFolder('mock-a', '/mock/project')).toEqual(folder);
  expect(posted.at(-1)).toContain('/api/folders/connect');
  reply = { ...folder, bot: 'mock-b' };
  await expect(client.connectFolder('mock-a', '/mock/project')).rejects.toThrow(
    'INVALID_RUNTIME_STATE',
  );
});
