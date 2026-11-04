import { isVmCommand, isVmConnection, isVmConnectionStatus } from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';

const connection = {
  provider: 'qemu',
  enabled: true,
  vmId: '11111111-2222-4333-8444-555555555555',
  host: '127.0.0.1',
  sshPort: 22,
  user: 'mock-bot',
  identityFile: 'C:/mock/id_ed25519',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

it('accepts only a bounded managed VM identity and SSH public-key configuration', () => {
  expect(isVmConnection(connection)).toBe(true);
  for (const patch of [
    { vmId: "mock'; Stop-VM *" },
    { host: '-oProxyCommand=mock' },
    { host: 'mock.test\nHost *' },
    { sshPort: 0 },
    { sshPort: 65536 },
    { user: '-root' },
    { identityFile: 'mock\nkey' },
    { hostKey: 'ssh-rsa SYNTHETIC' },
    { token: 'SYNTHETIC SECRET' },
  ])
    expect(isVmConnection({ ...connection, ...patch })).toBe(false);
});

it('validates local VM commands before dispatch and never accepts credential contents', () => {
  for (const command of [{ type: 'vm.status' }, { type: 'vm.native' }]) {
    expect(isVmCommand(command)).toBe(true);
    expect(parseCommand(command)).toEqual(command);
  }
  expect(isVmCommand({ type: 'vm.native', force: true })).toBe(false);
  expect(isVmConnectionStatus({ supported: true, connection })).toBe(true);
  expect(isVmConnectionStatus({ supported: false })).toBe(true);
  expect(isVmConnectionStatus({ supported: true, token: 'mock' })).toBe(false);
});

it('requires explicit acceleration intent and keeps managed QEMU credentials out of renderer configuration commands', () => {
  for (const command of [
    { type: 'setup.start', mode: 'tcg' },
    { type: 'setup.start', mode: 'whpx' },
    { type: 'setup.enable', confirmed: true },
    { type: 'setup.restart', confirmed: true },
  ])
    expect(parseCommand(command)).toStrictEqual(command);
  for (const command of [
    { type: 'setup.start', mode: 'untrusted' },
    { type: 'setup.enable' },
    { type: 'setup.restart', confirmed: false },
    { type: 'setup.start', command: 'mock' },
  ])
    expect(() => parseCommand(command)).toThrow('INVALID_COMMAND');
});
