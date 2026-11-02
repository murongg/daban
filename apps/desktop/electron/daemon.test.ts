import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, globalAgent } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Daemon, daemonScope } from './daemon';

const roots = new Set<string>();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mock-daemon-'));
  roots.add(root);
  const config = {
    dataRoot: join(root, 'data'),
    socketPath: join(root, 'private', 'agent.sock'),
    vmConfig: join(root, 'runtime.json'),
    executable: join(root, 'Mock Electron'),
    entry: join(root, 'agent.js'),
  };
  await writeFile(config.vmConfig, '{}', { mode: 0o600 });
  await writeFile(config.executable, 'mock executable', { mode: 0o700 });
  await writeFile(config.entry, 'mock entry', { mode: 0o600 });
  return config;
}

it('launches one scoped launchd job and leaves it running when the UI connection closes', async () => {
  const config = await fixture();
  let launched = false;
  const run = vi.fn(async (_program: string, args: string[]) => {
    if (args[0] === 'print') return { code: launched ? 0 : 113, stdout: '' };
    if (args[0] === 'bootstrap') launched = true;
    return { code: 0, stdout: '' };
  });
  const identity = {
    role: 'agent',
    scope: daemonScope(config.dataRoot, config.vmConfig),
    dataRoot: config.dataRoot,
    socketPath: config.socketPath,
  };
  const daemon = new Daemon(config, {
    run,
    inspect: async () => (launched ? identity : undefined),
    wait: async () => {},
    platform: 'darwin',
  });
  const [first, second] = await Promise.all([daemon.ensure(), daemon.ensure()]);
  expect(first).toEqual(identity);
  expect(second).toEqual(identity);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1);
  const bootstrap = run.mock.calls.find(([, args]) => args[0] === 'bootstrap')!;
  expect(bootstrap[0]).toBe('/bin/launchctl');
  expect(bootstrap[1][1]).toBe(`gui/${process.getuid!()}`);
  const plist = await readFile(bootstrap[1][2], 'utf8');
  expect(plist).toContain('ELECTRON_RUN_AS_NODE');
  expect(plist).toContain('--expose-internals');
  expect(plist).toContain(config.entry);
  expect(plist).toContain('--data');
  expect(plist).toContain('--socket');
  expect(plist).toContain('--vm-config');
  expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
  expect(plist).not.toContain('DEEPSEEK_API_KEY');
  expect((await lstat(config.dataRoot)).mode & 0o777).toBe(0o700);
  expect((await lstat(bootstrap[1][2])).mode & 0o777).toBe(0o600);
  await daemon.close();
  expect(run.mock.calls.some(([, args]) => args[0] === 'bootout' || args[0] === 'kill')).toBe(
    false,
  );
  const reconnect = new Daemon(config, { run, inspect: async () => identity, platform: 'darwin' });
  expect(await reconnect.ensure()).toEqual(identity);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1);
});

it('validates daemon identity and private paths before adopting or launching anything', async () => {
  const config = await fixture();
  const run = vi.fn(async () => ({ code: 0, stdout: '' }));
  const bad = new Daemon(config, {
    run,
    inspect: async () => ({
      role: 'agent',
      scope: 'foreign-scope',
      dataRoot: config.dataRoot,
      socketPath: config.socketPath,
    }),
    platform: 'darwin',
  });
  await expect(bad.ensure()).rejects.toThrow('AGENT_DAEMON_SCOPE_MISMATCH');
  expect(run).not.toHaveBeenCalled();
  await chmod(config.dataRoot, 0o755);
  const unsafe = new Daemon(config, { run, inspect: async () => undefined, platform: 'darwin' });
  await expect(unsafe.ensure()).rejects.toThrow('AGENT_DAEMON_PATH_UNSAFE');
  expect((await lstat(config.dataRoot)).mode & 0o777).toBe(0o755);
  await rm(config.dataRoot, { recursive: true });
  await symlink(join(config.dataRoot, '..'), config.dataRoot);
  await expect(unsafe.ensure()).rejects.toThrow('AGENT_DAEMON_PATH_UNSAFE');
  expect(run).not.toHaveBeenCalled();
});

