import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ensureExecutionVm, materializeImage, verifyExecutorArchive } from './provision.js';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function tar(files: Record<string, string>, type = '0') {
  const chunks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const content = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
    );
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function fixture(t: { after: (action: () => unknown) => unknown }) {
  const root = await mkdtemp('/tmp/mock-provision-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = path.join(root, 'pack');
  await mkdir(pack);
  const raw = Buffer.alloc(16 * 1024 * 1024);
  raw.write('SYNTHETIC-CLEAN-IMAGE');
  const compressed = gzipSync(raw);
  const image = {
    id: 'mock-clean',
    bytes: compressed.length,
    sha256: sha(compressed),
    rawBytes: raw.length,
    rawSha256: sha(raw),
  };
  await writeFile(path.join(pack, 'system.raw.gz'), compressed);
  await writeFile(
    path.join(pack, 'manifest.json'),
    JSON.stringify({ version: 1, id: image.id, image: { file: 'system.raw.gz', ...image } }),
  );
  const archive = path.join(root, 'executor.tar.gz');
  await writeFile(
    archive,
    tar({
      'main.js': 'SYNTHETIC-ENTRY',
      'package.json': '{"type":"module"}',
      'node_modules/@daban/engine/package.json': '{"name":"@daban/engine"}',
      'node_modules/@daban/engine/dist/executor.js': 'SYNTHETIC-EXECUTOR',
      'node_modules/@daban/protocol/package.json': '{"name":"@daban/protocol"}',
      'node_modules/@daban/protocol/dist/index.js': 'SYNTHETIC-PROTOCOL',
    }),
  );
  const options = {
    directory: path.join(root, 'execution'),
    packDirectory: pack,
    executorArchive: archive,
    limactl: '/mock/tools/limactl',
  };
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let vm: Record<string, unknown> | undefined;
  let marker: unknown;
  const run = async (_program: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args, env: settings.env });
    if (args[0] === 'list' && args.length > 2 && !vm) return { code: 1, stdout: '' };
    if (args[0] === 'list') return { code: 0, stdout: vm ? JSON.stringify(vm) : '' };
    if (args[0] === 'create') {
      const config = JSON.parse(await readFile(args.at(-1)!, 'utf8'));
      const name = args.find((value) => value.startsWith('--name='))!.slice('--name='.length);
      const dir = path.join(String(settings.env.LIMA_HOME), name);
      await mkdir(path.join(String(settings.env.LIMA_HOME), '_config'));
      await writeFile(
        path.join(String(settings.env.LIMA_HOME), '_config/user'),
        'SYNTHETIC-SSH-IDENTITY',
        { mode: 0o600 },
      );
      await mkdir(dir);
      await writeFile(path.join(dir, 'disk'), 'SYNTHETIC-VM-DISK');
      vm = { name, status: 'Stopped', dir, config };
    }
    if (args[0] === 'start' && vm) vm.status = 'Running';
    if (args[0] === 'shell' && args.includes('cat'))
      return { code: marker ? 0 : 44, stdout: marker ? JSON.stringify(marker) : '' };
    if (args[0] === 'shell' && args.includes('/bin/sh')) {
      const journal = JSON.parse(
        await readFile(path.join(await realpath(options.directory), 'provision.json'), 'utf8'),
      );
      marker = { version: 1, id: journal.id, image: image.rawSha256, archive: journal.archive };
    }
    return { code: 0, stdout: '' };
  };
  return {
    root,
    image,
    options,
    calls,
    run,
    get vm() {
      return vm;
    },
    setMarker: (value: unknown) => {
      marker = value;
    },
  };
}

test('provisioning creates an isolated owned VM once and resumes its verified installation', async (t) => {
  const f = await fixture(t);
  const config = await ensureExecutionVm(f.options, {
    run: f.run,
    image: f.image,
    port: async () => 19876,
  });
  assert.equal(config.vm, 'execution');
  assert.equal(config.limaHome, path.join(await realpath(f.options.directory), 'lima'));
  assert.equal(config.port, 19876);
  const template = f.vm!.config as Record<string, unknown>;
  assert.deepEqual(template.mounts, []);
  assert.equal((template.ssh as Record<string, unknown>).forwardAgent, false);
  assert.equal(template.propagateProxyEnv, false);
  assert.ok(f.calls.every((call) => !call.env.SSH_AUTH_SOCK && !call.env.DEEPSEEK_API_KEY));
  assert.ok(f.calls.every((call) => !['stop', 'delete'].includes(call.args[0])));
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
  const again = await ensureExecutionVm(f.options, {
    run: f.run,
    image: f.image,
    port: async () => 19877,
  });
  assert.deepEqual(again, config);
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call.args.includes('/bin/sh')).length, 1);
  const script = await readFile(path.join(f.options.directory, 'bootstrap.sh'), 'utf8');
  assert.ok(script.indexOf('PROVISION_GUEST_NOT_CLEAN') < script.indexOf('NOPASSWD: ALL'));
  assert.match(script, /visudo/);
  assert.match(script, /daban-executor\.service/);
  assert.ok(
    script.includes('Environment=DABAN_WORKSPACE_DIR=/var/lib/bot-prototype/desktops/shared'),
  );
  assert.ok(script.includes('Environment=PROFILE_DIR=/var/lib/bot-prototype/profile'));
  assert.ok(script.includes('Environment=DABAN_DESKTOP_DIR=/var/lib/bot-prototype/desktops'));
  execFileSync('/bin/sh', ['-n', path.join(f.options.directory, 'bootstrap.sh')]);
});

