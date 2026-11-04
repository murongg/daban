export interface VmConnection {
  provider: 'qemu';
  enabled: boolean;
  vmId: string;
  host: string;
  sshPort: number;
  user: string;
  identityFile: string;
  hostKey: string;
}

export interface VmConnectionStatus {
  supported: boolean;
  connection?: VmConnection;
}

export type VmCommand = { type: 'vm.status' | 'vm.native' };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function isVmConnection(value: unknown): value is VmConnection {
  if (!object(value) || Object.keys(value).length !== 8) return false;
  return (
    value.provider === 'qemu' &&
    typeof value.enabled === 'boolean' &&
    typeof value.vmId === 'string' &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.vmId) &&
    value.host === '127.0.0.1' &&
    Number.isInteger(value.sshPort) &&
    Number(value.sshPort) >= 1 &&
    Number(value.sshPort) <= 65535 &&
    typeof value.user === 'string' &&
    /^[a-z_][a-z0-9_-]{0,31}$/.test(value.user) &&
    typeof value.identityFile === 'string' &&
    value.identityFile.length > 0 &&
    value.identityFile.length <= 4096 &&
    !/["<>|?*]/.test(value.identityFile) &&
    !Array.from(value.identityFile).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    typeof value.hostKey === 'string' &&
    /^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value.hostKey)
  );
}

export function isVmConnectionStatus(value: unknown): value is VmConnectionStatus {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['supported', 'connection'].includes(key)) &&
    typeof value.supported === 'boolean' &&
    (value.connection === undefined || (value.supported && isVmConnection(value.connection)))
  );
}

export function isVmCommand(value: unknown): value is VmCommand {
  return (
    object(value) &&
    (value.type === 'vm.status' || value.type === 'vm.native') &&
    Object.keys(value).length === 1
  );
}
