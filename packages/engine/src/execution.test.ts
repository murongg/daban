import assert from 'node:assert/strict';
import test from 'node:test';
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
    await assert.rejects(remote.ready, { code: 'EXECUTION_INVALID_RESPONSE' });
  }
});

test('remote executor sends no host environment and never replays an uncertain mutation', async () => {
  let calls = 0;
  const remote = new RemoteExecutor({
    url: 'http://127.0.0.1:12345/exec',
    token: 'synthetic-token',
    fetcher: async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      assert.equal(request.role, 'executor');
      assert.equal(new Headers(options?.headers).get('x-daban-execution-token'), 'synthetic-token');
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
  await assert.rejects(
    remote.call('process.start', {
      id: 'mock-command',
      command: 'printf synthetic',
      cwd: '/mock/workspace',
    }),
    { code: 'EXECUTION_OUTCOME_UNKNOWN' },
  );
  assert.equal(calls, 2);
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
  await assert.rejects(remote.refresh(), { code: 'EXECUTION_GUEST_RESTARTED' });
  assert.equal(remote.snapshot?.nonce, 'mock-nonce');
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
    await assert.rejects(remote.call(method, {}), { code: 'EXECUTION_INVALID_RESPONSE' });
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
  await assert.rejects(
    remote.call('documents.extract', {
      name: 'synthetic.pdf',
      data: Buffer.from('%PDF-SYNTHETIC').toString('base64'),
    }),
    { code: 'EXECUTION_UNAVAILABLE' },
  );
  assert.equal(calls, 2);
});
