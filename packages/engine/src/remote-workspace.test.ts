import { createHash } from 'node:crypto';
import { isExecutionRequest, workspaceReviewCapability } from '@daban/protocol';
import { expect, test } from 'vitest';
import { RemoteWorkspace } from './remote-workspace.js';

test('remote task staging and output inspection never require a host directory', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const execution = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'workspace.base') return '/synthetic-guest/shared';
      if (method === 'workspace.create')
        return {
          root: '/synthetic-guest/shared',
          path: '/synthetic-guest/shared/model-runs/mock-run/mock-bot',
          canonical: '/synthetic-guest/shared/model-runs/mock-run/mock-bot',
          handleId: 'mock-handle',
        };
      if (method === 'workspace.list')
        return [{ path: 'mock.txt', name: 'mock.txt', size: 4, modified: 'mock-time' }];
      return { ok: true };
    },
  };
  const workspace = new RemoteWorkspace(execution);
  await workspace.prepare();
  const directory = await workspace.create(['model-runs', 'mock-run', 'mock-bot']);
  await directory.write('mock.txt', Buffer.from('mock'));
  await directory.verify();
  const files = await workspace.scope(directory.path, directory.canonical).list();
  await directory.close();
  expect(files[0].path).toBe('mock.txt');
  expect(calls.find((call) => call.method === 'workspace.write')?.params).toStrictEqual({
    handleId: 'mock-handle',
    name: 'mock.txt',
    data: Buffer.from('mock').toString('base64'),
  });
  expect(calls.at(-1)?.method).toBe('workspace.close');
});

test('capture protocol accepts only root-bound recursive or exact path requests', () => {
  const request = {
    role: 'executor',
    version: 1,
    id: 'mock-request',
    method: 'workspace.review.capture',
    boot: 'mock-boot',
    nonce: 'mock-nonce',
    params: { root: '/mock/shared', canonical: '/mock/shared', paths: ['input.txt'] },
  };
  expect(isExecutionRequest(request)).toBe(true);
  expect(isExecutionRequest({ ...request, params: { paths: [] } })).toBe(false);
  expect(isExecutionRequest({ ...request, params: { paths: ['../private'] } })).toBe(false);
  expect(isExecutionRequest({ ...request, params: { paths: ['input', 'input'] } })).toBe(false);
  expect(isExecutionRequest({ ...request, params: { restore: true } })).toBe(false);
});

test('remote capture is capability-gated, root-bound, signal-bounded and checks returned text bytes', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const capture = {
    snapshot: {
      area: 'shared',
      startedAt: at,
      endedAt: at,
      capture: 'complete',
      reasons: [],
      omitted: 0,
    },
    files: [
      {
        area: 'shared',
        path: 'input.txt',
        state: 'present',
        bytes: 4,
        sha256: createHash('sha256').update('mock').digest('hex'),
        text: true,
      },
    ],
    texts: [{ area: 'shared', path: 'input.txt', data: Buffer.from('mock').toString('base64') }],
  };
  let reply: unknown = capture;
  const calls: { method: string; params: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const execution = {
    snapshot: { capabilities: [workspaceReviewCapability] },
    async call(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
      calls.push({ method, params, signal });
      return reply;
    },
  };
  const workspace = new RemoteWorkspace(
    execution,
    '/synthetic-guest/shared',
    '/synthetic-guest/shared',
  );
  const abort = new AbortController();
  expect(await workspace.captureReview(['input.txt'], abort.signal)).toEqual(capture);
  expect(calls[0]).toMatchObject({
    method: 'workspace.review.capture',
    params: {
      root: '/synthetic-guest/shared',
      canonical: '/synthetic-guest/shared',
      paths: ['input.txt'],
    },
  });
  expect(calls[0].signal).toBeDefined();
  reply = { ...capture, files: [{ ...capture.files[0], sha256: 'a'.repeat(64) }] };
  await expect(workspace.captureReview(['input.txt'])).rejects.toMatchObject({
    code: 'INVALID_EXECUTOR_RESPONSE',
  });
  reply = {
    ...capture,
    snapshot: { ...capture.snapshot, area: 'task' },
    files: capture.files.map((file) => ({ ...file, area: 'task' })),
    texts: capture.texts.map((file) => ({ ...file, area: 'task' })),
  };
  await expect(workspace.captureReview(['input.txt'])).rejects.toMatchObject({
    code: 'INVALID_EXECUTOR_RESPONSE',
  });
  execution.snapshot.capabilities = [];
  const count = calls.length;
  expect((await workspace.captureReview(['input.txt'])).snapshot).toMatchObject({
    capture: 'unknown',
    reasons: ['unsupported'],
  });
  expect(calls).toHaveLength(count);
});

test('remote workspace errors never fall back to host files', async () => {
  const workspace = new RemoteWorkspace(
    {
      async call() {
        throw new Error('MOCK_GUEST_OFFLINE');
      },
    },
    '/synthetic-no-host-directory',
  );
  await expect(workspace.prepare()).rejects.toThrowError(/MOCK_GUEST_OFFLINE/);
  await expect(workspace.read('mock.txt')).rejects.toThrowError(/MOCK_GUEST_OFFLINE/);
});
