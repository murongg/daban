import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowsEnvironment } from '@daban/engine/component';
import { saveVmConnection } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import type { VmConnection, WindowsAcceleration } from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { QemuSetup } from './qemu-setup.js';
import { readQemuRecord, writeQemuRecord } from './qemu-store.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-qemu-setup-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const dataRoot = path.join(temporary, 'private');
  const vmConfigFile = path.join(dataRoot, 'runtime.json');
  let acceleration: WindowsAcceleration = 'restart';
  const actions: string[] = [];
  const config: VmConnection = {
    provider: 'qemu',
    enabled: true,
    vmId: '11111111-2222-4333-8444-555555555555',
    host: '127.0.0.1',
    sshPort: 23456,
    user: 'mock',
    identityFile: path.join(dataRoot, 'qemu/keys/id_ed25519'),
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  const options = { dataRoot, vmConfigFile, bundleDirectory: path.join(temporary, 'bundle') };
  await secureDirectory(options.bundleDirectory);
  await writeFile(path.join(options.bundleDirectory, 'qemu.json'), 'SYNTHETIC BUNDLED MANIFEST');
  const dependencies = {
    probe: async () => acceleration,
    enable: async () => {
      actions.push('enable');
    },
    resources: async () => ({ requiredBytes: 8 * 1024 ** 3, availableBytes: 30 * 1024 ** 3 }),
    prepare: async (input: { mode: string; signal: AbortSignal }) => {
      actions.push(input.mode);
      input.signal.throwIfAborted();
      await saveVmConnection(vmConfigFile, config);
    },
  };
  return {
    config,
    options,
    dependencies,
    actions,
    ready: () => {
      acceleration = 'ready';
    },
  };
}

test('a retained manual Hyper-V connection is never replaced by automatic QEMU installation', async (t) => {
  const f = await fixture(t);
  await saveVmConnection(f.options.vmConfigFile, {
    ...f.config,
    provider: 'hyperv',
    host: '192.0.2.10',
    enabled: false,
  });
  const setup = new QemuSetup(f.options, f.dependencies);
  expect(await setup.status()).toMatchObject({ required: false, phase: 'existing' });
  await setup.start('tcg');
  await setup.settled;
  expect(f.actions).toEqual([]);
  await setup.close();
});

test('a lightweight client can report installation resources with no bundled environment and no download', async (t) => {
  const f = await fixture(t);
  const setup = new QemuSetup(
    { ...f.options, bundleDirectory: path.join(f.options.dataRoot, 'absent') },
    { probe: f.dependencies.probe },
  );
  expect(await setup.status()).toMatchObject({
    phase: 'available',
    windows: {
      downloadBytes: windowsEnvironment.bytes,
      requiredBytes: windowsEnvironment.requiredBytes,
    },
  });
  await setup.resumePending();
  expect(setup.busy).toBe(false);
  await setup.close();
  await saveVmConnection(f.options.vmConfigFile, f.config);
  const installed = new QemuSetup(f.options, {
    probe: async () => {
      throw Error('INSTALLED_VM_MUST_NOT_REQUIRE_ASSETS');
    },
  });
  expect(await installed.status()).toMatchObject({ phase: 'complete', required: false });
  await installed.close();
});

test('a published machine reconnects offline after an interrupted first boot without fetching an environment', async (t) => {
  const f = await fixture(t);
  f.ready();
  await secureDirectory(f.options.dataRoot);
  const root = await secureDirectory(path.join(f.options.dataRoot, 'qemu'));
  await writeQemuRecord(path.join(root, 'machine.json'), {
    version: 1,
    connection: f.config,
    acceleration: 'whpx',
    qmpPort: 23457,
    toolsId: 'a'.repeat(64),
  });
  const setup = new QemuSetup(
    { ...f.options, bundleDirectory: path.join(f.options.dataRoot, 'absent') },
    {
      probe: f.dependencies.probe,
      prepare: f.dependencies.prepare,
      download: async () => {
        throw Error('OFFLINE_MACHINE_MUST_NOT_DOWNLOAD');
      },
    },
  );
  await setup.start();
  await setup.settled;
  expect(await setup.status()).toMatchObject({ required: false, phase: 'complete' });
  expect(f.actions).toEqual(['whpx']);
  await setup.close();
});