test('requests an image lazily for first creation and reuses an installed VM without it', async (t) => {
  const f = await fixture(t);
  const cached = path.join(f.root, 'cached-image.gz');
  await rename(path.join(f.options.packDirectory, 'system.raw.gz'), cached);
  let downloads = 0;
  const options = {
    ...f.options,
    imageSource: async () => {
      downloads++;
      return cached;
    },
  };
  const first = await ensureExecutionVm(options, {
    run: f.run,
    image: f.image,
    port: async () => 19876,
  });
  assert.equal(downloads, 1);
  await rm(cached);
  assert.deepEqual(await ensureExecutionVm(options, { run: f.run, image: f.image }), first);
  assert.equal(downloads, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
});

test('pauses before committing a VM creation intent and can continue that same installation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    ensureExecutionVm(
      {
        ...f.options,
        checkpoint: async (phase: string) => {
          if (phase === 'creating') throw Error('SYNTHETIC_SETUP_PAUSED');
        },
      },
      { run: f.run, image: f.image, port: async () => 19876 },
    ),
    /SYNTHETIC_SETUP_PAUSED/,
  );
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(f.options.directory, 'provision.json'), 'utf8')).phase,
    'assets',
  );
  await ensureExecutionVm(f.options, { run: f.run, image: f.image });
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
});

test('unknown VM creation is retained and inspected without blind create replay or deletion', async (t) => {
  const f = await fixture(t);
  let creates = 0;
  const run = async (program: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
    if (args[0] === 'create') {
      creates++;
      throw new Error('SYNTHETIC-LOST-ACK');
    }
    return f.run(program, args, settings);
  };
  await assert.rejects(
    ensureExecutionVm(f.options, { run, image: f.image, port: async () => 19876 }),
    /PROVISION_CREATE_UNCERTAIN/,
  );
  await assert.rejects(
    ensureExecutionVm(f.options, { run, image: f.image }),
    /PROVISION_CREATE_UNCERTAIN/,
  );
  assert.equal(creates, 1);
  assert.ok(f.calls.every((call) => !call.args.includes('delete')));
});

test('unowned state, archive changes and tampered VM isolation are rejected', async (t) => {
  const f = await fixture(t);
  await mkdir(f.options.directory);
  await writeFile(path.join(f.options.directory, 'old-private-disk'), 'SYNTHETIC-PRIVATE');
  await assert.rejects(
    ensureExecutionVm(f.options, { run: f.run, image: f.image }),
    /PROVISION_STORE_UNOWNED/,
  );
  assert.equal(f.calls.length, 0);
  await rm(f.options.directory, { recursive: true });
  await ensureExecutionVm(f.options, { run: f.run, image: f.image, port: async () => 19876 });
  (f.vm!.config as Record<string, unknown>).mounts = [{ location: '/mock/host' }];
  await assert.rejects(
    ensureExecutionVm(f.options, { run: f.run, image: f.image }),
    /PROVISION_VM_IDENTITY/,
  );
  const changed = gunzipSync(await readFile(f.options.executorArchive));
  changed[512] ^= 1;
  await writeFile(f.options.executorArchive, gzipSync(changed));
  await assert.rejects(
    ensureExecutionVm(f.options, { run: f.run, image: f.image }),
    /PROVISION_STORE_IDENTITY/,
  );
});

test('sparse image streaming verifies both compressed and raw bytes and preserves existing targets', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'system.raw');
  await materializeImage(path.join(f.options.packDirectory, 'system.raw.gz'), target, f.image);
  assert.equal((await stat(target)).size, f.image.rawBytes);
  assert.ok((await stat(target)).blocks * 512 < f.image.rawBytes / 2);
  assert.equal(sha(await readFile(target)), f.image.rawSha256);
  await assert.rejects(
    materializeImage(path.join(f.options.packDirectory, 'system.raw.gz'), target, f.image),
  );
});

test('executor archive validation rejects traversal, links and guest SDKs before commands run', async (t) => {
  const f = await fixture(t);
  for (const value of [
    tar({ '../outside': 'SYNTHETIC' }),
    tar({ 'main.js': 'SYNTHETIC' }, '2'),
    tar({ 'node_modules/@deepseek-ai/dsh-sdk-client/package.json': '{}' }),
  ]) {
    await writeFile(f.options.executorArchive, value);
    await assert.rejects(verifyExecutorArchive(f.options.executorArchive), /PROVISION_ARCHIVE/);
  }
});

