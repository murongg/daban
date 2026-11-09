import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveVmConnection } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  type DiagnosticReport,
  diagnosticIds,
  disconnected,
  type RuntimeCommand,
  type VmConnection,
} from '@daban/protocol';
import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, command: unknown) => Promise<unknown>),
  modes: [] as string[],
  mode: 'native',
  busy: false,
  update: vi.fn(async () => {}),
  vmFailure: '',
  windows: [] as { webContents: unknown }[],
  identity: {} as Record<string, unknown>,
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mock.windows },
  ipcMain: {
    handle: (_channel: string, handler: typeof mock.handler) => {
      mock.handler = handler;
    },
    removeHandler: vi.fn(),
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('./native-daemon', () => ({
  NativeDaemon: class {
    constructor(
      _config: unknown,
      readonly mode = 'native',
    ) {
      mock.modes.push(mode);
    }
    async ensure() {
      mock.mode = this.mode;
      if (this.mode === 'vm' && mock.vmFailure) throw new Error(mock.vmFailure);
      const client = {
        status: async () => ({
          ...disconnected('ready'),
          agent: {
            location: 'host',
            execution: mock.mode === 'vm' ? 'linux-vm' : 'local-workspace',
            privilege: 'workspace',
            approvals: 'host',
          },
        }),
        releaseInputs: async () => {},
        invoke: async (command: RuntimeCommand) =>
          command.type === 'runtime.inspect'
            ? {
                scope: 'runtime',
                checkedAt: '2026-01-01T00:00:00.000Z',
                checks: diagnosticIds.runtime.map((id) => ({ id, state: 'ready' })),
              }
            : { available: true, revision: 0, busy: false, vm: 'unknown' },
      };
      return { client, snapshot: await client.status() };
    }
    async close() {}
  },
}));
vi.mock('./host-selection', () => ({
  reconcileAgent: async (_config: unknown, _native: boolean, options?: { restart?: boolean }) => {
    if (options?.restart && mock.busy) throw new Error('AGENT_UPDATE_BUSY');
    return false;
  },
}));
vi.mock('./upgrade', () => ({ prepareAgentUpdate: mock.update }));
vi.mock('./unix', () => ({
  readAgentToken: async () => 'a'.repeat(64),
  unixFetch: (_socket: string, options: { certificateFile?: string }) => async (url: string) => {
    if (!options.certificateFile) throw new Error('SYNTHETIC MISSING TLS CERTIFICATE');
    if (url.endsWith('/api/host/environment'))
      return Response.json({ required: false, target: 'linux', phase: 'existing' });
    return Response.json(mock.identity);
  },
}));

import { daemonScope } from './daemon';
import { runtimeService } from './service';
import { controlSocket } from './socket';

it('routes Windows VM settings through the detached host and keeps native mode when a busy handoff is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-service-vm-'));
  const userData = await secureDirectory(path.join(root, 'private'));
  const frame = { url: 'file:///mock/index.html' },
    sender = { mainFrame: frame, send: vi.fn() };
  mock.windows.push({ webContents: sender });
  const service = runtimeService(
    userData,
    frame.url,
    path.join(root, 'unused-environment'),
    undefined,
    {
      entry: path.join(root, 'mock-main'),
      executable: path.join(root, 'mock-node'),
      nativeFirst: true,
    },
    undefined,
    'win32',
  );
  const scope = daemonScope(path.join(userData, 'agent'), path.join(userData, 'runtime.json'));
  mock.identity = {
    role: 'agent',
    scope,
    dataRoot: path.join(userData, 'agent'),
    socketPath: controlSocket(path.join(userData, 'agent.sock'), scope),
  };
  const connection: VmConnection = {
    provider: 'qemu',
    enabled: true,
    vmId: '11111111-2222-4333-8444-555555555555',
    host: '127.0.0.1',
    sshPort: 22,
    user: 'mock-bot',
    identityFile: path.join(root, 'mock-key'),
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  const invoke = (command: unknown) => mock.handler!({ sender, senderFrame: frame }, command);
  try {
    mock.modes.length = 0;
    await saveVmConnection(path.join(userData, 'runtime.json'), connection);
    await service.connect();
    mock.busy = true;
    expect(await invoke({ type: 'vm.native' })).toEqual({
      ok: false,
      error: 'AGENT_UPDATE_BUSY',
    });
    expect(await invoke({ type: 'vm.status' })).toEqual({
      ok: true,
      value: { supported: true, connection },
    });
    mock.busy = false;
    expect(mock.modes.at(-1)).toBe('native');
    const report = (await invoke({ type: 'runtime.inspect' })) as {
      ok: boolean;
      value: DiagnosticReport;
    };
    expect(report.ok).toBe(true);
    expect(report.value.checks.find((check) => check.id === 'agent')?.state).toBe('ready');
    mock.vmFailure = 'EXECUTOR_SSH_HOST_KEY';
    expect((await service.connect()).phase).toBe('ready');
    expect(mock.modes.every((mode) => mode === 'native')).toBe(true);
    mock.vmFailure = '';
    await service.connect();
    await service.prepareUpdate();
    expect(mock.update).toHaveBeenCalled();
    await service.resumeAfterUpdate();
    expect(await invoke({ type: 'vm.native' })).toMatchObject({ ok: true });
    expect(mock.modes.at(-1)).toBe('native');
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