test('download progress drains before installation completion and a pause cannot be overwritten by late progress', async (t) => {
  const f = await fixture(t);
  f.ready();
  const setup = new QemuSetup(f.options, {
    ...f.dependencies,
    download: async (options, install) => {
      options.progress?.({ received: 25, total: 100 });
      options.progress?.({ received: 100, total: 100 });
      await options.extracting?.();
      return install(options.bundleDirectory);
    },
  });
  await setup.start();
  await setup.settled;
  expect(await readQemuRecord(path.join(f.options.dataRoot, 'qemu-progress.json'))).toMatchObject({
    phase: 'complete',
    required: false,
  });
  await setup.close();
  await rm(f.options.vmConfigFile);
  let began!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    began = () => resolve(undefined);
  });
  const paused = new QemuSetup(f.options, {
    ...f.dependencies,
    download: async (options, install) => {
      options.progress?.({ received: 25, total: 100 });
      began();
      await new Promise<unknown>((resolve) =>
        options.signal!.addEventListener('abort', () => resolve(undefined), { once: true }),
      );
      options.progress?.({ received: 50, total: 100 });
      options.signal!.throwIfAborted();
      return install(options.bundleDirectory);
    },
  });
  await paused.start();
  await started;
  await paused.cancel();
  await paused.settled;
  expect(await readQemuRecord(path.join(f.options.dataRoot, 'qemu-progress.json'))).toMatchObject({
    phase: 'cancelled',
  });
  expect(f.actions).toEqual(['whpx']);
  await paused.close();
});

test.skipIf(process.platform !== 'win32')(
  'an unsafe connection-config parent is rejected before a VM can be created',
  async (t) => {
    const f = await fixture(t);
    const setup = new QemuSetup(
      { ...f.options, vmConfigFile: path.join(path.dirname(f.options.dataRoot), 'runtime.json') },
      f.dependencies,
    );
    expect(await setup.status()).toMatchObject({ phase: 'failed', error: 'QEMU_STORE_UNSAFE' });
    await setup.start('tcg');
    await setup.settled;
    expect(f.actions).toEqual([]);
    await setup.close();
  },
);

test('recommended installation waits for a real hypervisor and resumes only its persisted user request after reboot', async (t) => {
  const f = await fixture(t);
  const first = new QemuSetup(f.options, f.dependencies);
  expect(await first.status()).toMatchObject({
    required: true,
    windows: { acceleration: 'restart' },
    phase: 'available',
  });
  expect(await first.start()).toMatchObject({
    phase: 'waiting',
    windows: { mode: 'whpx', acceleration: 'restart' },
  });
  expect(f.actions).toEqual([]);
  await first.close();
  f.ready();
  const resumed = new QemuSetup(f.options, f.dependencies);
  await resumed.resumePending();
  await resumed.settled;
  expect(await resumed.status()).toMatchObject({ phase: 'complete', required: false });
  expect(f.actions).toEqual(['whpx']);
  await resumed.close();
});

test('compatibility mode requires an explicit choice, and a pause survives a new host owner', async (t) => {
  const f = await fixture(t);
  let began!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    began = () => resolve(undefined);
  });
  const first = new QemuSetup(f.options, {
    ...f.dependencies,
    prepare: async ({ signal }) => {
      f.actions.push('tcg');
      began();
      await new Promise<unknown>((resolve) =>
        signal.addEventListener('abort', () => resolve(undefined), { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  await first.start('tcg');
  await started;
  await first.cancel();
  await first.settled;
  expect(await first.status()).toMatchObject({ phase: 'cancelled', windows: { mode: 'tcg' } });
  await first.close();
  const next = new QemuSetup(f.options, f.dependencies);
  await next.resumePending();
  await next.settled;
  expect(f.actions).toEqual(['tcg']);
  await next.start();
  await next.settled;
  expect(f.actions).toEqual(['tcg', 'tcg']);
  expect(await next.status()).toMatchObject({ required: false, phase: 'complete' });
  await next.close();
});

test('status and auto-resume never request elevation; explicit enable is coalesced and never restarts Windows', async (t) => {
  const f = await fixture(t);
  const setup = new QemuSetup(f.options, f.dependencies);
  await setup.status();
  await setup.resumePending();
  expect(f.actions).toEqual([]);
  await setup.enable();
  await setup.settled;
  expect(f.actions).toEqual(['enable']);
  const status = await setup.status();
  expect(status, JSON.stringify(status)).toMatchObject({ required: true, phase: 'waiting' });
  await setup.close();
});
