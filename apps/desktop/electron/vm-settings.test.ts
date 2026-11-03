import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readVmConnection } from '@daban/engine/host';
import type { VmConnection } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { VmSettings } from './vm-settings';

it('switches modes only after authenticated idle handoff and preserves the selected VM when returning to native mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-vm-settings-'));
  try {
    const file = path.join(root, 'private/runtime.json');
    const connection: VmConnection = {
      provider: 'hyperv',
      enabled: true,
      vmId: '11111111-2222-4333-8444-555555555555',
      host: '192.0.2.10',
      sshPort: 22,
      user: 'mock-bot',
      identityFile: path.join(root, 'mock-key'),
      hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const handoff = vi.fn(async () => {}),
      reconnect = vi.fn(async () => {});
    const owner = new VmSettings({ file, platform: 'win32', handoff, reconnect });
    expect(await owner.status()).toEqual({ supported: true });
    handoff.mockRejectedValueOnce(new Error('AGENT_UPDATE_BUSY'));
    await expect(owner.configure(connection)).rejects.toThrow('AGENT_UPDATE_BUSY');
    expect(await readVmConnection(file)).toBeUndefined();
    expect(reconnect).not.toHaveBeenCalled();
    await owner.configure(connection);
    expect((await owner.status()).connection).toEqual(connection);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await owner.native();
    expect((await owner.status()).connection).toEqual({ ...connection, enabled: false });
    expect(reconnect).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not read or overwrite macOS VM configuration', async () => {
  const handoff = vi.fn(async () => {}),
    reconnect = vi.fn(async () => {});
  const owner = new VmSettings({
    file: '/mock/untouched/runtime.json',
    platform: 'darwin',
    handoff,
    reconnect,
  });
  expect(await owner.status()).toEqual({ supported: false });
  await expect(owner.native()).rejects.toThrow('VM_PLATFORM_UNSUPPORTED');
  expect(handoff).not.toHaveBeenCalled();
});