it('discovers through a Unix HTTP socket and refuses a foreign identity without launch fallback', async () => {
  const config = await fixture();
  const run = vi.fn(async () => ({ code: 0, stdout: '' }));
  const daemon = new Daemon(config, { run, platform: 'darwin' });
  const preparation = new Daemon(config, {
    run,
    inspect: async () => ({
      role: 'agent',
      scope: daemonScope(config.dataRoot, config.vmConfig),
      dataRoot: config.dataRoot,
      socketPath: config.socketPath,
    }),
    platform: 'darwin',
  });
  await preparation.ensure();
  const server = createServer((request, response) => {
    expect(request.url).toBe('/agent/identity');
    response.end(
      JSON.stringify({
        role: 'agent',
        scope: 'foreign-scope',
        dataRoot: config.dataRoot,
        socketPath: config.socketPath,
      }),
    );
  });
  server.listen(config.socketPath);
  await once(server, 'listening');
  await chmod(config.socketPath, 0o600);
  vi.spyOn(globalAgent, 'createConnection').mockImplementation(() => {
    throw new Error('AMBIENT_AGENT_MUST_NOT_RUN');
  });
  try {
    await expect(daemon.ensure()).rejects.toThrow('AGENT_DAEMON_SCOPE_MISMATCH');
    expect(run).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
  }
});

it('handles another supervisor winning bootstrap without replacing or killing its daemon', async () => {
  const config = await fixture();
  let polls = 0;
  const identity = {
    role: 'agent',
    scope: daemonScope(config.dataRoot, config.vmConfig),
    dataRoot: config.dataRoot,
    socketPath: config.socketPath,
  };
  const run = vi.fn(async (_program: string, args: string[]) => ({
    code: args[0] === 'bootstrap' ? 5 : args[0] === 'print' && polls++ === 0 ? 113 : 0,
    stdout: '',
  }));
  let inspected = 0;
  const daemon = new Daemon(config, {
    run,
    inspect: async () => (++inspected > 1 ? identity : undefined),
    wait: async () => {},
    platform: 'darwin',
  });
  expect(await daemon.ensure()).toEqual(identity);
  expect(run.mock.calls.some(([, args]) => args.includes('-k'))).toBe(false);
});

it('lets concurrent UI processes converge on the same scoped daemon without file creation races', async () => {
  const config = await fixture();
  let launched = false;
  const run = vi.fn(async (_program: string, args: string[]) => {
    if (args[0] === 'print') return { code: launched ? 0 : 113, stdout: '' };
    if (args[0] === 'bootstrap') {
      const existed = launched;
      launched = true;
      return { code: existed ? 5 : 0, stdout: '' };
    }
    return { code: 0, stdout: '' };
  });
  const identity = {
    role: 'agent',
    scope: daemonScope(config.dataRoot, config.vmConfig),
    dataRoot: config.dataRoot,
    socketPath: config.socketPath,
  };
  const dependencies = {
    run,
    inspect: async () => (launched ? identity : undefined),
    wait: async () => {},
    platform: 'darwin' as const,
  };
  const a = new Daemon(config, dependencies);
  const b = new Daemon(config, dependencies);
  expect(await Promise.all([a.ensure(), b.ensure()])).toEqual([identity, identity]);
  expect(
    run.mock.calls.filter(
      ([, args]) => args[0] === 'bootstrap' && args[1] !== `gui/${process.getuid!()}`,
    ),
  ).toHaveLength(0);
});

