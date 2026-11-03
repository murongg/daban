import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VmConnection } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { readVmConnection, saveVmConnection, vmConnectionTarget } from './vm-config.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-vm-config-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const connection: VmConnection = {
    provider: 'hyperv',
    enabled: true,
    vmId: '11111111-2222-4333-8444-555555555555',
    host: '192.0.2.10',
    sshPort: 22,
    user: 'mock-bot',
    identityFile: path.join(root, 'id_ed25519'),
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  return { root, file: path.join(root, 'private/runtime.json'), connection };
}

test('VM connection settings round trip privately without credentials and keep target identity across IP changes', async (t) => {
  const f = await fixture(t);
  expect(await readVmConnection(f.file)).toBe(undefined);
  await saveVmConnection(f.file, f.connection);
  expect(await readVmConnection(f.file)).toStrictEqual(f.connection);
  expect(vmConnectionTarget(f.connection)).toBe(
    vmConnectionTarget({ ...f.connection, host: '192.0.2.11' }),
  );
  expect(vmConnectionTarget(f.connection)).not.toBe(
    vmConnectionTarget({ ...f.connection, user: 'mock-other' }),
  );
});

test('managed QEMU connections require loopback, retain identity across forwarding changes and cannot alias Hyper-V', async (t) => {
  const f = await fixture(t);
  const connection = { ...f.connection, provider: 'qemu' as const, host: '127.0.0.1' };
  await saveVmConnection(f.file, connection);
  expect(await readVmConnection(f.file)).toStrictEqual(connection);
  expect(vmConnectionTarget(connection)).toBe(
    vmConnectionTarget({ ...connection, sshPort: 23456 }),
  );
  expect(vmConnectionTarget(connection)).not.toBe(vmConnectionTarget(f.connection));
  await expect(saveVmConnection(f.file, { ...connection, host: '192.0.2.10' })).rejects.toThrow(
    'VM_CONFIG_INVALID',
  );
});

test('VM configuration refuses malformed keys, relative identities, and linked or replaced configuration files', async (t) => {
  const f = await fixture(t);
  await expect(
    saveVmConnection(f.file, { ...f.connection, identityFile: 'relative-key' }),
  ).rejects.toThrow(/VM_CONFIG_INVALID/);
  await expect(
    saveVmConnection(f.file, { ...f.connection, hostKey: `ssh-ed25519 ${'A'.repeat(68)}` }),
  ).rejects.toThrow(/VM_CONFIG_INVALID/);
  await mkdir(path.dirname(f.file), { recursive: true });
  const target = path.join(f.root, 'protected.json');
  await writeFile(target, 'SYNTHETIC PROTECTED');
  await symlink(target, f.file);
  await expect(readVmConnection(f.file)).rejects.toThrow(/VM_CONFIG_UNSAFE/);
  await expect(saveVmConnection(f.file, f.connection)).rejects.toThrow(/VM_CONFIG_UNSAFE/);
  expect(await readFile(target, 'utf8')).toBe('SYNTHETIC PROTECTED');
});
