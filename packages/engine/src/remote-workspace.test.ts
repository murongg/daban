import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(files[0].path, 'mock.txt');
  assert.deepEqual(calls.find((call) => call.method === 'workspace.write')?.params, {
    handleId: 'mock-handle',
    name: 'mock.txt',
    data: Buffer.from('mock').toString('base64'),
  });
  assert.equal(calls.at(-1)?.method, 'workspace.close');
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
  await assert.rejects(workspace.prepare(), /MOCK_GUEST_OFFLINE/);
  await assert.rejects(workspace.read('mock.txt'), /MOCK_GUEST_OFFLINE/);
});
