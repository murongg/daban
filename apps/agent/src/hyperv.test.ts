import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VmConnection } from '@daban/protocol';
import { expect, test } from 'vitest';
import { HypervLink } from './hyperv.js';
import type { ExecutorTunnel } from './ssh.js';

const config: VmConnection = {
  provider: 'hyperv',
  enabled: true,
  vmId: '11111111-2222-4333-8444-555555555555',
  host: '192.0.2.10',
  sshPort: 22,
  user: 'mock-bot',
  identityFile: path.join(tmpdir(), 'mock-key'),
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
test('Hyper-V captures the validated VM identity before asynchronous work or caller mutation', async () => {
  const input = { ...config };
  let script = '';
  const owner = new HypervLink(input, path.join(tmpdir(), 'mock-agent'), {
    run: async (_program, args) => {
      script = args.at(-1)!;
      return { stdout: JSON.stringify({ Id: config.vmId, State: 'Running' }) };
    },
  });
  input.vmId = "mock'; Stop-VM *";
  expect(await owner.state()).toBe('running');
  expect.assert(script.includes(config.vmId));
  expect.assert(!script.includes('Stop-VM *'));
  await owner.close();
});

test('Hyper-V starts only the configured VM, coalesces connections and never powers it off when the host closes', async () => {
  const effects: string[] = [];
  let opens = 0,
    closes = 0;
  const owner = new HypervLink(config, path.join(tmpdir(), 'mock-agent'), {
    run: async (_program, args, options) => {
      expect(options.env.DEEPSEEK_API_KEY).toBe(undefined);
      const script = args.at(-1)!;
      expect.assert(script.includes(config.vmId));
      if (script.includes('Start-VM')) effects.push('start');
      if (script.includes('Stop-VM')) effects.push('stop');
      return { stdout: JSON.stringify({ Id: config.vmId, State: 'Off' }) };
    },
    port: async () => 23456,
    tunnel: async (_config, _directory, _port, start) => {
      expect(start).toBe(true);
      opens++;
      return {
        alive: true,
        connection: { origin: 'http://127.0.0.1:23456', token: 'a'.repeat(64) },
        close: async () => {
          closes++;
        },
      };
    },
  });
  const [first, second] = await Promise.all([owner.ensure(), owner.ensure()]);
  expect(first).toStrictEqual(second);
  expect(opens).toBe(1);
  expect(effects).toStrictEqual(['start']);
  await owner.close();
  expect(closes).toBe(1);
  expect(effects).toStrictEqual(['start']);
  await expect(owner.ensure()).rejects.toThrow(/EXECUTOR_LINK_CLOSED/);
});

test('read-only reconnect never wakes a stopped VM or adopts a different Hyper-V identity', async () => {
  let commands = 0,
    opens = 0;
  const owner = new HypervLink(config, path.join(tmpdir(), 'mock-agent'), {
    run: async (_program, args) => {
      commands++;
      expect.assert(!args.at(-1)?.includes('Start-VM'));
      return { stdout: JSON.stringify({ Id: config.vmId, State: 'Off' }) };
    },
    tunnel: async () => {
      opens++;
      throw new Error('SYNTHETIC UNEXPECTED OPEN');
    },
  });
  await expect(owner.reconnect()).rejects.toThrow(/EXECUTOR_OFFLINE/);
  expect(commands).toBe(1);
  expect(opens).toBe(0);
  await owner.close();
  const foreign = new HypervLink(config, path.join(tmpdir(), 'mock-agent'), {
    run: async () => ({ stdout: JSON.stringify({ Id: 'mock-other', State: 'Running' }) }),
  });
  expect(await foreign.state()).toBe('unknown');
  await foreign.close();
});

test('a late SSH connection after cancellation is detached without a VM stop', async () => {
  let resolve: (value: ExecutorTunnel) => unknown = () => undefined;
  let entered: () => unknown = () => undefined;
  const admission = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  let closes = 0;
  const owner = new HypervLink(config, path.join(tmpdir(), 'mock-agent'), {
    run: async (_program, args) => {
      expect.assert(!args.at(-1)?.includes('Stop-VM'));
      return { stdout: JSON.stringify({ Id: config.vmId, State: 'Running' }) };
    },
    port: async () => 23456,
    tunnel: async () => {
      entered();
      return new Promise<ExecutorTunnel>((done) => {
        resolve = done;
      });
    },
  });
  const starting = owner.ensure();
  const rejected = expect(starting).rejects.toThrow(/EXECUTOR_LINK_CLOSED/);
  await admission;
  const closing = owner.close();
  resolve({
    alive: true,
    connection: { origin: 'http://127.0.0.1:23456', token: 'a'.repeat(64) },
    close: async () => {
      closes++;
    },
  });
  await rejected;
  await closing;
  expect(closes).toBe(1);
});