test('an execution VM cannot silently replace its separately created host SSH identity', async (t) => {
  const f = await fixture(t);
  const config = await ensureExecutionVm(f.options, {
    run: f.run,
    image: f.image,
    port: async () => 19876,
  });
  const key = path.join(config.limaHome, '_config/user');
  await rename(key, `${key}.retained`);
  await writeFile(key, 'SYNTHETIC-REPLACEMENT', { mode: 0o600 });
  await assert.rejects(
    ensureExecutionVm(f.options, { run: f.run, image: f.image }),
    /PROVISION_VM_IDENTITY/,
  );
});

test('an archive source replaced after validation cannot copy a private host file into the guest', async (t) => {
  const f = await fixture(t);
  const privateFile = path.join(f.root, 'private-synthetic.txt');
  await writeFile(privateFile, 'SYNTHETIC-PRIVATE-MUST-STAY-HOST');
  const run = async (program: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
    const result = await f.run(program, args, settings);
    if (args[0] === 'create') {
      await rm(f.options.executorArchive);
      await symlink(privateFile, f.options.executorArchive);
    }
    return result;
  };
  await assert.rejects(
    ensureExecutionVm(f.options, { run, image: f.image, port: async () => 19876 }),
  );
  assert.equal(f.calls.filter((call) => call.args[0] === 'copy').length, 0);
  assert.equal(await readFile(privateFile, 'utf8'), 'SYNTHETIC-PRIVATE-MUST-STAY-HOST');
});

test('malformed guest install metadata is rejected without echoing its bytes', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const run = async (program: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
    if (args[0] === 'shell' && args.includes('cat') && ++reads > 1)
      return { code: 0, stdout: 'SYNTHETIC-PRIVATE-MARKER' };
    return f.run(program, args, settings);
  };
  await assert.rejects(
    ensureExecutionVm(f.options, { run, image: f.image, port: async () => 19876 }),
    /^Error: PROVISION_GUEST_IDENTITY$/,
  );
});

test('long private roots keep the VM in that same root without exceeding OpenSSH temporary socket length', async (t) => {
  const f = await fixture(t);
  const parent = await realpath(f.root);
  const length = 85 - Buffer.byteLength(path.join(parent, 'exec', 'ssh.sock')) - 1;
  f.options.directory = path.join(f.root, 'x'.repeat(length));
  const options = { ...f.options, vm: 'exec' };
  const config = await ensureExecutionVm(options, {
    run: f.run,
    image: f.image,
    port: async () => 19876,
  });
  assert.equal(config.limaHome, await realpath(options.directory));
  assert.ok(
    Buffer.byteLength(path.join(config.limaHome, 'exec', 'ssh.sock.1234567890123456')) < 104,
  );
  const journal = JSON.parse(
    await readFile(path.join(options.directory, 'provision.json'), 'utf8'),
  );
  assert.equal(journal.limaHome, config.limaHome);
});

test('local image paths containing spaces are passed in the literal file URI form Lima reads', async (t) => {
  const f = await fixture(t);
  f.options.directory = path.join(f.root, 'execution space');
  await ensureExecutionVm(f.options, { run: f.run, image: f.image, port: async () => 19876 });
  const template = f.vm!.config as { images: { location: string }[] };
  assert.equal(
    template.images[0].location,
    `file://${path.join(await realpath(f.options.directory), 'system.raw')}`,
  );
  assert.ok(template.images[0].location.includes('execution space'));
});

test('an inspected partial create with no disk finishes the same instance without recreating it', async (t) => {
  const f = await fixture(t);
  const run = async (program: string, args: string[], settings: { env: NodeJS.ProcessEnv }) => {
    if (args[0] === 'create') {
      await f.run(program, args, settings);
      await rm(path.join(String(settings.env.LIMA_HOME), 'execution', 'disk'));
      return { code: 1, stdout: '' };
    }
    if (args[0] === 'start')
      await writeFile(
        path.join(String(settings.env.LIMA_HOME), 'execution', 'disk'),
        'SYNTHETIC-COMPLETED-DISK',
      );
    return f.run(program, args, settings);
  };
  const config = await ensureExecutionVm(f.options, {
    run,
    image: f.image,
    port: async () => 19876,
  });
  assert.equal(config.vm, 'execution');
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === 'start').length, 1);
});

test('checks free space before downloading an optional image or mutating a VM', async (t) => {
  const f = await fixture(t);
  let downloads = 0;
  await assert.rejects(
    ensureExecutionVm(
      {
        ...f.options,
        imageSource: async () => {
          downloads++;
          return path.join(f.options.packDirectory, 'system.raw.gz');
        },
      },
      { run: f.run, image: f.image, space: async () => 0 },
    ),
    /SETUP_SPACE/,
  );
  assert.equal(downloads, 0);
  assert.equal(
    f.calls.some((call) => call.args[0] === 'create'),
    false,
  );
});
