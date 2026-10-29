import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { rolldown } from 'rolldown';
import { afterEach, expect, it, vi } from 'vitest';
import { run as nativeRun } from './environment';
import type { HostConfig } from './host';
import { Setup, type SetupOptions } from './setup';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(protocol = 26) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-setup-'));
  roots.push(root);
  const userData = path.join(root, 'profile');
  const resources = path.join(root, 'resources');
  const base = path.join(root, 'vms');
  for (const dir of [userData, resources, base]) await fs.mkdir(dir, { mode: 0o700 });
  const raw = Buffer.from('SYNTHETIC LINUX IMAGE');
  const image = gzipSync(raw);
  const lima = Buffer.from('SYNTHETIC LIMA ARCHIVE');
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const manifest = {
    version: 1,
    id: `daban-${protocol}-${hash(image).slice(0, 16)}`,
    platform: 'darwin',
    arch: 'arm64',
    versions: { lima: '2.2.1', node: '24.22.1', dsh: '0.2.1-rc.3', protocol },
    cpus: 2,
    memoryGiB: 3,
    diskGiB: 16,
    user: { name: 'daban', uid: 2000 },
    image: {
      file: 'system.raw.gz',
      bytes: image.length,
      sha256: hash(image),
      rawBytes: raw.length,
      rawSha256: hash(raw),
    },
    lima: { file: 'lima.tar.gz', bytes: lima.length, sha256: hash(lima) },
  };
  await fs.writeFile(path.join(resources, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(resources, 'system.raw.gz'), image);
  await fs.writeFile(path.join(resources, 'lima.tar.gz'), lima);
  let vm: Record<string, unknown> | undefined;
  let creations = 0;
  const run = vi.fn<NonNullable<SetupOptions['run']>>(async (program, args, options) => {
    if (options?.permit) await options.permit({ pid: 99999999, started: 'mock-process' });
    if (program === '/bin/ps') return { code: 1, stdout: '' };
    if (program === '/usr/bin/tar') {
      const directory = args[args.indexOf('-C') + 1];
      await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
      await fs.writeFile(path.join(directory, 'bin/limactl'), 'SYNTHETIC EXECUTABLE', {
        mode: 0o700,
      });
    } else if (args[0] === 'list') return { code: 0, stdout: vm ? JSON.stringify(vm) : '' };
    else if (args[0] === 'create') {
      const config = JSON.parse(await fs.readFile(args.at(-1)!, 'utf8'));
      const directory = path.join(options!.env!.LIMA_HOME!, 'daban');
      await fs.mkdir(directory);
      vm = { name: 'daban', dir: directory, status: 'Stopped', config };
      creations++;
    } else if (args[0] === 'start') {
      if (!vm) throw new Error('MOCK_NO_VM');
      vm.status = 'Running';
    }
    return { code: 0, stdout: '' };
  });
  const check = vi.fn(async (_config: HostConfig) => undefined);
  const options: SetupOptions = {
    userData,
    resources,
    base,
    platform: 'darwin',
    arch: 'arm64',
    run,
    check,
    freeSpace: async () => 100 * 1024 ** 3,
  };
  return {
    root,
    options,
    run,
    check,
    manifest,
    raw,
    hasVm: () => !!vm,
    creations: () => creations,
    setVm: (value: Record<string, unknown>) => {
      vm = value;
    },
  };
}
async function finish(setup: Setup) {
  await setup.start();
  await setup.settled;
  return setup.status();
}
it('persists a fresh setup port after a collision without rebuilding its existing VM or contacting the occupied listener', async () => {
  const f = await fixture(27);
  f.check.mockRejectedValueOnce(new Error('SYNTHETIC_READINESS_FAILED'));
  await finish(new Setup(f.options));
  const file = path.join(f.options.userData, 'setup.json'),
    previous = JSON.parse(await fs.readFile(file, 'utf8'));
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(previous.port, '127.0.0.1', () => resolve(undefined));
  });
  f.check.mockImplementation(async (config) => {
    if (config.port === previous.port) throw new Error('SETUP_PORT_BUSY');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).port).toBe(config.port);
    return undefined;
  });
  try {
    expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'complete' });
    const committed = JSON.parse(
      await fs.readFile(path.join(f.options.userData, 'runtime.json'), 'utf8'),
    );
    expect(committed.port).not.toBe(previous.port);
    expect(f.creations()).toBe(1);
    expect(f.run.mock.calls.filter(([, args]) => args[0] === 'start')).toHaveLength(1);
    expect(server.listening).toBe(true);
    expect(connections).toBe(0);
  } finally {
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
  }
});
it('bounds setup port retries and resumes the same VM on a later attempt', async () => {
  const f = await fixture(27);
  f.check.mockRejectedValue(new Error('SETUP_PORT_BUSY'));
  const setup = new Setup(f.options);
  expect(await finish(setup)).toMatchObject({ phase: 'failed', error: 'SETUP_PORT' });
  expect(f.check).toHaveBeenCalledTimes(3);
  expect(f.creations()).toBe(1);
  f.check.mockResolvedValue(undefined);
  expect(await finish(setup)).toMatchObject({ phase: 'complete' });
  expect(f.creations()).toBe(1);
});
it.each(['cancel', 'arriving-config'] as const)('stops port retry when %s occurs', async (mode) => {
  const f = await fixture(27);
  let setup: Setup;
  f.check.mockImplementation(async () => {
    if (mode === 'cancel') await setup.cancel();
    else
      await fs.writeFile(
        path.join(f.options.userData, 'runtime.json'),
        'SYNTHETIC ARRIVING CONFIG',
      );
    throw new Error('SETUP_PORT_BUSY');
  });
  setup = new Setup(f.options);
  expect(await finish(setup)).toMatchObject(
    mode === 'cancel' ? { phase: 'cancelled' } : { phase: 'failed', error: 'SETUP_EXISTS' },
  );
  expect(f.check).toHaveBeenCalledTimes(1);
  expect(f.creations()).toBe(1);
  if (mode === 'arriving-config')
    expect(await fs.readFile(path.join(f.options.userData, 'runtime.json'), 'utf8')).toBe(
      'SYNTHETIC ARRIVING CONFIG',
    );
});
it.each(['existing', 'arriving'] as const)(
  'retains %s recovery authority instead of rebinding its port during setup',
  async (mode) => {
    const f = await fixture(27);
    const file = path.join(f.options.userData, 'runtime-recovery.json');
    if (mode === 'existing')
      await fs.writeFile(file, 'SYNTHETIC RECOVERY AUTHORITY', { mode: 0o600 });
    f.check.mockImplementation(async () => {
      await fs.writeFile(file, 'SYNTHETIC RECOVERY AUTHORITY', { mode: 0o600 });
      throw new Error('SETUP_PORT_BUSY');
    });
    expect(await finish(new Setup(f.options))).toMatchObject({
      phase: 'failed',
      error: 'SETUP_RECOVERY',
    });
    expect(f.check).toHaveBeenCalledTimes(mode === 'existing' ? 0 : 1);
    expect(f.creations()).toBe(mode === 'existing' ? 0 : 1);
    expect(await fs.readFile(file, 'utf8')).toBe('SYNTHETIC RECOVERY AUTHORITY');
    await expect(fs.stat(path.join(f.options.userData, 'runtime.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);
it.each(['image', 'tools'] as const)(
  'recovers after an actual SIGKILL during synthetic %s preparation',
  async (mode) => {
    const f = await fixture(27);
    const raw = Buffer.alloc(8 * 1024 * 1024, 77),
      image = gzipSync(raw);
    f.manifest.image = {
      ...f.manifest.image,
      bytes: image.length,
      rawBytes: raw.length,
      sha256: createHash('sha256').update(image).digest('hex'),
      rawSha256: createHash('sha256').update(raw).digest('hex'),
    };
    f.manifest.id = `daban-27-${f.manifest.image.sha256.slice(0, 16)}`;
    await fs.writeFile(path.join(f.options.resources, 'manifest.json'), JSON.stringify(f.manifest));
    await fs.writeFile(path.join(f.options.resources, 'system.raw.gz'), image);
    await fs.writeFile(
      path.join(f.root, 'crash.json'),
      JSON.stringify({ purpose: 'synthetic-preparation-crash', mode }),
      { mode: 0o600 },
    );
    const worker = path.join(f.root, 'worker.mjs');
    const build = await rolldown({
      input: 'apps/desktop/acceptance/preparation.acceptance.ts',
      platform: 'node',
      external: [/^node:/],
    });
    try {
      await build.write({ file: worker, format: 'esm', codeSplitting: false });
    } finally {
      await build.close();
    }
    const child = spawn(process.execPath, [worker, f.root, mode], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const outcome = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Synthetic crash worker timed out'));
        }, 10000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    expect(outcome, stderr).toEqual({ code: null, signal: 'SIGKILL' });
    const journal = JSON.parse(
      await fs.readFile(path.join(f.options.userData, 'setup.json'), 'utf8'),
    );
    const root = path.join(f.options.base!, (await fs.readdir(f.options.base!))[0]),
      partial = path.join(root, journal.preparation.name);
    expect(journal.preparation.kind).toBe(mode);
    expect(await fs.lstat(partial)).toMatchObject({
      dev: journal.preparation.dev,
      ino: journal.preparation.ino,
    });
    const original = f.options.run!;
    f.options.run = (program, args, options) =>
      program === '/bin/ps' ? nativeRun(program, args, options) : original(program, args, options);
    const resumed = new Setup(f.options);
    if (mode === 'tools') {
      expect(await finish(resumed)).toMatchObject({ phase: 'failed', error: 'SETUP_BUSY' });
      expect((await fs.lstat(partial)).isDirectory()).toBe(true);
      await fs.writeFile(path.join(f.root, 'child-ready-release'), 'SYNTHETIC RELEASE');
      for (let count = 0; count < 150; count++) {
        const check = await nativeRun(
          '/bin/ps',
          ['-p', String(journal.process.pid), '-o', 'lstart='],
          { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
        );
        if (check.code !== 0 || check.stdout.trim() !== journal.process.started) break;
        await delay(30);
      }
    } else {
      const info = await fs.lstat(partial);
      expect(info.size).toBeGreaterThan(0);
      expect(info.size).toBeLessThan(raw.length);
    }
    expect(await finish(resumed)).toMatchObject({ phase: 'complete' });
    await expect(fs.lstat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(await fs.readFile(path.join(f.options.userData, 'setup.json'), 'utf8'))
        .preparation,
    ).toBeUndefined();
    expect(f.creations()).toBe(1);
  },
);
async function interruptedPreparation(kind: 'image' | 'tools', published = false) {
  const f = await fixture(27);
  let first: Setup;
  f.options.onChange = (state) => {
    if (state.phase === 'creating') first.cancel().catch(() => {});
  };
  first = new Setup(f.options);
  expect(await finish(first)).toMatchObject({ phase: 'cancelled' });
  f.options.onChange = undefined;
  const root = path.join(f.options.base!, (await fs.readdir(f.options.base!))[0]);
  await fs.unlink(path.join(root, 'system.raw'));
  const name = `${kind === 'image' ? 'image' : 'tools'}-${randomUUID()}${kind === 'image' ? '.part' : ''}`;
  const partial = path.join(root, name);
  const protectedFile = path.join(f.root, 'protected');
  if (kind === 'image') {
    await fs.writeFile(partial, published ? f.raw : Buffer.from('SYNTHETIC PARTIAL'), {
      mode: 0o600,
      flag: 'wx',
    });
    if (published) await fs.link(partial, path.join(root, 'system.raw'));
  } else {
    await fs.mkdir(partial, { mode: 0o700 });
    await fs.writeFile(protectedFile, 'SYNTHETIC PROTECTED');
    await fs.symlink(protectedFile, path.join(partial, 'link'));
    await fs.writeFile(path.join(partial, 'incomplete'), 'SYNTHETIC PARTIAL');
  }
  const info = await fs.lstat(partial);
  const file = path.join(f.options.userData, 'setup.json');
  const document = {
    ...JSON.parse(await fs.readFile(file, 'utf8')),
    preparation: { kind, name, dev: info.dev, ino: info.ino },
  };
  await fs.writeFile(file, JSON.stringify(document), { mode: 0o600 });
  f.run.mockClear();
  return { ...f, root, partial, file, document, protectedFile };
}

it.each(['image', 'tools'] as const)(
  'reclaims only receipted interrupted %s preparation before another disk reservation',
  async (kind) => {
    const f = await interruptedPreparation(kind);
    const unknown = path.join(f.root, `image-${randomUUID()}.part`);
    await fs.writeFile(unknown, 'SYNTHETIC UNCLAIMED');
    f.options.freeSpace = async () => {
      await expect(fs.lstat(f.partial)).rejects.toMatchObject({ code: 'ENOENT' });
      return 100 * 1024 ** 3;
    };
    expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'complete' });
    expect(JSON.parse(await fs.readFile(f.file, 'utf8')).preparation).toBeUndefined();
    expect(await fs.readFile(unknown, 'utf8')).toBe('SYNTHETIC UNCLAIMED');
    if (kind === 'tools')
      expect(await fs.readFile(f.protectedFile, 'utf8')).toBe('SYNTHETIC PROTECTED');
    expect(f.creations()).toBe(1);
  },
);
it('reclaims an interrupted image publication link without deleting or rewriting the published cache', async () => {
  const f = await interruptedPreparation('image', true);
  expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'complete' });
  await expect(fs.lstat(f.partial)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.creations()).toBe(1);
});
it('retains replaced or unsafe preparation objects without running another effect', async () => {
  for (const mode of ['replacement', 'path', 'symlink', 'foreign-link']) {
    const f = await interruptedPreparation('image');
    if (mode === 'replacement') {
      await fs.rename(f.partial, `${f.partial}.retained`);
      await fs.writeFile(f.partial, 'SYNTHETIC PROTECTED REPLACEMENT', { mode: 0o600 });
    } else if (mode === 'path') {
      f.document.preparation.name = '../protected';
      await fs.writeFile(f.file, JSON.stringify(f.document));
    } else if (mode === 'symlink') {
      await fs.rename(f.partial, `${f.partial}.retained`);
      await fs.writeFile(f.protectedFile, 'SYNTHETIC PROTECTED LINK TARGET');
      await fs.symlink(f.protectedFile, f.partial);
    } else {
      await fs.link(f.partial, f.protectedFile);
    }
    expect(await finish(new Setup(f.options))).toMatchObject({
      phase: 'failed',
      error: 'SETUP_STORE',
    });
    expect(f.run).not.toHaveBeenCalled();
    if (mode === 'replacement')
      expect(await fs.readFile(f.partial, 'utf8')).toBe('SYNTHETIC PROTECTED REPLACEMENT');
    if (mode === 'symlink')
      expect(await fs.readFile(f.protectedFile, 'utf8')).toBe('SYNTHETIC PROTECTED LINK TARGET');
    if (mode === 'foreign-link')
      expect(await fs.readFile(f.protectedFile, 'utf8')).toBe('SYNTHETIC PARTIAL');
  }
});
it('keeps preparation while its recorded child is live, then resumes only after that same process has exited', async () => {
  const f = await interruptedPreparation('tools');
  f.document.process = { pid: 99999999, started: 'mock-live-preparation' };
  await fs.writeFile(f.file, JSON.stringify(f.document));
  const original = f.options.run!;
  let live = true;
  f.options.run = async (program, args, options) =>
    program === '/bin/ps' && live
      ? { code: 0, stdout: 'mock-live-preparation\n' }
      : original(program, args, options);
  expect(await finish(new Setup(f.options))).toMatchObject({
    phase: 'failed',
    error: 'SETUP_BUSY',
  });
  expect((await fs.lstat(f.partial)).isDirectory()).toBe(true);
  live = false;
  expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'complete' });
  await expect(fs.lstat(f.partial)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([26, 27, 32, 33])(
  'resumes an interrupted protocol %i install from its verified artifact without creating another VM',
  async (protocol) => {
    const f = await fixture(protocol);
    f.check.mockRejectedValueOnce(new Error('SYNTHETIC_INTERRUPTION'));
    expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'failed' });
    const resumed = new Setup(f.options);
    expect(await resumed.status()).toMatchObject({ phase: 'cancelled' });
    expect(await finish(resumed)).toMatchObject({ phase: 'complete' });
    expect(f.creations()).toBe(1);
  },
);
it('does not allocate, start or overwrite anything when an existing config is present, even if corrupt', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.options.userData, 'runtime.json'), 'SYNTHETIC EXISTING CONFIG');
  const setup = new Setup(f.options);
  expect(await setup.status()).toMatchObject({ required: false, phase: 'existing' });
  await setup.start();
  expect(f.run).not.toHaveBeenCalled();
  expect(await fs.readdir(f.options.base!)).toEqual([]);
  expect(await fs.readFile(path.join(f.options.userData, 'runtime.json'), 'utf8')).toBe(
    'SYNTHETIC EXISTING CONFIG',
  );
});
it('verifies local assets, creates one owned VM, authenticates before exclusive config commit and removes the raw cache', async () => {
  const f = await fixture();
  const setup = new Setup(f.options);
  expect(await setup.status()).toMatchObject({ required: true, phase: 'available' });
  expect(f.run).not.toHaveBeenCalled();
  expect(await finish(setup)).toMatchObject({ phase: 'complete' });
  expect(f.check).toHaveBeenCalledTimes(1);
  const config = JSON.parse(
    await fs.readFile(path.join(f.options.userData, 'runtime.json'), 'utf8'),
  );
  expect(config.vm).toBe('daban');
  expect(config.limaHome.startsWith(await fs.realpath(f.options.base!))).toBe(true);
  expect(f.run.mock.calls.filter(([, args]) => args[0] === 'create')).toHaveLength(1);
  expect((await fs.stat(path.join(f.options.userData, 'runtime.json'))).mode & 0o777).toBe(0o600);
  await expect(
    fs.stat(path.join(path.dirname(config.limaHome), 'system.raw')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects changed bytes and decompression beyond the declared raw budget before any VM effect', async () => {
  for (const mode of ['checksum', 'budget']) {
    const f = await fixture();
    if (mode === 'checksum')
      await fs.writeFile(path.join(f.options.resources, 'system.raw.gz'), 'SYNTHETIC TAMPER');
    else {
      f.manifest.image.rawBytes = 2;
      await fs.writeFile(
        path.join(f.options.resources, 'manifest.json'),
        JSON.stringify(f.manifest),
      );
    }
    const result = await finish(new Setup(f.options));
    expect(result).toMatchObject({ phase: 'failed', error: 'SETUP_INTEGRITY' });
    expect(
      f.run.mock.calls.filter(([, args]) => ['create', 'start'].includes(args[0])),
    ).toHaveLength(0);
    await expect(fs.stat(path.join(f.options.userData, 'runtime.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
});
it('shares repeated starts and cancels at the current VM effect boundary without stopping or deleting it', async () => {
  const f = await fixture();
  let release = () => {};
  const original = f.options.run!;
  let admitted = () => {};
  const entered = new Promise<undefined>((resolve) => {
    admitted = () => resolve(undefined);
  });
  f.options.run = vi.fn(async (program, args, options) => {
    if (args[0] === 'create') {
      await original(program, args, options);
      admitted();
      await new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      return { code: 0, stdout: '' };
    }
    return original(program, args, options);
  });
  const setup = new Setup(f.options);
  await setup.start();
  await entered;
  await setup.start();
  expect(await setup.cancel()).toMatchObject({ phase: 'cancelling' });
  release();
  await setup.settled;
  expect(await setup.status()).toMatchObject({ phase: 'cancelled' });
  expect(f.run.mock.calls.filter(([, args]) => args[0] === 'create')).toHaveLength(1);
  expect(
    f.run.mock.calls.filter(([, args]) => ['start', 'stop', 'delete'].includes(args[0])),
  ).toHaveLength(0);
  const resumed = new Setup(f.options);
  expect(await finish(resumed)).toMatchObject({ phase: 'complete' });
  expect(f.run.mock.calls.filter(([, args]) => args[0] === 'create')).toHaveLength(1);
});
it('never replays an uncertain creation while its recorded process is still live', async () => {
  const f = await fixture();
  const original = f.options.run!;
  f.options.run = vi.fn(async (program, args, options) => {
    if (program === '/bin/ps') {
      expect(options?.env?.LC_ALL).toBe('C');
      expect(options?.env?.TZ).toBe('UTC');
      return { code: 0, stdout: 'mock-process\n' };
    }
    if (args[0] === 'create') {
      await options!.permit!({ pid: 99999999, started: 'mock-process' });
      throw new Error('SYNTHETIC_OBSERVATION_LOST');
    }
    return original(program, args, options);
  });
  await finish(new Setup(f.options));
  const resumed = new Setup(f.options);
  expect(await finish(resumed)).toMatchObject({ phase: 'failed', error: 'SETUP_BUSY' });
  expect(
    vi.mocked(f.options.run!).mock.calls.filter(([, args]) => args[0] === 'create'),
  ).toHaveLength(1);
});
it('keeps a created VM after a readiness failure and retries authentication without rebuilding it', async () => {
  const f = await fixture();
  f.check.mockRejectedValueOnce(new Error('SYNTHETIC_NOT_READY'));
  const setup = new Setup(f.options);
  expect(await finish(setup)).toMatchObject({ phase: 'failed' });
  await expect(fs.stat(path.join(f.options.userData, 'runtime.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'complete' });
  expect(f.run.mock.calls.filter(([, args]) => args[0] === 'create')).toHaveLength(1);
});
it('preserves a config arriving during setup instead of replacing it after successful authentication', async () => {
  const f = await fixture();
  f.check.mockImplementationOnce(async () => {
    await fs.writeFile(
      path.join(f.options.userData, 'runtime.json'),
      'SYNTHETIC CONCURRENT CONFIG',
    );
  });
  expect(await finish(new Setup(f.options))).toMatchObject({
    phase: 'failed',
    error: 'SETUP_EXISTS',
  });
  expect(await fs.readFile(path.join(f.options.userData, 'runtime.json'), 'utf8')).toBe(
    'SYNTHETIC CONCURRENT CONFIG',
  );
});
it('rejects unsafe journals, foreign directories, missing payloads and unsupported platforms without VM effects', async () => {
  const f = await fixture();
  const setup = new Setup({ ...f.options, platform: 'win32' });
  expect(await setup.status()).toMatchObject({ phase: 'unavailable', error: 'SETUP_PLATFORM' });
  await fs.writeFile(path.join(f.options.userData, 'setup.json'), '{SYNTHETIC BROKEN');
  expect(await finish(new Setup(f.options))).toMatchObject({
    phase: 'failed',
    error: 'SETUP_STORE',
  });
  expect(f.run).not.toHaveBeenCalled();
});
it('never commits a symlink target and never starts late work after closing', async () => {
  const f = await fixture();
  const target = path.join(f.root, 'synthetic-protected');
  await fs.writeFile(target, 'SYNTHETIC PROTECTED');
  await fs.symlink(target, path.join(f.options.userData, 'runtime.json'));
  const setup = new Setup(f.options);
  expect(await setup.status()).toMatchObject({ required: false, phase: 'existing' });
  await setup.close();
  await expect(setup.start()).rejects.toThrow('SETUP_CLOSED');
  expect(f.run).not.toHaveBeenCalled();
  expect(await fs.readFile(target, 'utf8')).toBe('SYNTHETIC PROTECTED');
});

it('refuses a changed distribution and a foreign VM instead of adopting or replacing either', async () => {
  const f = await fixture();
  f.check.mockRejectedValueOnce(new Error('SYNTHETIC_NOT_READY'));
  await finish(new Setup(f.options));
  f.manifest.image.sha256 = 'a'.repeat(64);
  f.manifest.id = `daban-26-${'a'.repeat(16)}`;
  await fs.writeFile(path.join(f.options.resources, 'manifest.json'), JSON.stringify(f.manifest));
  f.run.mockClear();
  const changed = new Setup(f.options);
  expect(await changed.status()).toMatchObject({ phase: 'failed', error: 'SETUP_CHANGED' });
  expect(await finish(changed)).toMatchObject({ phase: 'failed', error: 'SETUP_CHANGED' });
  expect(f.run).not.toHaveBeenCalled();
  const foreign = await fixture();
  foreign.setVm({ name: 'daban', dir: foreign.root, status: 'Stopped', config: {} });
  expect(await finish(new Setup(foreign.options))).toMatchObject({
    phase: 'failed',
    error: 'SETUP_STORE',
  });
  expect(
    foreign.run.mock.calls.some(([, args]) =>
      ['create', 'start', 'stop', 'delete'].includes(args[0]),
    ),
  ).toBe(false);
});

it('waits for cancellable local preparation to finish cleanup before Electron can exit', async () => {
  const f = await fixture();
  const original = f.options.run!;
  let entered = () => {};
  const preparing = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release = () => {};
  f.options.run = async (program, args, options) => {
    const result = await original(program, args, options);
    if (program === '/usr/bin/tar') {
      entered();
      await new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
    }
    return result;
  };
  const setup = new Setup(f.options);
  await setup.start();
  await preparing;
  let closed = false;
  const closing = setup.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  const closedBeforeCleanup = closed;
  release();
  await closing;
  await setup.settled;
  expect(closedBeforeCleanup).toBe(false);
  expect(await setup.status()).toMatchObject({ phase: 'cancelled' });
  expect(f.run.mock.calls.some(([, args]) => ['create', 'start'].includes(args[0]))).toBe(false);
});

it('reserves only the remaining disk cost when resuming a prepared image, and still refuses insufficient space', async () => {
  const f = await fixture();
  let cancelled: Promise<unknown> | undefined;
  let first: Setup;
  f.options.onChange = (state) => {
    if (state.phase === 'creating') cancelled = first.cancel();
  };
  first = new Setup(f.options);
  expect(await finish(first)).toMatchObject({ phase: 'cancelled' });
  await cancelled;
  expect(f.hasVm()).toBe(false);
  f.options.onChange = undefined;
  f.options.freeSpace = async () => 1024 ** 3 + f.raw.length - 1;
  expect(await finish(new Setup(f.options))).toMatchObject({
    phase: 'failed',
    error: 'SETUP_SPACE',
  });
  expect(f.hasVm()).toBe(false);
  f.options.freeSpace = async () => 1024 ** 3 + f.raw.length;
  expect(await finish(new Setup(f.options))).toMatchObject({ phase: 'complete' });
  expect(f.creations()).toBe(1);
});

it('can exit promptly after a VM effect is admitted, preserves its receipt and never stops it', async () => {
  const f = await fixture();
  const original = f.options.run!;
  let release = () => {};
  let entered = () => {};
  const admitted = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  f.options.run = async (program, args, options) => {
    const result = await original(program, args, options);
    if (args[0] === 'create') {
      entered();
      await new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
    }
    return result;
  };
  const setup = new Setup(f.options);
  await setup.start();
  await admitted;
  const closing = setup.close();
  const immediate = await Promise.race([
    closing.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 40)),
  ]);
  release();
  await closing;
  await setup.settled;
  expect(immediate).toBe(true);
  expect(f.hasVm()).toBe(true);
  expect(f.creations()).toBe(1);
  expect(f.run.mock.calls.some(([, args]) => ['start', 'stop', 'delete'].includes(args[0]))).toBe(
    false,
  );
});
