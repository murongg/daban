import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VmConnection } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import {
  QemuLink,
  type QemuMachine,
  qemuArguments,
  qemuFileHash,
  verifyQemuTools,
} from './qemu.js';
import { readQemuRecord, writeQemuRecord } from './qemu-store.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-qemu-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const dataRoot = path.join(directory, 'private , 电脑');
  const root = path.join(dataRoot, 'qemu');
  const config: VmConnection = {
    provider: 'qemu',
    enabled: true,
    vmId: '11111111-2222-4333-8444-555555555555',
    host: '127.0.0.1',
    sshPort: 23456,
    user: 'mock-bot',
    identityFile: path.join(root, 'keys/id_ed25519'),
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  const machine: QemuMachine = {
    version: 1,
    connection: config,
    acceleration: 'tcg',
    qmpPort: 23457,
    toolsId: 'a'.repeat(64),
  };
  await writeQemuRecord(path.join(root, 'machine.json'), machine);
  return { dataRoot, root, config, machine };
}

test('QEMU launch options preserve paths and isolate forwarding, authenticated control and guest files from Windows', async (t) => {
  const f = await fixture(t);
  const args = qemuArguments(f.machine, f.root);
  expect(args).toContain('tcg,thread=multi');
  expect(args).toContain('VGA');
  expect(args).toContain('user,id=network,hostfwd=tcp:127.0.0.1:23456-:22');
  expect(args.join(' ')).toContain('verify-peer=on');
  expect(args.join(' ')).toContain(',,');
  expect(args.join(' ')).not.toMatch(/smb=|host_device|0\.0\.0\.0|virtfs|shared-dir/);
  expect(qemuArguments({ ...f.machine, acceleration: 'whpx' }, f.root)).toContain('whpx');
});

test('WHPX retains hardware CPU acceleration with the interrupt controller required by the pinned BIOS', async (t) => {
  const f = await fixture(t);
  const hardware = qemuArguments({ ...f.machine, acceleration: 'whpx' }, f.root);
  expect(hardware[hardware.indexOf('-machine') + 1]).toBe('q35,kernel-irqchip=off');
  expect(hardware[hardware.indexOf('-accel') + 1]).toBe('whpx');
  expect(hardware[hardware.indexOf('-cpu') + 1]).toBe('host');
  expect(hardware.join(' ')).not.toMatch(/tcg|ssd=off/);
  const compatibility = qemuArguments(f.machine, f.root);
  expect(compatibility[compatibility.indexOf('-machine') + 1]).toBe('q35');
});