it('does not launch after a UI closes during asynchronous discovery', async () => {
  const config = await fixture();
  let discovered: (value: unknown) => unknown = () => {};
  let inspecting: () => unknown = () => {};
  const entered = new Promise<unknown>((done) => {
    inspecting = () => done(undefined);
  });
  const run = vi.fn(async () => ({ code: 0, stdout: '' }));
  const daemon = new Daemon(config, {
    run,
    inspect: () => {
      inspecting();
      return new Promise((done) => {
        discovered = done;
      });
    },
    platform: 'darwin',
  });
  const startup = daemon.ensure();
  await entered;
  await daemon.close();
  discovered(undefined);
  await expect(startup).rejects.toThrow('AGENT_DAEMON_CLOSED');
  expect(run).not.toHaveBeenCalled();
});

it('rejects oversized identity padding before end can adopt an otherwise valid JSON prefix', async () => {
  const config = await fixture();
  const run = vi.fn(async () => ({ code: 0, stdout: '' }));
  const identity = {
    role: 'agent',
    scope: daemonScope(config.dataRoot, config.vmConfig),
    dataRoot: config.dataRoot,
    socketPath: config.socketPath,
  };
  const preparation = new Daemon(config, {
    run,
    inspect: async () => identity,
    platform: 'darwin',
  });
  await preparation.ensure();
  const server = createServer((_request, response) =>
    response.end(JSON.stringify(identity) + ' '.repeat(64 * 1024)),
  );
  server.listen(config.socketPath);
  await once(server, 'listening');
  await chmod(config.socketPath, 0o600);
  try {
    await expect(new Daemon(config, { run, platform: 'darwin' }).ensure()).rejects.toThrow(
      'AGENT_DAEMON_UNAVAILABLE',
    );
    expect(run).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<unknown>((done, reject) =>
      server.close((error) => (error ? reject(error) : done(undefined))),
    );
  }
});

it('waits for a fresh bootstrap beyond thirty seconds while retaining a ten-minute deadline', async () => {
  const config = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  let elapsed = 0;
  const identity = {
    role: 'agent',
    scope: daemonScope(config.dataRoot, config.vmConfig),
    dataRoot: config.dataRoot,
    socketPath: config.socketPath,
  };
  const daemon = new Daemon(config, {
    run: async (_program, args) => ({ code: args[0] === 'print' ? 113 : 0, stdout: '' }),
    inspect: async () => (elapsed >= 45000 ? identity : undefined),
    wait: async (milliseconds) => {
      elapsed += milliseconds;
      vi.setSystemTime(elapsed);
    },
    platform: 'darwin',
  });
  expect(await daemon.ensure()).toEqual(identity);
  expect(elapsed).toBeGreaterThanOrEqual(45000);
  expect(elapsed).toBeLessThanOrEqual(600000);
  await daemon.close();
});

it('proves a first-use host is absent without starting it, and never treats a booting job as absent', async () => {
  const config = await fixture();
  const inspect = vi.fn(async (): Promise<unknown> => undefined);
  const run = vi.fn(async (_program: string, _args: string[], _options: unknown) => ({
    code: 113,
    stdout: '',
  }));
  const daemon = new Daemon(config, { run, inspect, platform: 'darwin' });
  expect(await daemon.inactive()).toBe(true);
  expect(run).toHaveBeenCalledWith(
    '/bin/launchctl',
    ['print', `gui/${process.getuid!()}/${daemon.label}`],
    expect.anything(),
  );
  run.mockResolvedValueOnce({ code: 0, stdout: '' });
  expect(await daemon.inactive()).toBe(false);
  run.mockResolvedValueOnce({ code: 1, stdout: '' });
  await expect(daemon.inactive()).rejects.toThrow('AGENT_DAEMON_UNAVAILABLE');
  inspect.mockResolvedValueOnce({
    role: 'agent',
    scope: daemon.scope,
    dataRoot: config.dataRoot,
    socketPath: config.socketPath,
  });
  expect(await daemon.inactive()).toBe(false);
  expect(run.mock.calls.every((call) => call[1][0] === 'print')).toBe(true);
  await daemon.close();
});
