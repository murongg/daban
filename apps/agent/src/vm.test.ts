import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { type VmConfig, VmLink } from './vm.js';

const config: VmConfig = {
  limactl: '/mock/tools/limactl',
  limaHome: '/mock/lima',
  vm: 'mock-executor',
  port: 18766,
};
const token = 'a'.repeat(64);
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-link-'));
  return { root, socket: join(root, 'private', 's') };
};

test('VM link starts only the configured executor and returns its private token through a persistent tunnel', async () => {
  const { root, socket } = await fixture();
  const calls: { program: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  let master = false;
  const link = new VmLink(config, socket, {
    run: async (program, args, options) => {
      calls.push({ program, args, env: options.env });
      if (args.includes('-fNT')) master = true;
    },
    probe: async (program, args, options) => {
      calls.push({ program, args, env: options.env });
      return args.includes('check')
        ? { code: master ? 0 : 255, stdout: '' }
        : { code: 0, stdout: `${token}\n` };
    },
    port: async () => 19876,
    absent: async () => true,
  });
  try {
    const [a, b] = await Promise.all([link.ensure(), link.ensure()]);
    expect(a).toStrictEqual({ origin: 'http://127.0.0.1:19876', token });
    expect(b).toStrictEqual(a);
    expect(
      calls.filter((call) => call.program === config.limactl && call.args[0] === 'start').length,
    ).toBe(1);
    expect(
      calls.find((call) => call.program === config.limactl && call.args[0] === 'shell')?.args,
    ).toStrictEqual([
      'shell',
      config.vm,
      'sudo',
      '-n',
      'systemctl',
      'start',
      'daban-executor.service',
    ]);
    const tunnel = calls.find((call) => call.args.includes('-fNT'))!;
    expect(tunnel.program).toBe('/usr/bin/ssh');
    expect(tunnel.args[tunnel.args.indexOf('-L') + 1]).toBe('127.0.0.1:19876:127.0.0.1:8766');
    expect.assert(tunnel.args.includes('ForwardAgent=no'));
    expect.assert(tunnel.args.includes('ForwardX11=no'));
    expect.assert(
      calls.some((call) =>
        call.args.some((argument) => argument.includes('/var/lib/daban-executor/token')),
      ),
    );
    expect.assert(
      calls.every((call) => !JSON.stringify(call.args).includes('/model/control-token')),
    );
    expect.assert(calls.every((call) => !JSON.stringify(call.args).includes(token)));
    expect.assert(
      calls.every(
        (call) =>
          call.env?.LIMA_HOME === config.limaHome &&
          !call.env?.DEEPSEEK_API_KEY &&
          !call.env?.SSH_AUTH_SOCK,
      ),
    );
    for (const name of await readdir(dirname(link.socketPath))) {
      expect((await readFile(join(dirname(link.socketPath), name), 'utf8')).includes(token)).toBe(
        false,
      );
    }
    expect((await lstat(dirname(link.socketPath))).mode & 0o777).toBe(0o700);
    await link.close();
    expect(calls.filter((call) => call.args.includes('exit')).length).toBe(1);
    expect.assert(
      calls.every((call) => !(call.program === config.limactl && call.args[0] === 'stop')),
    );
    expect.assert(
      calls.every((call) => !call.args.includes('systemctl') || !call.args.includes('stop')),
    );
  } finally {
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link adopts only a scoped verified master and retains uncertain live sockets', async () => {
  const { root, socket } = await fixture();
  let live = false;
  const calls: string[][] = [];
  const dependencies = {
    run: async (_program: string, args: string[]) => {
      calls.push(args);
      if (args.includes('-fNT')) live = true;
    },
    probe: async (_program: string, args: string[]) =>
      args.includes('check') ? { code: live ? 0 : 255, stdout: '' } : { code: 0, stdout: token },
    port: async () => 19877,
    absent: async () => true,
  };
  const first = new VmLink(config, socket, dependencies);
  try {
    await first.ensure();
    const second = new VmLink(config, socket, dependencies);
    expect(await second.ensure()).toStrictEqual({ origin: 'http://127.0.0.1:19877', token });
    expect(calls.filter((args) => args.includes('-fNT')).length).toBe(1);
    live = false;
    const uncertain = new VmLink(config, socket, { ...dependencies, absent: async () => false });
    await expect(uncertain.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_TUNNEL_UNVERIFIED$/),
    });
    expect(calls.filter((args) => args.includes('-fNT')).length).toBe(1);
    expect(calls.filter((args) => args.includes('exit')).length).toBe(0);
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link rejects unsafe configuration, foreign state and private socket replacements', async () => {
  const { root, socket } = await fixture();
  try {
    for (const invalid of [
      { ...config, vm: 'mock; touch /tmp/private' },
      { ...config, limactl: 'limactl' },
      { ...config, port: 22 },
      { ...config, limaHome: '../mock' },
    ])
      expect(() => new VmLink(invalid, socket)).toThrowError(
        expect.objectContaining({
          name: 'Error',
          message: expect.stringMatching(/^INVALID_VM_CONFIG$/),
        }),
      );
    let commands = 0;
    const link = new VmLink(config, socket, {
      run: async () => {
        commands++;
      },
      probe: async () => ({ code: 255, stdout: '' }),
      absent: async () => false,
    });
    await expect(link.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_TUNNEL_UNVERIFIED$/),
    });
    await writeFile(socket, 'MOCK FILE MUST REMAIN', { mode: 0o600 });
    await expect(link.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_SOCKET_UNSAFE$/),
    });
    expect(await readFile(socket, 'utf8')).toBe('MOCK FILE MUST REMAIN');
    const before = commands;
    await chmod(dirname(socket), 0o755);
    await expect(link.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_SOCKET_UNSAFE$/),
    });
    expect(commands).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link sanitizes token failures and cannot start more work after close', async () => {
  const { root, socket } = await fixture();
  let started = false;
  const calls: string[][] = [];
  const link = new VmLink(config, socket, {
    run: async (_program, args) => {
      calls.push(args);
      if (args.includes('-fNT')) started = true;
    },
    probe: async (_program, args) =>
      args.includes('check')
        ? { code: started ? 0 : 255, stdout: '' }
        : { code: 0, stdout: 'mock-private-payload' },
    absent: async () => true,
    port: async () => 19878,
  });
  try {
    await expect(link.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_AUTH_UNAVAILABLE$/),
    });
    await link.close();
    await expect(link.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_LINK_CLOSED$/),
    });
    expect(calls.filter((args) => args.includes('exit')).length).toBe(1);
  } finally {
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link validates saved VM scope before starting a different executor', async () => {
  const { root, socket } = await fixture();
  let master = false;
  let commands = 0;
  const dependencies = {
    run: async (_program: string, args: string[]) => {
      commands++;
      if (args.includes('-fNT')) master = true;
    },
    probe: async (_program: string, args: string[]) =>
      args.includes('check') ? { code: master ? 0 : 255, stdout: '' } : { code: 0, stdout: token },
    absent: async () => true,
    port: async () => 19879,
  };
  const first = new VmLink(config, socket, dependencies);
  try {
    await first.ensure();
    const before = commands;
    const foreign = new VmLink({ ...config, vm: 'mock-other' }, socket, dependencies);
    await expect(foreign.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_TUNNEL_STATE_INVALID$/),
    });
    expect(commands).toBe(before);
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link closes a forked SSH master even if shutdown arrives before startup returns', async () => {
  const { root, socket } = await fixture();
  let release: () => unknown = () => {};
  let entered: () => unknown = () => {};
  const waiting = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  const calls: string[][] = [];
  const link = new VmLink(config, socket, {
    run: async (_program, args) => {
      calls.push(args);
      if (args.includes('-fNT')) {
        entered();
        await new Promise<unknown>((done) => {
          release = () => done(undefined);
        });
      }
    },
    probe: async () => ({ code: 255, stdout: '' }),
    absent: async () => true,
    port: async () => 19880,
  });
  try {
    const startup = link.ensure();
    await waiting;
    const closing = link.close();
    release();
    await expect(startup).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_LINK_CLOSED$/),
    });
    await closing;
    expect(calls.filter((args) => args.includes('exit')).length).toBe(1);
    expect(calls.some((args) => args[0] === 'stop')).toBe(false);
  } finally {
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link never replaces a reachable private socket when SSH cannot identify its master', async () => {
  const { root, socket } = await fixture();
  const calls: string[][] = [];
  const dependencies = {
    run: async (_program: string, args: string[]) => {
      calls.push(args);
    },
    probe: async () => ({ code: 255, stdout: '' }),
  };
  const preparation = new VmLink(config, socket, { ...dependencies, absent: async () => false });
  await expect(preparation.ensure()).rejects.toMatchObject({
    name: 'Error',
    message: expect.stringMatching(/^EXECUTOR_TUNNEL_UNVERIFIED$/),
  });
  const listener = net.createServer((channel) => channel.destroy());
  listener.listen(socket);
  await once(listener, 'listening');
  await chmod(socket, 0o600);
  try {
    const link = new VmLink(config, socket, dependencies);
    await expect(link.ensure()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_TUNNEL_UNVERIFIED$/),
    });
    expect(listener.listening).toBe(true);
    expect(calls.some((args) => args.includes('-fNT') || args.includes('exit'))).toBe(false);
  } finally {
    await new Promise<unknown>((done, reject) =>
      listener.close((error) => (error ? reject(error) : done(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('VM link probes a busy preferred port without sending credentials to its listener', async () => {
  const { root, socket } = await fixture();
  let contacts = 0;
  const listener = net.createServer((channel) => {
    contacts++;
    channel.destroy();
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  expect.assert(address && typeof address !== 'string');
  let master = false;
  const link = new VmLink({ ...config, port: address.port }, socket, {
    run: async (_program, args) => {
      if (args.includes('-fNT')) master = true;
    },
    probe: async (_program, args) =>
      args.includes('check') ? { code: master ? 0 : 255, stdout: '' } : { code: 0, stdout: token },
    absent: async () => true,
  });
  try {
    const connection = await link.ensure();
    expect(new URL(connection.origin).port).not.toBe(String(address.port));
    expect(contacts).toBe(0);
  } finally {
    await link.close();
    await new Promise<unknown>((done, reject) =>
      listener.close((error) => (error ? reject(error) : done(undefined))),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('VM power inspection is read-only and accepts only the exact configured VM status', async () => {
  const { root, socket } = await fixture();
  let status = { name: config.vm, status: 'Running' };
  const calls: string[][] = [];
  const link = new VmLink(config, socket, {
    run: async (_program, args) => {
      calls.push(args);
    },
    probe: async (program, args) => {
      expect(program).toBe(config.limactl);
      expect(args).toStrictEqual(['list', '--format=json', config.vm]);
      return { code: 0, stdout: JSON.stringify(status) };
    },
  });
  try {
    expect(await link.state()).toBe('running');
    status = { name: config.vm, status: 'Stopped' };
    expect(await link.state()).toBe('stopped');
    status = { name: 'mock-foreign', status: 'Running' };
    expect(await link.state()).toBe('unknown');
    expect(calls).toStrictEqual([]);
    await expect(lstat(dirname(link.socketPath))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit VM restart closes SSH before stopping and reacquires the execution token on reconnect', async () => {
  const { root, socket } = await fixture();
  let master = false;
  let running = false;
  let starts = 0;
  const events: string[] = [];
  const link = new VmLink(config, socket, {
    run: async (program, args) => {
      if (program === config.limactl && args[0] === 'start') {
        running = true;
        starts++;
        events.push('vm-start');
      }
      if (program === config.limactl && args[0] === 'stop') {
        running = false;
        events.push('vm-stop');
      }
      if (args.includes('-fNT')) {
        master = true;
        events.push('ssh-open');
      }
      if (args.includes('exit')) {
        master = false;
        events.push('ssh-close');
      }
    },
    probe: async (program, args) =>
      program === config.limactl
        ? {
            code: 0,
            stdout: JSON.stringify({ name: config.vm, status: running ? 'Running' : 'Stopped' }),
          }
        : args.includes('check')
          ? { code: master ? 0 : 255, stdout: '' }
          : { code: 0, stdout: starts === 1 ? token : 'b'.repeat(64) },
    absent: async () => true,
    port: async () => 19881,
  });
  try {
    expect((await link.ensure()).token).toBe(token);
    await link.stopVm();
    expect(await link.state()).toBe('stopped');
    expect.assert(events.indexOf('ssh-close') < events.indexOf('vm-stop'));
    expect((await link.startVm()).token).toBe('b'.repeat(64));
    expect((await link.ensure()).token).toBe('b'.repeat(64));
    expect(starts).toBe(2);
    expect(await link.state()).toBe('running');
    await link.close();
    expect(events.filter((event) => event === 'vm-stop').length).toBe(1);
  } finally {
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('read-only reconnect refreshes a rotated execution token without starting VM or executor services', async () => {
  const { root, socket } = await fixture();
  let current = token,
    master = false,
    running = true;
  const calls: { program: string; args: string[] }[] = [];
  const link = new VmLink(config, socket, {
    run: async (program, args) => {
      calls.push({ program, args });
      if (args.includes('-fNT')) master = true;
    },
    probe: async (program, args) =>
      program === config.limactl
        ? {
            code: 0,
            stdout: JSON.stringify({ name: config.vm, status: running ? 'Running' : 'Stopped' }),
          }
        : args.includes('check')
          ? { code: master ? 0 : 255, stdout: '' }
          : { code: 0, stdout: current },
    absent: async () => true,
    port: async () => 19882,
  });
  try {
    expect((await link.ensure()).token).toBe(token);
    const before = calls.length;
    current = 'b'.repeat(64);
    expect((await link.reconnect()).token).toBe(current);
    expect((await link.ensure()).token).toBe(current);
    expect(calls.slice(before)).toStrictEqual([]);
    running = false;
    await expect(link.reconnect()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_OFFLINE$/),
    });
    expect(calls.slice(before)).toStrictEqual([]);
  } finally {
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('closing during reconnect state inspection prevents late SSH attachment', async () => {
  const { root, socket } = await fixture();
  let master = false,
    hold = false;
  let entered: () => unknown = () => {},
    release: () => unknown = () => {};
  const waiting = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  const calls: string[][] = [];
  const link = new VmLink(config, socket, {
    run: async (_program, args) => {
      calls.push(args);
      if (args.includes('-fNT')) master = true;
    },
    probe: async (program, args) => {
      if (program === config.limactl) {
        if (hold) {
          entered();
          await new Promise<unknown>((done) => {
            release = () => done(undefined);
          });
        }
        return { code: 0, stdout: JSON.stringify({ name: config.vm, status: 'Running' }) };
      }
      return args.includes('check')
        ? { code: master ? 0 : 255, stdout: '' }
        : { code: 0, stdout: token };
    },
    absent: async () => true,
    port: async () => 19883,
  });
  try {
    await link.ensure();
    const before = calls.length;
    hold = true;
    const reconnecting = link.reconnect();
    await waiting;
    const closing = link.close();
    release();
    await expect(reconnecting).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^EXECUTOR_LINK_CLOSED$/),
    });
    await closing;
    expect(calls.slice(before).filter((args) => args.includes('-fNT')).length).toBe(0);
    expect(calls.slice(before).every((args) => args.includes('exit'))).toBe(true);
  } finally {
    release();
    await link.close();
    await rm(root, { recursive: true, force: true });
  }
});
