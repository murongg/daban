import { webcrypto } from 'node:crypto';
import { type ProjectMemoryWrite, projectMemoryFingerprint } from '@daban/protocol';
import { expect, test } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle });

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

test('receipt queries require a Host fingerprint matching the frozen intent and reject caller-selected actors', async () => {
  const signature = 'b'.repeat(64);
  const query = {
    type: 'projectMemory.receipt' as const,
    scope: request.scope,
    requestId: request.requestId,
    signature,
  };
  expect(parseCommand(query)).toStrictEqual(query);
  expect(() => parseCommand({ ...query, signature: 'mock-not-a-fingerprint' })).toThrow(
    'INVALID_COMMAND',
  );
  expect(() => parseCommand({ ...query, actor: 'human' })).toThrow('INVALID_COMMAND');
  const value = {
    state: 'complete',
    operation: 'write',
    requestId: query.requestId,
    scope: query.scope,
    signature: 'a'.repeat(64),
    document: {
      id: 'mock-document',
      projectId: query.scope.projectId,
      revision: 1,
      kind: 'reference',
      title: 'Synthetic reference',
      content: 'MOCK',
      size: 4,
      deleted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => Response.json(value),
  });
  await expect(client.invoke(query)).rejects.toThrow('INVALID_PROJECT_MEMORY_RESPONSE');
  value.signature = signature;
  await expect(client.invoke(query)).resolves.toStrictEqual(value);
});

test('a signed response still has to identify the exact edited document revision', async () => {
  const request: ProjectMemoryWrite = {
    requestId: 'mock-edit',
    scope: { projectId: 'mock-project', revision: 2 },
    action: 'update',
    document: { id: 'mock-original', revision: 4 },
    title: 'Synthetic edited reference',
    content: 'MOCK',
  };
  const value = {
    state: 'complete',
    operation: 'write',
    requestId: request.requestId,
    scope: request.scope,
    signature: await projectMemoryFingerprint(request),
    document: {
      id: 'mock-other',
      projectId: request.scope.projectId,
      revision: 5,
      kind: 'reference',
      title: request.title,
      content: request.content,
      size: 4,
      deleted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => Response.json(value),
  });
  await expect(client.invoke({ type: 'projectMemory.write', request })).rejects.toThrow(
    'INVALID_PROJECT_MEMORY_RESPONSE',
  );
  value.document.id = request.document.id;
  value.document.revision = request.document.revision;
  await expect(client.invoke({ type: 'projectMemory.write', request })).rejects.toThrow(
    'INVALID_PROJECT_MEMORY_RESPONSE',
  );
  value.document.revision++;
  await expect(client.invoke({ type: 'projectMemory.write', request })).resolves.toStrictEqual(
    value,
  );
});
