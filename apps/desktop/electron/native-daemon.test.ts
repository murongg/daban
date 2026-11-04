import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { daemonScope } from './daemon';

const mock = vi.hoisted(() => ({
  active: false,
  identity: {} as Record<string, unknown>,
  spawn: vi.fn(),
  unref: vi.fn(),
  execution: 'local-workspace',
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => mock.spawn(...args),
}));
vi.mock('./unix', () => ({
  readAgentToken: async () => 'a'.repeat(64),
  unixFetch: () => async () => {
    if (!mock.active) throw new Error('MOCK_NO_LISTENER');
    return Response.json(mock.identity);
  },
}));
vi.mock('./runtime', () => ({
  RuntimeClient: class {
    status = async () => ({ phase: 'ready', agent: { execution: mock.execution } });
  },
}));

import { NativeDaemon } from './native-daemon';

it('surfaces only a fresh VM startup failure instead of waiting through the boot deadline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-vm-startup-'));
  const config = {
    dataRoot: path.join(root, 'private'),
    socketPath: path.join(root, 'mock.sock'),
    vmConfig: path.join(root, 'runtime.json'),
    executable: path.join(root, 'mock-node'),
    entry: path.join(root, 'mock-main'),
  };
  await writeFile(config.executable, 'SYNTHETIC EXECUTABLE');
  await writeFile(config.entry, 'SYNTHETIC ENTRY');
  mock.active = false;
  mock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    Object.assign(child, { unref: () => {} });
    queueMicrotask(() => {
      child.emit('spawn');
      writeFile(
        path.join(config.dataRoot, 'progress.json'),
        JSON.stringify({ required: true, phase: 'failed', error: 'EXECUTOR_SSH_HOST_KEY' }),
        { mode: 0o600 },
      ).catch((error: unknown) => child.emit('error', error));
    });
    return child;
  });
  const daemon = new NativeDaemon(config, 'vm');
  const pending = daemon.ensure();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('SYNTHETIC DEADLINE')), 2000);
        }),
      ]),
    ).rejects.toThrow('EXECUTOR_SSH_HOST_KEY');
  } finally {
    clearTimeout(timer);
    await daemon.close();
    await pending.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['native', 'vm'] as const)(
  'launches a single %s agent and closing the client leaves its background process running',
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-native-daemon-'));
    const config = {
      dataRoot: path.join(root, 'data'),
      socketPath: path.join(root, 'mock-socket'),
      vmConfig: path.join(root, 'unused-vm.json'),
      executable: path.join(root, 'mock-node'),
      entry: path.join(root, 'mock-agent'),
      qemuBundle: path.join(root, 'mock resources', 'qemu'),
    };
    await writeFile(config.executable, 'SYNTHETIC EXECUTABLE');
    await writeFile(config.entry, 'SYNTHETIC ENTRY');
    mock.identity = { ...config, scope: daemonScope(config.dataRoot, config.vmConfig) };
    mock.active = false;
    mock.spawn.mockReset();
    mock.unref.mockReset();
    mock.spawn.mockImplementation((_program: unknown, args: string[]) => {
      mock.execution = args.includes('--mode') ? 'local-workspace' : 'linux-vm';
      const child = new EventEmitter();
      Object.assign(child, { unref: mock.unref });
      queueMicrotask(() => {
        mock.active = true;
        child.emit('spawn');
      });
      return child;
    });
    vi.stubEnv('COMPUTERNAME', 'MOCK-COMPUTER');
    vi.stubEnv('COMSPEC', path.join(root, 'mock-command.exe'));
    vi.stubEnv('ProgramFiles', path.join(root, 'mock-programs'));
    vi.stubEnv('PSModulePath', path.join(root, 'mock-registered-modules'));
    const daemon = new NativeDaemon(config, mode);
    try {
      const [first, second] = await Promise.all([daemon.ensure(), daemon.ensure()]);
      expect(first).toBe(second);
      expect(mock.spawn).toHaveBeenCalledTimes(1);
      expect(mock.spawn.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['--qemu-bundle', config.qemuBundle]),
      );
      if (mode === 'vm') {
        mock.execution = 'local-workspace';
        await expect(new NativeDaemon(config, 'vm').ensure()).rejects.toThrow(
          'AGENT_DAEMON_MODE_MISMATCH',
        );
        expect(mock.spawn).toHaveBeenCalledTimes(1);
        mock.execution = 'linux-vm';
      }
      const [program, args, options] = mock.spawn.mock.calls[0];
      expect(program).toBe(config.executable);
      if (mode === 'native') {
        expect(args).toContain('native');
        expect(args).toContain('--mode');
      } else {
        expect(args).not.toContain('--mode');
      }
      expect(options.detached).toBe(true);
      expect(options.cwd).toBe(config.dataRoot);
      expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(options.windowsHide).toBe(true);
      expect(options.env).not.toHaveProperty('DEEPSEEK_API_KEY');
      expect(options.env.ProgramData).toBe(process.env.ProgramData);
      expect(options.env.COMPUTERNAME).toBe('MOCK-COMPUTER');
      expect(options.env.COMSPEC).toBe(path.join(root, 'mock-command.exe'));
      expect(options.env.ProgramFiles).toBe(path.join(root, 'mock-programs'));
      expect(options.env.PSModulePath).toBe(path.join(root, 'mock-registered-modules'));
      await daemon.close();
      expect(mock.unref).toHaveBeenCalledTimes(1);
      const reconnect = new NativeDaemon(config, mode);
      await reconnect.ensure();
      await reconnect.close();
      expect(mock.spawn).toHaveBeenCalledTimes(1);
      mock.identity = { ...mock.identity, scope: 'b'.repeat(64) };
      await expect(new NativeDaemon(config).ensure()).rejects.toThrow(
        'AGENT_DAEMON_SCOPE_MISMATCH',
      );
      expect(mock.spawn).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
