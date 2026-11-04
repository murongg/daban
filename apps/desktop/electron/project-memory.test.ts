import { expect, test } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const request = {
  requestId: 'mock-publish',
  scope: { projectId: 'mock-project', revision: 1 },
  action: 'publish',
  digest: 'a'.repeat(64),
  source: { kind: 'text', title: 'Synthetic guide', content: 'SYNTHETIC SHARED TEXT' },
};
const command = { type: 'projectMemory.write', request };

test('explicit project publication is a strict command without caller-selected authorship', () => {
  expect(parseCommand(command)).toStrictEqual(command);
  for (const input of [
    { ...command, actor: { kind: 'human' } },
    { ...command, request: { ...request, actor: { kind: 'human' } } },
    { ...command, request: { ...request, scope: { ...request.scope, revision: 0 } } },
    { ...command, request: { ...request, source: { ...request.source, content: ' ' } } },
    { ...command, request: { ...request, source: { ...request.source, privatePath: '/mock' } } },
  ])
    expect(() => parseCommand(input)).toThrow('INVALID_COMMAND');
});

test('the human transport rejects a valid-looking document returned from another project', async () => {
  const document = {
    id: 'mock-document',
    projectId: 'mock-other-project',
    kind: 'reference',
    title: 'Synthetic document',
    revision: 1,
    content: 'MOCK',
    size: 4,
    deleted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => Response.json(document),
  });
  await expect(
    client.invoke({
      type: 'projectMemory.read',
      scope: request.scope,
      document: { id: document.id, revision: 1 },
    }),
  ).rejects.toThrow('INVALID_PROJECT_MEMORY_RESPONSE');
});

test('a malformed capability response cannot enable the project memory surface', async () => {
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () =>
      Response.json({
        available: true,
        capability: 'project-memory-v1',
        error: { private: 'mock' },
      }),
  });
  await expect(client.invoke({ type: 'projectMemory.status' })).rejects.toThrow(
    'INVALID_PROJECT_MEMORY_RESPONSE',
  );
});
