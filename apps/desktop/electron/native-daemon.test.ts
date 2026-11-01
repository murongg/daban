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
    status = async () => ({ phase: 'ready' });
  },
}));

import { NativeDaemon } from './native-daemon';

it('launches a single native-only agent and closing the client leaves its background process running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-native-daemon-'));
  const config = {
    dataRoot: path.join(root, 'data'),
    socketPath: path.join(root, 'mock-socket'),
    vmConfig: path.join(root, 'unused-vm.json'),
    executable: path.join(root, 'mock-node'),
    entry: path.join(root, 'mock-agent'),
  };
  await writeFile(config.executable, 'SYNTHETIC EXECUTABLE');
  await writeFile(config.entry, 'SYNTHETIC ENTRY');
  mock.identity = { ...config, scope: daemonScope(config.dataRoot, config.vmConfig) };
  mock.active = false;
  mock.spawn.mockReset();
  mock.unref.mockReset();
  mock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    Object.assign(child, { unref: mock.unref });
    queueMicrotask(() => {
      mock.active = true;
      child.emit('spawn');
    });
    return child;
  });
  const daemon = new NativeDaemon(config);
  try {
    const [first, second] = await Promise.all([daemon.ensure(), daemon.ensure()]);
    expect(first).toBe(second);
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    const [program, args, options] = mock.spawn.mock.calls[0];
    expect(program).toBe(config.executable);
    expect(args).toContain('native');
    expect(args).toContain('--mode');
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
    expect(options.env).not.toHaveProperty('DEEPSEEK_API_KEY');
    await daemon.close();
    expect(mock.unref).toHaveBeenCalledTimes(1);
    const reconnect = new NativeDaemon(config);
    await reconnect.ensure();
    await reconnect.close();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    mock.identity = { ...mock.identity, scope: 'b'.repeat(64) };
    await expect(new NativeDaemon(config).ensure()).rejects.toThrow('AGENT_DAEMON_SCOPE_MISMATCH');
    expect(mock.spawn).toHaveBeenCalledTimes(1);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
