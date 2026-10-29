import fs, { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type DiagnosticReport, diagnosticIds } from '@daban/protocol';
import { describe, expect, it, vi } from 'vitest';
import { execute, ManagedHost, validateHost } from './host';

const config = {
  limactl: '/synthetic/tools/limactl',
  limaHome: '/synthetic/lima',
  vm: 'bots',
  port: 18767,
};
it.each([255, 0, 1])(
  'classifies a conflicting port only when the private master is absent (status %i)',
  async (masterCode) => {
    const root = await mkdtemp(join(tmpdir(), 'mock-conflicting-port-'));
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<unknown>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MOCK_NO_PORT');
    const local = { ...config, port: address.port };
    const exec = vi.fn(async () => {
      throw new Error('RUNTIME_HOST_COMMAND_FAILED');
    });
    const status = vi.fn(async () => ({ phase: 'ready', protocolVersion: 27 }));
    const host = new ManagedHost(local, join(root, 'socket'), {
      exec,
      client: () => ({ status }) as never,
      probe: async (program) =>
        program === config.limactl
          ? { code: 0, stdout: JSON.stringify({ name: config.vm, status: 'Running' }) }
          : { code: masterCode, stdout: '' },
    });
    let control: string | undefined;
    try {
      await expect(host.connectExisting()).rejects.toThrow('RUNTIME_HOST_COMMAND_FAILED');
      const call = exec.mock.calls.at(-1) as unknown as [string, string[]];
      control = call[1][call[1].indexOf('-S') + 1];
      expect(await host.portConflict()).toBe(masterCode === 255);
      expect(status).not.toHaveBeenCalled();
      expect(connections).toBe(0);
      expect(server.listening).toBe(true);
    } finally {
      await host.close();
      await new Promise<unknown>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      );
      if (control?.startsWith('/tmp/daban-'))
        await rm(dirname(control), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
it('retains an address when a live private control endpoint cannot be verified by ssh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-live-control-'));
  let received = 0;
  const listener = net.createServer((socket) => {
    received++;
    socket.destroy();
  });
  await new Promise<unknown>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('MOCK_NO_PORT');
  const exec = vi.fn(async (_program: string, _args: string[]) => {
    throw new Error('RUNTIME_HOST_COMMAND_FAILED');
  });
  const host = new ManagedHost({ ...config, port: address.port }, join(root, 'socket'), {
    exec,
    client: () => ({ status: async () => ({ phase: 'ready', protocolVersion: 27 }) }) as never,
    probe: async (program) =>
      program === config.limactl
        ? { code: 0, stdout: JSON.stringify({ name: config.vm, status: 'Running' }) }
        : { code: 255, stdout: '' },
  });
  const mux = net.createServer((socket) => socket.destroy());
  let control: string | undefined;
  try {
    await expect(host.connectExisting()).rejects.toThrow('RUNTIME_HOST_COMMAND_FAILED');
    const call = exec.mock.calls.at(-1)!;
    control = call[1][call[1].indexOf('-S') + 1];
    await new Promise<unknown>((resolve, reject) => {
      mux.once('error', reject);
      mux.listen(control, () => resolve(undefined));
    });
    await fs.chmod(control, 0o600);
    expect(await host.portConflict()).toBe(false);
    expect(received).toBe(0);
    expect(listener.listening).toBe(true);
  } finally {
    await host.close();
    if (mux.listening)
      await new Promise<unknown>((resolve, reject) =>
        mux.close((error) => (error ? reject(error) : resolve(undefined))),
      );
    await new Promise<unknown>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve(undefined))),
    );
    if (control?.startsWith('/tmp/daban-'))
      await rm(dirname(control), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
it('connects long app-data paths through independent bounded SSH addresses while keeping logical identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-long-control-'));
  const scopes = ['alpha', 'beta'].map((name) =>
    join(root, `${name}-${'long-data-'.repeat(12)}`, 'runtime-tunnel.sock'),
  );
  const controls = new Set<string>();
  const client = { status: vi.fn(async () => ({ phase: 'ready' })) };
  const hosts = scopes.map(
    (socket) =>
      new ManagedHost(config, socket, {
        exec: vi.fn(async (program: string, args: string[]) => {
          if (program === 'ssh') {
            const address = args[args.indexOf('-S') + 1];
            expect(Buffer.byteLength(address)).toBeLessThanOrEqual(80);
            controls.add(address);
            if (args.includes('check')) throw new Error('no synthetic master');
          }
          return { stdout: '' };
        }),
        client: () => client as never,
      }),
  );
  try {
    for (const [index, host] of hosts.entries()) {
      await expect(host.connect()).resolves.toBeDefined();
      expect(host.socket).toBe(scopes[index]);
    }
    expect(controls.size).toBe(2);
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    for (const socket of controls)
      if (socket.startsWith('/tmp/daban-'))
        await rm(dirname(socket), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

it('retains an old recovery record at the long logical path without creating connection state during inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-long-recovery-'));
  const folder = join(root, 'long-data-'.repeat(12));
  await mkdir(folder, { mode: 0o700 });
  const journal = join(folder, 'runtime-recovery.json');
  await writeFile(journal, 'synthetic corrupt recovery must not be forgotten', { mode: 0o600 });
  const exec = vi.fn(async () => ({ stdout: '' }));
  const host = new ManagedHost(config, join(folder, 'runtime-tunnel.sock'), { exec });
  try {
    expect(await host.recoveryStatus()).toMatchObject({
      available: false,
      error: 'RECOVERY_HOST_STORE_UNAVAILABLE',
    });
    expect(await readdir(folder)).toEqual(['runtime-recovery.json']);
    expect(await readFile(journal, 'utf8')).toBe(
      'synthetic corrupt recovery must not be forgotten',
    );
    expect(exec).not.toHaveBeenCalled();
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('inspects an unconnected long scope without allocating a directory or probing an unrelated mux', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-long-inspection-'));
  const folder = join(root, 'long-data-'.repeat(12));
  await mkdir(folder, { mode: 0o700 });
  const exec = vi.fn();
  const client = vi.fn();
  const probe = vi.fn(async (program: string, args: string[]) => {
    if (program === config.limactl)
      return { code: 0, stdout: JSON.stringify({ name: config.vm, status: 'Running' }) };
    expect(args[args.indexOf('-S') + 1]).toBe('none');
    expect(args).not.toContain('-O');
    return { code: 0, stdout: 'active' };
  });
  const host = new ManagedHost(config, join(folder, 'runtime-tunnel.sock'), {
    exec,
    probe,
    client,
  });
  const makeDirectory = vi.spyOn(fs, 'mkdir');
  try {
    const report = await host.inspect();
    expect(report.checks.find((row) => row.id === 'tunnel')?.state).toBe('unavailable');
    expect(report.checks.find((row) => row.id === 'service')?.state).toBe('ready');
    expect(report.checks.find((row) => row.id === 'agent')?.state).toBe('unchecked');
    expect(exec).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
  } finally {
    makeDirectory.mockRestore();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not start a VM when the owner closes during asynchronous control-directory preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-closing-control-'));
  const original = fs.mkdir;
  let entered!: () => unknown, release!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  let created = '';
  vi.spyOn(fs, 'mkdir').mockImplementationOnce(async (...args) => {
    created = String(args[0]);
    entered();
    await gate;
    return Reflect.apply(original, fs, args);
  });
  const exec = vi.fn(async () => ({ stdout: '' }));
  const host = new ManagedHost(config, join(root, 'long-data-'.repeat(12), 'runtime-tunnel.sock'), {
    exec,
  });
  const connection = host.connect();
  try {
    await started;
    const closing = host.close();
    release();
    await expect(connection).rejects.toThrow();
    await closing;
    expect(
      exec.mock.calls.some((call) => (call as unknown as [string])[0] === config.limactl),
    ).toBe(false);
  } finally {
    release();
    vi.restoreAllMocks();
    await host.close();
    if (created.startsWith('/tmp/daban-')) await fs.rmdir(created);
    await rm(root, { recursive: true, force: true });
  }
});

it('inspects the configured VM, owned tunnel and service without starting or repairing anything', async () => {
  const exec = vi.fn();
  const probe = vi.fn(async (program: string, args: string[]) => ({
    code: 0,
    stdout:
      program === config.limactl
        ? JSON.stringify({ name: config.vm, status: 'Running', private: 'SYNTHETIC-PRIVATE' })
        : args.includes('is-active')
          ? 'active\n'
          : 'SYNTHETIC-PRIVATE',
  }));
  const report: DiagnosticReport = {
    scope: 'runtime',
    checkedAt: '2026-01-01T00:00:00.000Z',
    checks: diagnosticIds.runtime.map((id) => ({ id, state: 'ready' })),
  };
  const client = {
    status: vi.fn(async () => ({ phase: 'ready', protocolVersion: 23 })),
    invoke: vi.fn(async () => report),
  };
  const host = new ManagedHost(config, '/mock/tunnel.sock', {
    exec,
    probe,
    client: () => client as never,
  });
  const [a, b] = await Promise.all([host.inspect(), host.inspect()]);
  expect(a).toEqual(b);
  expect(a.checks.every((row) => row.state === 'ready')).toBe(true);
  expect(JSON.stringify(a)).not.toContain('SYNTHETIC-PRIVATE');
  expect(probe).toHaveBeenCalledTimes(3);
  expect(exec).not.toHaveBeenCalled();
  expect(client.invoke).toHaveBeenCalledWith({ type: 'runtime.inspect' });
  await host.close();
  expect(exec).not.toHaveBeenCalled();
});
it('reports stopped, malformed and inaccessible VM state without touching services or an unrelated local listener', async () => {
  for (const stdout of [
    JSON.stringify({ name: config.vm, status: 'Stopped' }),
    'SYNTHETIC-PRIVATE',
    JSON.stringify({ name: 'another-vm', status: 'Running' }),
  ]) {
    const probe = vi.fn(async () => ({ code: 0, stdout }));
    const client = vi.fn();
    const host = new ManagedHost(config, '/mock/tunnel.sock', { probe, client });
    const report = await host.inspect();
    expect(report.checks.find((row) => row.id === 'vm')?.state).toBe('unavailable');
    expect(report.checks.find((row) => row.id === 'agent')?.state).toBe('unchecked');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC-PRIVATE');
    await host.close();
  }
});
describe('managed VM lifecycle', () => {
  it('keeps proven Agent access readable when detailed checks are old or invalid', async () => {
    for (const protocolVersion of [15, 23]) {
      const probe = vi.fn(async (program: string, args: string[]) => ({
        code: 0,
        stdout:
          program === config.limactl
            ? JSON.stringify({ name: config.vm, status: 'Running' })
            : args.includes('is-active')
              ? 'active'
              : '',
      }));
      const client = {
        status: vi.fn(async () => ({ phase: 'ready', protocolVersion })),
        invoke: vi.fn(async () => ({ scope: 'runtime', private: 'SYNTHETIC-PRIVATE' })),
      };
      const host = new ManagedHost(config, '/mock/tunnel.sock', {
        probe,
        client: () => client as never,
      });
      const value = await host.inspect();
      expect(value.checks.find((row) => row.id === 'agent')?.state).toBe('ready');
      expect(value.checks.find((row) => row.id === 'model')?.state).toBe(
        protocolVersion < 23 ? 'unsupported' : 'unchecked',
      );
      expect(client.invoke).toHaveBeenCalledTimes(protocolVersion < 23 ? 0 : 1);
      expect(JSON.stringify(value)).not.toContain('SYNTHETIC-PRIVATE');
      await host.close();
    }
  });
  it('rejects renderer-like arbitrary executables, relative paths and unsafe VM names', () => {
    expect(validateHost(config)).toEqual(config);
    for (const bad of [
      { ...config, limactl: '/bin/sh' },
      { ...config, limaHome: '../lima' },
      { ...config, vm: 'bots;synthetic' },
      { ...config, port: 1 },
    ])
      expect(() => validateHost(bad)).toThrow();
  });
  it('serializes duplicate startup requests and creates only an owned tunnel', async () => {
    const exec = vi.fn(async (_program: string, args: string[]) => {
      if (args.includes('check')) throw new Error('no synthetic tunnel');
      return { stdout: '', stderr: '' };
    });
    const state = { phase: 'ready' };
    const client = { status: vi.fn().mockResolvedValue(state) };
    const host = new ManagedHost(config, '/synthetic/app/tunnel.sock', {
      exec,
      client: () => client as never,
    });
    const [a, b] = await Promise.all([host.connect(), host.connect()]);
    expect(a).toBe(b);
    expect(exec.mock.calls.filter((c) => c[1][0] === 'start')).toHaveLength(1);
    const ssh = exec.mock.calls.find((c) => c[0] === 'ssh' && c[1].includes('-L'));
    expect(ssh?.[1]).toContain('127.0.0.1:18767:127.0.0.1:8766');
    await host.close();
    expect(exec.mock.calls.some((c) => c[1].includes('stop'))).toBe(false);
  });
  it('keeps failed startup retryable without stopping the VM or another process', async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic start failure'))
      .mockResolvedValue({ stdout: '', stderr: '' });
    const client = { status: vi.fn().mockResolvedValue({ phase: 'ready' }) };
    const host = new ManagedHost(config, '/synthetic/app/tunnel.sock', {
      exec,
      client: () => client as never,
    });
    await expect(host.connect()).rejects.toThrow();
    await expect(host.connect()).resolves.toBeDefined();
  });
});
it('repairs only its stale tunnel and does not restart the guest service', async () => {
  const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
  const client = {
    status: vi
      .fn()
      .mockResolvedValueOnce({ phase: 'offline' })
      .mockResolvedValue({ phase: 'ready' }),
  };
  const host = new ManagedHost(config, '/synthetic/app/tunnel.sock', {
    exec,
    client: () => client as never,
  });
  await host.connect();
  expect(
    exec.mock.calls.some((call) => (call as unknown as [string, string[]])[1].includes('exit')),
  ).toBe(true);
  expect(
    exec.mock.calls.some((call) => (call as unknown as [string, string[]])[1].includes('-L')),
  ).toBe(true);
  expect(
    exec.mock.calls.some((call) => (call as unknown as [string, string[]])[1].includes('restart')),
  ).toBe(false);
});
it('closing during startup aborts child commands and never leaves a reconnect running', async () => {
  let started: () => unknown = () => undefined;
  const ready = new Promise((resolve) => {
    started = () => resolve(undefined);
  });
  const exec = vi.fn(
    async (_program: string, _args: string[], options?: Record<string, unknown>) => {
      if (_program === 'ssh') return { stdout: '' };
      started();
      await new Promise((_resolve, reject) => {
        (options?.signal as AbortSignal)?.addEventListener(
          'abort',
          () => reject(new Error('synthetic cancelled')),
          { once: true },
        );
      });
      return { stdout: '' };
    },
  );
  const host = new ManagedHost(config, '/synthetic/app/tunnel.sock', { exec });
  const pending = host.connect();
  const rejected = expect(pending).rejects.toThrow();
  await ready;
  await host.close();
  await rejected;
  await expect(host.connect()).rejects.toThrow();
  expect(exec.mock.calls.some((call) => call[1].includes('stop'))).toBe(false);
});

it('does not wait for inherited pipes after a host helper forks into the background', async () => {
  const start = performance.now();
  await execute(
    process.execPath,
    [
      '-e',
      "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit'}).unref()",
    ],
    { timeout: 1000 },
  );
  expect(performance.now() - start).toBeLessThan(1000);
});

it('reads the control credential only through the configured SSH identity and distinguishes missing from rejected', async () => {
  const { readControlToken } = await import('./host');
  const secret = 'b'.repeat(64);
  let code = 0,
    text = `${secret}\n`;
  const probe = vi.fn(async (_program: string, _args: string[], _options: unknown) => ({
    code,
    stdout: text,
  }));
  const signal = new AbortController().signal;
  expect(await readControlToken(config, '/synthetic/private/tunnel.sock', probe, signal)).toBe(
    secret,
  );
  const args = probe.mock.calls[0];
  expect(JSON.stringify(args)).toContain('/synthetic/lima/bots/ssh.config');
  expect(JSON.stringify(args)).toContain('lima-bots');
  expect(JSON.stringify(args)).not.toContain(secret);
  code = 44;
  text = '';
  expect(
    await readControlToken(config, '/synthetic/private/tunnel.sock', probe, signal),
  ).toBeUndefined();
  code = 43;
  text = 'SYNTHETIC-PRIVATE-ERROR';
  await expect(
    readControlToken(config, '/synthetic/private/tunnel.sock', probe, signal),
  ).rejects.toThrow('RUNTIME_AUTH_UNAVAILABLE');
  code = 0;
  await expect(
    readControlToken(config, '/synthetic/private/tunnel.sock', probe, signal),
  ).rejects.toThrow('RUNTIME_AUTH_UNAVAILABLE');
});

it('attaches an already running newly installed VM without issuing another VM or service start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-install-attach-'));
  const exec = vi.fn(async (_program: string, args: string[]) => {
    if (args.includes('check')) throw new Error('SYNTHETIC_NO_MASTER');
    return { stdout: '' };
  });
  const client = { status: vi.fn(async () => ({ phase: 'ready', protocolVersion: 26 })) };
  const host = new ManagedHost(config, join(root, 'socket'), {
    exec,
    probe: async () => ({
      code: 0,
      stdout: JSON.stringify({ name: config.vm, status: 'Running' }),
    }),
    client: () => client as never,
  });
  try {
    expect(await host.connectExisting()).toBe(client);
    expect(exec.mock.calls.every(([program]) => program === 'ssh')).toBe(true);
    expect(exec.mock.calls.flatMap(([, args]) => args)).not.toContain('systemctl');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
