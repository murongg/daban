import { createHash, webcrypto } from 'node:crypto';
import type {
  MemoryDecision,
  ProjectMemoryReceipt,
  ProjectMemoryWrite,
  RuntimeCommand,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import {
  applyProjectMemory,
  type MemoryCommand,
  type MemoryMutation,
  queryProjectMemoryReceipt,
} from './project-memory';

Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
const scope = { projectId: 'mock-project', revision: 1 };
const request: ProjectMemoryWrite = {
  requestId: 'mock-request',
  scope,
  action: 'publish',
  source: { kind: 'text', title: 'Synthetic reference', content: 'SYNTHETIC INTENT A' },
  digest: 'a'.repeat(64),
};
const signature = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : item,
      ),
    )
    .digest('hex');
const saved: ProjectMemoryReceipt & { signature: string } = {
  state: 'complete',
  operation: 'write',
  requestId: request.requestId,
  scope,
  signature: signature(request),
  document: {
    id: 'mock-document',
    projectId: scope.projectId,
    revision: 1,
    kind: 'reference',
    title: 'Synthetic reference',
    content: 'SYNTHETIC INTENT A',
    size: 18,
    deleted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

test('a lost conflicting response cannot complete B using the stored receipt for A', async () => {
  const changed = {
    ...request,
    source: { kind: 'text' as const, title: 'Synthetic reference', content: 'SYNTHETIC INTENT B' },
  };
  // Legacy receipts have no public signature and must remain uncertain, never count as B's success.
  const { signature: _signature, ...legacy } = saved;
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'projectMemory.write') throw Error('SYNTHETIC LOST CONFLICT RESPONSE');
    return legacy;
  });
  await expect(
    applyProjectMemory(invoke as MemoryCommand, { type: 'projectMemory.write', request: changed }),
  ).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(2);
});

test('a matching signed receipt recovers a lost success without a second mutation', async () => {
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'projectMemory.write') throw Error('SYNTHETIC LOST SUCCESS RESPONSE');
    return saved;
  });
  await expect(
    applyProjectMemory(invoke as MemoryCommand, { type: 'projectMemory.write', request }),
  ).resolves.toStrictEqual(saved);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[1][0]).toMatchObject({
    type: 'projectMemory.receipt',
    signature: signature(request),
  });
});

test('a recovery conflict is explicit and never retries under another request ID', async () => {
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    throw Error(
      command.type === 'projectMemory.write'
        ? 'SYNTHETIC LOST RESPONSE'
        : 'PROJECT_MEMORY_REQUEST_REUSED',
    );
  });
  await expect(
    applyProjectMemory(invoke as MemoryCommand, { type: 'projectMemory.write', request }),
  ).rejects.toThrow('PROJECT_MEMORY_REQUEST_REUSED');
  expect(invoke).toHaveBeenCalledTimes(2);
});

test('explicitly reviewing a newer scope can query the original receipt without rewriting its intent', async () => {
  const reviewed = { ...scope, revision: 2 };
  const invoke = vi.fn(async (_command: RuntimeCommand) => saved);
  await expect(
    queryProjectMemoryReceipt(
      invoke as MemoryCommand,
      { type: 'projectMemory.write', request },
      reviewed,
    ),
  ).resolves.toStrictEqual(saved);
  expect(invoke.mock.calls[0][0]).toStrictEqual({
    type: 'projectMemory.receipt',
    scope: reviewed,
    requestId: request.requestId,
    signature: signature(request),
  });
});

test('an operation remains frozen while its response is outstanding', async () => {
  const mutation: MemoryMutation = {
    type: 'projectMemory.write',
    request: structuredClone(request),
  };
  let release: ((value: unknown) => unknown) | undefined;
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'projectMemory.write')
      return new Promise((resolve) => {
        release = resolve;
      });
    return saved;
  });
  const result = applyProjectMemory(invoke as MemoryCommand, mutation);
  await vi.waitFor(() => expect(release).toBeDefined());
  if (mutation.request.action === 'publish' && mutation.request.source.kind === 'text')
    mutation.request.source.content = 'SYNTHETIC EDIT AFTER SEND';
  release!(saved);
  await expect(result).resolves.toStrictEqual(saved);
  expect(invoke.mock.calls[0][0]).toStrictEqual({ type: 'projectMemory.write', request });
});

test('complete decision fingerprints bind final text, candidate, scope and exact target before manual or automatic recovery', async () => {
  const decision: MemoryDecision = {
    requestId: 'mock-decide',
    scope,
    candidateId: 'mock-candidate',
    candidateRevision: 3,
    action: 'accept',
    content: 'SYNTHETIC HUMAN EDIT',
    target: { id: 'mock-memory', revision: 4 },
  };
  const receipt = {
    ...saved,
    operation: 'decide',
    requestId: decision.requestId,
    signature: signature(decision),
    document: {
      ...saved.document!,
      id: 'mock-memory',
      kind: 'confirmed-memory',
      revision: 5,
      content: decision.content,
      size: new TextEncoder().encode(decision.content).length,
    },
    candidate: {
      id: decision.candidateId,
      projectId: scope.projectId,
      scopeRevision: 1,
      proposer: 'mock-bot',
      revision: 4,
      state: 'accepted',
      content: decision.content,
      reason: 'Synthetic evidence',
      sources: [{ id: 'mock-source', revision: 2 }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'projectMemory.decide') throw Error('SYNTHETIC LOST RESPONSE');
    return receipt;
  });
  const command = invoke as MemoryCommand;
  const mutation = { type: 'projectMemory.decide' as const, request: decision };
  await expect(applyProjectMemory(command, mutation)).resolves.toStrictEqual(receipt);
  for (const changed of [
    { ...decision, content: 'SYNTHETIC DIFFERENT EDIT' },
    { ...decision, candidateId: 'mock-other-candidate' },
    { ...decision, candidateRevision: 4 },
    { ...decision, scope: { ...scope, revision: 2 } },
    { ...decision, target: { id: 'mock-other-memory', revision: 4 } },
    { ...decision, target: { id: 'mock-memory', revision: 5 } },
    { ...decision, action: 'reject' as const, target: undefined },
  ]) {
    await expect(applyProjectMemory(command, { ...mutation, request: changed })).rejects.toThrow(
      'SYNTHETIC LOST RESPONSE',
    );
    await expect(
      queryProjectMemoryReceipt(command, { ...mutation, request: changed }),
    ).rejects.toThrow('PROJECT_MEMORY_RESULT_UNKNOWN');
  }
  receipt.document.revision = 4;
  await expect(queryProjectMemoryReceipt(command, mutation)).rejects.toThrow(
    'PROJECT_MEMORY_RESULT_UNKNOWN',
  );
  receipt.document.revision = 5;
  receipt.operation = 'propose';
  await expect(queryProjectMemoryReceipt(command, mutation)).rejects.toThrow(
    'PROJECT_MEMORY_RESULT_UNKNOWN',
  );
});
