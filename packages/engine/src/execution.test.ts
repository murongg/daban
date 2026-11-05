import { isExecutionSnapshot } from '@daban/protocol';
import { expect, test } from 'vitest';
import { RemoteExecutor } from './execution.js';

const snapshot = {
  role: 'executor',
  version: 1,
  boot: 'mock-boot',
  nonce: 'mock-nonce',
  capabilities: ['workspace', 'tools', 'computer', 'processes', 'documents'],
  computer: {
    mode: 'agent',
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
    environment: { platform: 'linux', arch: 'arm64', kernel: 'mock', node: 'mock', browser: '' },
    events: [],
    bots: {},
  },
  status: { available: true, revision: 0, limit: 2, items: [] },
};

test('executor snapshots negotiate the bounded browser task capability without accepting arbitrary capabilities', () => {
  expect(
    isExecutionSnapshot({
      ...snapshot,
      capabilities: [
        ...snapshot.capabilities,
        'model-capabilities-v1',
        'skill-packages-v1',
        'browser-task-v1',
      ],
    }),
  ).toBe(true);
  expect(
    isExecutionSnapshot({
      ...snapshot,
      capabilities: [...snapshot.capabilities, 'synthetic-unknown'],
    }),
  ).toBe(false);
});

test('an existing executor can still serve ordinary file reads after a retired capability is removed', async () => {
  const remote = new RemoteExecutor({
    url: 'http://127.0.0.1:12345/exec',
    token: 'synthetic-token',
    fetcher: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      return Response.json({
        role: 'executor',
        version: 1,
        id: request.id,
        boot: 'mock-boot',
        ok: true,
        value:
          request.method === 'computer.snapshot'
            ? { ...snapshot, capabilities: [...snapshot.capabilities, 'file-observation-read-v1'] }
            : 'SYNTHETIC FILE CONTENT',
      });
    },
  });
  await remote.ready;
  expect(await remote.call('workspace.read', { root: '/mock/workspace', path: 'mock.txt' })).toBe(
    'SYNTHETIC FILE CONTENT',
  );
});

test('remote executor rejects authority-shaped or mismatched role snapshots', async () => {
  for (const value of [
    { ...snapshot, role: 'agent' },
    { ...snapshot, model: { configured: true } },
    { ...snapshot, computer: { ...snapshot.computer, model: {} } },
  ]) {
    const remote = new RemoteExecutor({
      url: 'http://127.0.0.1:12345/exec',
      token: 'synthetic-token',
      fetcher: async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        return Response.json({
          role: 'executor',
          version: 1,
          id: request.id,
          boot: 'mock-boot',
          ok: true,
          value,
        });
      },
    });
    await expect(remote.ready).rejects.toMatchObject({ code: 'EXECUTION_INVALID_RESPONSE' });
  }
});

test('remote executor sends no host environment and never replays an uncertain mutation', async () => {
  let calls = 0;
  const remote = new RemoteExecutor({
    url: 'http://127.0.0.1:12345/exec',
    token: 'synthetic-token',
    fetcher: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      expect(request.role).toBe('executor');
      expect(new Headers(options?.headers).get('x-daban-execution-token')).toBe('synthetic-token');
      if (++calls === 1)
        return Response.json({
          role: 'executor',
          version: 1,
          id: request.id,
          boot: 'mock-boot',
          ok: true,
          value: snapshot,
        });
      throw new Error('Synthetic lost acknowledgement');
    },
  });
  await remote.ready;
  await expect(
    remote.call('process.start', {
      id: 'mock-command',
      command: 'printf synthetic',
      cwd: '/mock/workspace',
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_OUTCOME_UNKNOWN' });
  expect(calls).toBe(2);
});

test('a same-kernel service restart cannot silently replace the pinned execution owner', async () => {
  let calls = 0;
  const remote = new RemoteExecutor({
    url: 'http://127.0.0.1:12345/exec',
    token: 'synthetic-token',
    fetcher: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      return Response.json({
        role: 'executor',
        version: 1,
        id: request.id,
        boot: 'mock-boot',
        ok: true,
        value: { ...snapshot, nonce: ++calls === 1 ? 'mock-nonce' : 'mock-successor' },
      });
    },
  });
  await remote.ready;
  await expect(remote.refresh()).rejects.toMatchObject({ code: 'EXECUTION_GUEST_RESTARTED' });
  expect(remote.snapshot?.nonce).toBe('mock-nonce');
});

test('ordinary status calls also reject guest-supplied control-plane fields', async () => {
  for (const method of ['computer.snapshot', 'computer.status']) {
    let calls = 0;
    const remote = new RemoteExecutor({
      url: 'http://127.0.0.1:12345/exec',
      token: 'synthetic-token',
      fetcher: async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        const value =
          ++calls === 1
            ? snapshot
            : method === 'computer.snapshot'
              ? { ...snapshot, model: { configured: true } }
              : { ...snapshot.status, approval: true };
        return Response.json({
          role: 'executor',
          version: 1,
          id: request.id,
          boot: 'mock-boot',
          ok: true,
          value,
        });
      },
    });
    await remote.ready;
    await expect(remote.call(method, {})).rejects.toMatchObject({
      code: 'EXECUTION_INVALID_RESPONSE',
    });
  }
});

test('document extraction transport failures stay read-only and are never retried', async () => {
  let calls = 0;
  const remote = new RemoteExecutor({
    url: 'http://127.0.0.1:12345/exec',
    token: 'synthetic-token',
    fetcher: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      if (++calls === 1)
        return Response.json({
          role: 'executor',
          version: 1,
          id: request.id,
          boot: 'mock-boot',
          ok: true,
          value: snapshot,
        });
      throw new Error('SYNTHETIC-READ-TRANSPORT');
    },
  });
  await remote.ready;
  await expect(
    remote.call('documents.extract', {
      name: 'synthetic.pdf',
      data: Buffer.from('%PDF-SYNTHETIC').toString('base64'),
    }),
  ).rejects.toMatchObject({ code: 'EXECUTION_UNAVAILABLE' });
  expect(calls).toBe(2);
});
