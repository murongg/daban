import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ExecutionSnapshot, executionCapabilities } from '@daban/protocol';
import { expect, test } from 'vitest';
import { ExecutionConnection } from './connection.js';
import { LinuxExecution } from './linux-execution.js';
import { HostPower } from './power.js';

const snapshot: ExecutionSnapshot = {
  role: 'executor',
  version: 1,
  boot: 'mock-boot',
  nonce: 'mock-nonce',
  capabilities: [...executionCapabilities],
  computer: {
    mode: 'agent',
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
    environment: {
      platform: 'linux',
      arch: 'arm64',
      kernel: 'synthetic',
      node: 'synthetic',
      browser: '',
    },
    events: [],
    bots: {},
  },
  status: { available: true, revision: 0, limit: 2, items: [] },
};

test('Linux observations never wake a stopped VM; concurrent execution shares a start and persists verified recovery metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-lazy-linux-'));
  let starts = 0,
    reconnects = 0,
    snapshots = 0,
    failStart = false,
    effects = 0,
    running = false;
  const link = {
    ensure: async () => {
      if (failStart) throw new Error('EXECUTOR_HYPERVISOR_UNAVAILABLE');
      starts++;
      running = true;
      return { origin: 'http://127.0.0.1:12345', token: 'synthetic' };
    },
    reconnect: async () => {
      reconnects++;
      if (!running) throw new Error('EXECUTOR_OFFLINE');
      return { origin: 'http://127.0.0.1:12345', token: 'synthetic' };
    },
    state: async () => (running ? ('running' as const) : ('stopped' as const)),
    startVm: async () => {
      throw new Error('SYNTHETIC_UNREQUESTED_POWER');
    },
    stopVm: async () => {
      throw new Error('SYNTHETIC_UNREQUESTED_POWER');
    },
    close: async () => {},
  };
  const createOwner = () =>
    new LinuxExecution({
      dataRoot: root,
      load: async () => ({ link, target: 'a'.repeat(64) }),
      power: (options) => new HostPower(options),
      owner: () => undefined,
      connection: (value, options) =>
        new ExecutionConnection(value, {
          ...options,
          create: () => ({
            ready: Promise.resolve(snapshot),
            snapshot,
            refresh: async () => {
              snapshots++;
              return snapshot;
            },
            call: async (method) => {
              if (method === 'workspace.base') return '/synthetic-linux/shared';
              if (method === 'tools.invoke') {
                effects++;
                throw new Error('EXECUTION_OUTCOME_UNKNOWN');
              }
              return { ok: true };
            },
          }),
        }),
    });
  const owner = createOwner();
  const owners = [owner];
  t.onTestFinished(async () => {
    for (const item of owners) await item.close();
    await rm(root, { recursive: true, force: true });
  });
  expect(await owner.available()).toBe(true);
  await expect(owner.refresh()).rejects.toThrow('EXECUTOR_OFFLINE');
  await expect(
    owner.call('computer.request', { method: 'GET', path: '/api/bots/mock-bot/frame' }),
  ).rejects.toThrow('EXECUTOR_OFFLINE');
  await expect(
    owner.call('computer.request', {
      method: 'POST',
      path: '/api/computers/receipt',
      body: { id: 'mock-request', bot: 'mock-bot' },
    }),
  ).rejects.toThrow('EXECUTOR_OFFLINE');
  expect(starts).toBe(0);
  expect(
    reconnects,
    'passive polling must not repeatedly spawn VM probes after a stopped VM was observed',
  ).toBe(1);
  failStart = true;
  await expect(owner.call('workspace.base', {})).rejects.toMatchObject({
    code: 'EXECUTOR_HYPERVISOR_UNAVAILABLE',
  });
  failStart = false;
  await Promise.all([
    owner.call('workspace.create', { parts: ['mock-one'] }),
    owner.call('workspace.create', { parts: ['mock-two'] }),
  ]);
  expect(starts).toBe(1);
  const observations = snapshots;
  await Promise.all([
    owner.call('tools.poll', { runId: 'mock-run', operationId: 'mock-operation' }),
    owner.call('tools.poll', { runId: 'mock-run', operationId: 'mock-operation' }),
  ]);
  expect(
    snapshots,
    'output polling must reuse the authenticated connection instead of refreshing and syncing recovery metadata',
  ).toBe(observations);
  expect(
    JSON.parse(await readFile(path.join(root, 'execution-snapshot.json'), 'utf8')),
  ).toMatchObject({
    target: 'a'.repeat(64),
    workspaceRoot: '/synthetic-linux/shared',
    snapshot: { boot: 'mock-boot' },
  });
  await expect(owner.call('tools.invoke', { runId: 'mock-run' })).rejects.toThrow(
    'EXECUTION_OUTCOME_UNKNOWN',
  );
  expect(effects).toBe(1);
  expect(starts).toBe(1);
  await owner.close();
  const restored = createOwner();
  owners.push(restored);
  expect(await restored.available()).toBe(true);
  await new Promise((resolve) => setImmediate(resolve));
  expect((await restored.refresh()).boot).toBe('mock-boot');
  expect(starts).toBe(1);
});