test('QEMU verifies every pinned binary and firmware, including comma filenames, and refuses tampered bytes', async (t) => {
  const f = await fixture(t);
  const tools = path.join(f.root, 'tools');
  await mkdir(path.join(tools, 'share'), { recursive: true });
  const content = 'SYNTHETIC BINARY';
  const files = Object.fromEntries(
    ['qemu-system-x86_64.exe', 'qemu-img.exe', 'share/mock,firmware.bin'].map((name) => [
      name,
      {
        bytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ]),
  );
  for (const name of Object.keys(files)) await writeFile(path.join(tools, name), content);
  await writeQemuRecord(path.join(tools, 'manifest.json'), { version: 1, files });
  const machine = {
    ...f.machine,
    toolsId: (await qemuFileHash(path.join(tools, 'manifest.json'))).sha256,
  };
  await verifyQemuTools(machine, f.root);
  await writeFile(path.join(tools, 'mock-extra.dll'), 'SYNTHETIC UNPINNED DLL');
  await expect(verifyQemuTools(machine, f.root)).rejects.toThrow('QEMU_ASSET_INTEGRITY');
  await rm(path.join(tools, 'mock-extra.dll'));
  await writeFile(path.join(tools, 'qemu-system-x86_64.exe'), 'SYNTHETIC CHANGED');
  await expect(verifyQemuTools(machine, f.root)).rejects.toThrow('QEMU_ASSET_INTEGRITY');
});

test('separate QEMU owners cannot race a second launch or boot during an accepted shutdown', async (t) => {
  const f = await fixture(t);
  let release!: () => unknown, entered!: () => unknown;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const began = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  let running = false,
    launches = 0;
  const dependencies = {
    alive: () => running,
    verify: async () => {
      entered();
      await gate;
    },
    control: async () => {
      if (!running) throw Error('QEMU_CONTROL_OFFLINE');
      return {
        execute: async (command: string) => {
          if (command === 'system_powerdown') running = false;
          return { status: 'running' };
        },
        close: async () => {},
      };
    },
    launch: async () => {
      launches++;
      running = true;
      return 12345;
    },
  };
  const first = new QemuLink(f.config, f.dataRoot, dependencies),
    second = new QemuLink(f.config, f.dataRoot, dependencies);
  const pending = first.boot();
  await began;
  const competing = second.boot();
  await expect(competing).rejects.toThrow('QEMU_POWER_BUSY');
  release();
  await pending;
  const stopping = first.stopVm();
  await expect(first.boot()).rejects.toThrow('EXECUTOR_POWER_BUSY');
  await stopping;
  expect(launches).toBe(1);
  await first.close();
  await second.close();
});

test('QEMU coalesces startup, retains its identity on reattach and keeps the VM running when the owner closes', async (t) => {
  const f = await fixture(t);
  const effects: string[] = [];
  let running = false;
  let detached = 0;
  const owner = new QemuLink(f.config, f.dataRoot, {
    verify: async () => {
      effects.push('verify');
    },
    alive: () => running,
    control: async () => {
      if (!running) throw Error('QEMU_CONTROL_OFFLINE');
      return {
        execute: async (command) => {
          effects.push(command);
          return { status: 'running' };
        },
        close: async () => {},
      };
    },
    launch: async (_program, args, options) => {
      expect(options.env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(args).toContain(f.config.vmId);
      running = true;
      effects.push('spawn');
      return 12345;
    },
    tunnel: async () => ({
      alive: true,
      connection: { origin: 'http://127.0.0.1:23458', token: 'a'.repeat(64) },
      close: async () => {
        detached++;
      },
    }),
    port: async () => 23458,
    ready: async () => {},
  });
  const [first, second] = await Promise.all([owner.ensure(), owner.ensure()]);
  expect(first).toStrictEqual(second);
  expect(effects.filter((item) => item === 'spawn')).toHaveLength(1);
  expect(((await readQemuRecord(path.join(f.root, 'machine.json'))) as QemuMachine).pid).toBe(
    12345,
  );
  await owner.close();
  expect(running).toBe(true);
  expect(detached).toBe(1);
  expect(effects).not.toContain('system_powerdown');
  await expect(owner.ensure()).rejects.toThrow('EXECUTOR_LINK_CLOSED');
});

test('QEMU waits for read-only executor readiness and discards a late tunnel after cancellation', async (t) => {
  const f = await fixture(t);
  let attempts = 0,
    detached = 0;
  const owner = new QemuLink(f.config, f.dataRoot, {
    control: async () => ({ execute: async () => ({ status: 'running' }), close: async () => {} }),
    tunnel: async () => ({
      alive: true,
      connection: { origin: 'http://127.0.0.1:23458', token: 'a'.repeat(64) },
      close: async () => {
        detached++;
      },
    }),
    port: async () => 23458,
    ready: async () => {
      if (++attempts === 1) throw Error('EXECUTION_UNAVAILABLE');
    },
  });
  await owner.ensure();
  expect(attempts).toBe(2);
  expect(detached).toBe(1);
  await owner.close();
  expect(detached).toBe(2);
  let release!: () => unknown, entered!: () => unknown;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const began = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const late = new QemuLink(f.config, f.dataRoot, {
    control: async () => ({ execute: async () => ({ status: 'running' }), close: async () => {} }),
    tunnel: async () => {
      entered();
      await gate;
      return {
        alive: true,
        connection: { origin: 'http://127.0.0.1:23458', token: 'a'.repeat(64) },
        close: async () => {
          detached++;
        },
      };
    },
    port: async () => 23458,
    ready: async () => {},
  });
  const waiting = late.ensure();
  await began;
  const closed = late.close();
  release();
  await expect(waiting).rejects.toThrow('EXECUTOR_LINK_CLOSED');
  await closed;
  expect(detached).toBe(3);
});

test('QEMU reconnect never launches a stopped guest and refuses uncertain launches or changed guest identity', async (t) => {
  const f = await fixture(t);
  let launches = 0;
  const owner = new QemuLink(f.config, f.dataRoot, {
    control: async () => {
      throw Error('QEMU_CONTROL_OFFLINE');
    },
    alive: () => false,
    launch: async () => {
      launches++;
      return 12345;
    },
  });
  await expect(owner.reconnect()).rejects.toThrow('EXECUTOR_OFFLINE');
  await writeQemuRecord(path.join(f.root, 'machine.json'), { ...f.machine, launching: true });
  await expect(owner.boot()).rejects.toThrow('QEMU_LAUNCH_UNCERTAIN');
  await writeQemuRecord(path.join(f.root, 'machine.json'), {
    ...f.machine,
    connection: { ...f.config, vmId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  });
  await expect(owner.boot()).rejects.toThrow('QEMU_IDENTITY_CHANGED');
  expect(launches).toBe(0);
  await owner.close();
});
