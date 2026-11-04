import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { reconcileAgent } from './host-selection';

const config = {
  vmConfig: path.resolve('synthetic-runtime.json'),
  dataRoot: path.resolve('synthetic-data'),
  socketPath: path.resolve('synthetic.sock'),
  scope: 'a'.repeat(64),
  entry: path.resolve('runtime-new/main.js'),
  executable: path.resolve('runtime-new/node'),
};
it('requires an idle authenticated handoff for an explicit VM settings change even when the execution mode is unchanged', async () => {
  const handoff = vi.fn(async () => {});
  expect(
    await reconcileAgent(config, true, {
      identity: async () => ({ role: 'agent', ...config }),
      execution: async () => 'local-workspace',
      handoff,
      restart: true,
    }),
  ).toBe(true);
  expect(handoff).toHaveBeenCalledTimes(1);
});
it('hands off only a matching host whose execution mode or immutable runtime files changed', async () => {
  let identity = { role: 'agent', ...config };
  const handoff = vi.fn(async () => {});
  const deps = {
    identity: async () => identity,
    execution: async () => 'local-workspace',
    handoff,
  };
  expect(await reconcileAgent(config, true, deps)).toBe(false);
  expect(handoff).not.toHaveBeenCalled();
  expect(await reconcileAgent(config, false, deps)).toBe(true);
  identity = { ...identity, entry: path.resolve('runtime-old/main.js') };
  expect(await reconcileAgent(config, true, deps)).toBe(true);
  identity = { ...identity, scope: 'b'.repeat(64) };
  await expect(reconcileAgent(config, true, deps)).rejects.toThrow('AGENT_DAEMON_SCOPE_MISMATCH');
  expect(handoff).toHaveBeenCalledTimes(2);
});
it('preserves a busy old host rather than interrupting its jobs', async () => {
  await expect(
    reconcileAgent(config, false, {
      identity: async () => ({ role: 'agent', ...config }),
      execution: async () => 'local-workspace',
      handoff: async () => {
        throw Error('AGENT_UPDATE_BUSY');
      },
    }),
  ).rejects.toThrow('AGENT_UPDATE_BUSY');
});
it('a fresh private socket needs no handoff', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-selection-'));
  try {
    expect(
      await reconcileAgent({ ...config, socketPath: path.join(root, 'missing.sock') }, true),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('upgrades a legacy host that does not advertise immutable runtime paths', async () => {
  const handoff = vi.fn(async () => {});
  expect(
    await reconcileAgent(config, false, {
      identity: async () => ({
        role: 'agent',
        scope: config.scope,
        dataRoot: config.dataRoot,
        socketPath: config.socketPath,
      }),
      execution: async () => 'linux-vm',
      handoff,
    }),
  ).toBe(true);
  expect(handoff).toHaveBeenCalledTimes(1);
});
