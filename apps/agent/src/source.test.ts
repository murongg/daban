import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { LegacySource } from './source.js';

const identity = { vm: 'mock-old', imageFingerprint: 'a'.repeat(64) };
const config = {
  limactl: '/mock/tools/limactl',
  limaHome: '/mock/lima',
  vm: identity.vm,
  port: 18766,
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: { after: (action: () => unknown) => unknown }) {
  const root = await mkdtemp('/tmp/mock-legacy-source-');
  let server: net.Server | undefined;
  let masterPid = 24001;
  let masterActive = false;
  let masterSocket = '';
  const expireMaster = async (stale = false) => {
    masterActive = false;
    if (server) {
      const current = server;
      server = undefined;
      if (stale) await rename(masterSocket, `${masterSocket}.stale`);
      await new Promise<unknown>((resolve, reject) =>
        current.close((error) => (error ? reject(error) : resolve(undefined))),
      );
      if (stale) await rename(`${masterSocket}.stale`, masterSocket);
    }
  };
  t.after(async () => {
    await expireMaster();
    await rm(root, { recursive: true, force: true });
  });
  const helper = path.join(root, 'source-reader.mjs'),
    cache = path.join(root, 'cache');
  await writeFile(helper, 'SYNTHETIC-READER-CODE');
  const helperHash = sha(await readFile(helper));
  const privateBytes = Buffer.alloc(131073, 255);
  privateBytes.write('SYNTHETIC-SECRET-47');
  const data = {
    control: { 'credentials.json': privateBytes },
    browser: { 'Default/Cookies': Buffer.from('SYNTHETIC-COOKIE') },
    shared: { '.local/bin/mock-tool': Buffer.from('#!/bin/sh\n') },
  };
  const calls: { program: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const streams: string[][] = [];
  const listen = async (socketPath: string) => {
    masterSocket = socketPath;
    server = net.createServer((socket) => socket.destroy());
    await new Promise<unknown>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(socketPath, () => resolve(undefined));
    });
    await chmod(socketPath, 0o600);
  };
  let running = true;
  const dependencies = {
    launch: async (program: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ program, args, env: options.env });
      await listen(args[args.indexOf('-S') + 1]);
      masterActive = true;
    },
    probe: async (program: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ program, args, env: options.env });
      if (args[args.indexOf('-O') + 1] === 'exit') {
        await expireMaster();
        return { code: 0 };
      }
      return masterActive ? { code: 0, pid: masterPid } : { code: 255 };
    },
    absent: async () => !masterActive,
    run: async (
      program: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
      input?: Uint8Array,
    ) => {
      calls.push({ program, args, env: options.env });
      if (args[0] === 'list')
        return Buffer.from(
          JSON.stringify({
            name: config.vm,
            status: running ? 'Running' : 'Stopped',
            dir: path.join(config.limaHome, config.vm),
          }),
        );
      if (args[0] === 'stop') {
        running = false;
        return Buffer.alloc(0);
      }
      if (args[0] === 'start') {
        running = true;
        return Buffer.alloc(0);
      }
      if (args.includes('mktemp')) return Buffer.from('/tmp/daban-source.mockABC123456\n');
      if (args.includes('sha256sum')) return Buffer.from(`${helperHash}  reader.mjs\n`);
      if (program === '/usr/bin/ssh' && input) {
        const request = JSON.parse(Buffer.from(input).toString('utf8'));
        if (request.method === 'quiesce')
          return Buffer.from(
            JSON.stringify({
              version: 1,
              source: identity,
              id: request.id,
              phase: 'prepared',
              revision: 1,
              boot: 'mock-boot',
              instance: 'mock-runtime',
              review: 'b'.repeat(64),
              runningModels: 0,
              runningGroups: 0,
              serviceStopped: true,
            }),
          );
        if (request.method === 'rollback')
          return Buffer.from(
            JSON.stringify({ source: identity, id: request.id, phase: 'rolled-back' }),
          );
        if (request.method === 'manifest') {
          const files = data[request.scope as keyof typeof data];
          return Buffer.from(
            JSON.stringify({
              source: identity,
              files: Object.entries(files).map(([name, bytes]) => ({
                path: name,
                kind: 'file',
                size: bytes.length,
                sha256: sha(bytes),
                mode: request.scope === 'shared' ? 0o755 : 0o600,
              })),
            }),
          );
        }
      }
      return Buffer.alloc(0);
    },
    stream: async function* (
      _program: string,
      args: string[],
      _options: { env: NodeJS.ProcessEnv },
      input: Uint8Array,
    ) {
      streams.push(args);
      const request = JSON.parse(Buffer.from(input).toString('utf8'));
      const scope = data[request.scope as keyof typeof data] as Record<string, Buffer>;
      yield scope[request.entry.path];
    },
  };
  return {
    root,
    helper,
    cache,
    privateBytes,
    dependencies,
    calls,
    streams,
    expireMaster,
    foreignSocket: () => listen(path.join(cache, 's')),
    replacePid: () => {
      masterPid++;
    },
  };
}

test('legacy source caches only metadata and streams bounded private bytes without leaking host environment', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await assert.rejects(source.control.manifest(), /SOURCE_NOT_PREPARED/);
  const prepared = await source.prepare();
  assert.equal(prepared.serviceStopped, true);
  assert.deepEqual((await source.control.manifest()).source, identity);
  const chunks: Buffer[] = [];
  for await (const chunk of source.control.read('credentials.json')) {
    assert.ok(chunk.byteLength <= 65536);
    chunks.push(Buffer.from(chunk));
  }
  assert.deepEqual(Buffer.concat(chunks), f.privateBytes);
  assert.equal((await source.shared.manifest()).files[0].mode, 0o755);
  assert.ok(f.calls.every((call) => !call.env.DEEPSEEK_API_KEY && !call.env.SSH_AUTH_SOCK));
  assert.ok(f.calls.every((call) => !JSON.stringify(call.args).includes('SYNTHETIC-SECRET')));
  assert.equal((await lstat(f.cache)).mode & 0o777, 0o700);
  for (const name of await readdir(f.cache)) {
    const file = path.join(f.cache, name);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    if ((await lstat(file)).isSocket()) continue;
    assert.equal((await readFile(file, 'utf8')).includes('SYNTHETIC-SECRET'), false);
  }
  assert.equal(
    f.calls.some((call) => call.args[0] === 'stop'),
    false,
  );
});

test('stopped-source manifests resume from the private cache without restarting the old VM', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  const manifest = await source.browser.manifest();
  await source.stopVm();
  const before = f.calls.length;
  const restored = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  assert.deepEqual(await restored.browser.manifest(), manifest);
  assert.equal(f.calls.length, before);
  await assert.rejects(async () => {
    for await (const _chunk of restored.control.read('credentials.json')) {
      /* Never reached after stop. */
    }
  }, /SOURCE_VM_STOPPED/);
  assert.equal(f.calls.filter((call) => call.args[0] === 'start').length, 0);
});

test('identity changes, unsafe cache permissions and transport errors fail without exposing output bytes', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  const wrong = new LegacySource(
    config,
    f.helper,
    f.cache,
    { ...identity, imageFingerprint: 'c'.repeat(64) },
    f.dependencies,
  );
  await assert.rejects(wrong.control.manifest(), /SOURCE_CACHE_CHANGED/);
  const failing = new LegacySource(config, f.helper, f.cache, identity, {
    ...f.dependencies,
    stream: async function* () {
      yield Buffer.from('SYNTHETIC-PARTIAL');
      throw Object.assign(new Error('SYNTHETIC-SECRET-ERROR'), { stdout: f.privateBytes });
    },
  });
  await assert.rejects(
    async () => {
      for await (const _chunk of failing.control.read('credentials.json')) {
        /* Receiver owns partial bytes. */
      }
    },
    (error: unknown) =>
      error instanceof Error && error.message === 'SOURCE_READ_FAILED' && !('stdout' in error),
  );
  await chmod(f.cache, 0o755);
  await assert.rejects(
    new LegacySource(config, f.helper, f.cache, identity, f.dependencies).control.manifest(),
    /SOURCE_CACHE_UNSAFE/,
  );
});

test('an explicit rollback can inspect its prior uncertain acknowledgement without starting the VM twice', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  await source.stopVm();
  let lost = true;
  const dependencies = {
    ...f.dependencies,
    run: async (
      program: string,
      args: string[],
      settings: { env: NodeJS.ProcessEnv },
      input?: Uint8Array,
    ) => {
      const result = await f.dependencies.run(program, args, settings, input);
      if (
        program === '/usr/bin/ssh' &&
        input &&
        JSON.parse(Buffer.from(input).toString('utf8')).method === 'rollback' &&
        lost
      ) {
        lost = false;
        throw new Error('SYNTHETIC-LOST-ROLLBACK-ACK');
      }
      return result;
    },
  };
  const rollback = new LegacySource(config, f.helper, f.cache, identity, dependencies);
  await assert.rejects(rollback.rollback(), /SOURCE_TRANSPORT_FAILED/);
  assert.equal((await rollback.rollback()).phase, 'rolled-back');
  assert.equal(f.calls.filter((call) => call.args[0] === 'start').length, 1);
  await assert.rejects(rollback.control.manifest(), /SOURCE_NOT_PREPARED/);
});

test('source cache identity is stable when equivalent configuration keys are reordered', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  const reordered = {
    vm: config.vm,
    port: config.port,
    limaHome: config.limaHome,
    limactl: config.limactl,
  };
  assert.deepEqual(
    await new LegacySource(
      reordered,
      f.helper,
      f.cache,
      identity,
      f.dependencies,
    ).control.manifest(),
    await source.control.manifest(),
  );
});

test('an immutable read retries a zero-byte transport failure without preparing or rebinding its source', async (t) => {
  const f = await fixture(t);
  let attempts = 0,
    prepares = 0;
  const source = new LegacySource(config, f.helper, f.cache, identity, {
    ...f.dependencies,
    run: async (program, args, options, input) => {
      if (
        program === '/usr/bin/ssh' &&
        input &&
        JSON.parse(Buffer.from(input).toString('utf8')).method === 'quiesce'
      )
        prepares++;
      return f.dependencies.run(program, args, options, input);
    },
    stream: async function* () {
      if (++attempts === 1)
        throw Object.assign(new Error('SYNTHETIC TRANSPORT LOSS'), {
          code: 'SOURCE_TRANSPORT_FAILED',
        });
      yield f.privateBytes;
    },
  });
  await source.prepare();
  const authority = await readFile(path.join(f.cache, 'source.json'));
  const chunks: Buffer[] = [];
  for await (const chunk of source.control.read('credentials.json'))
    chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), f.privateBytes);
  assert.equal(attempts, 2);
  assert.equal(prepares, 1);
  assert.deepEqual(await readFile(path.join(f.cache, 'source.json')), authority);
});

test('a partially yielded immutable read never retries or duplicates payload bytes', async (t) => {
  const f = await fixture(t);
  let attempts = 0,
    bytes = 0;
  const source = new LegacySource(config, f.helper, f.cache, identity, {
    ...f.dependencies,
    stream: async function* () {
      attempts++;
      yield f.privateBytes.subarray(0, 31);
      throw Object.assign(new Error('SYNTHETIC TRANSPORT LOSS'), {
        code: 'SOURCE_TRANSPORT_FAILED',
      });
    },
  });
  await source.prepare();
  await assert.rejects(async () => {
    for await (const chunk of source.control.read('credentials.json')) bytes += chunk.byteLength;
  }, /^Error: SOURCE_READ_FAILED$/);
  assert.equal(attempts, 1);
  assert.equal(bytes, 31);
});

test('zero-byte transport failures have exactly three bounded attempts', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const source = new LegacySource(config, f.helper, f.cache, identity, {
    ...f.dependencies,
    stream: async function* () {
      attempts++;
      yield await Promise.reject<Uint8Array>(
        Object.assign(new Error('SYNTHETIC TRANSPORT LOSS'), { code: 'SOURCE_TRANSPORT_FAILED' }),
      );
    },
  });
  await source.prepare();
  await assert.rejects(async () => {
    for await (const _chunk of source.control.read('credentials.json')) {
      /* No payload is delivered. */
    }
  }, /^Error: SOURCE_READ_FAILED$/);
  assert.equal(attempts, 3);
});

test('semantic reader failures and size or digest mismatches never enter the transport retry path', async (t) => {
  const f = await fixture(t);
  for (const failure of ['semantic', 'size', 'digest', 'empty']) {
    let attempts = 0;
    const source = new LegacySource(config, f.helper, f.cache, identity, {
      ...f.dependencies,
      stream: async function* () {
        attempts++;
        if (failure === 'semantic')
          throw Object.assign(new Error('SOURCE_READ_FAILED'), { code: 'SOURCE_READ_FAILED' });
        if (failure === 'size') yield Buffer.alloc(f.privateBytes.length + 1);
        if (failure === 'digest') yield Buffer.alloc(f.privateBytes.length);
      },
    });
    if (failure === 'semantic') await source.prepare();
    await assert.rejects(async () => {
      for await (const _chunk of source.control.read('credentials.json')) {
        /* Receiver owns any partial bytes. */
      }
    }, /^Error: SOURCE_READ_FAILED$/);
    assert.equal(attempts, 1);
  }
});

test('prepared immutable payloads reuse one private scoped master without a new TCP fallback', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  for (const scope of ['control', 'browser', 'shared'] as const) {
    const manifest = await source.port(scope).manifest();
    for (const entry of manifest.files)
      for await (const _chunk of source.port(scope).read(entry.path)) {
        /* Synthetic bytes are discarded. */
      }
  }
  const launches = f.calls.filter((call) => call.args.includes('-M'));
  assert.equal(launches.length, 1);
  const socket = launches[0].args[launches[0].args.indexOf('-S') + 1];
  assert.equal(socket, path.join(await realpath(f.cache), 's'));
  assert.ok(Buffer.byteLength(socket) + 17 < 104);
  assert.ok(launches[0].args.includes('ControlPersist=60'));
  assert.ok(
    f.streams.every(
      (args) =>
        args[args.indexOf('-S') + 1] === socket && args.includes('ProxyCommand=/usr/bin/false'),
    ),
  );
  assert.equal((await lstat(socket)).mode & 0o777, 0o600);
  assert.ok(f.calls.every((call) => !call.env.SSH_AUTH_SOCK));
  const resumed = new LegacySource(
    config,
    f.helper,
    f.cache,
    {
      imageFingerprint: identity.imageFingerprint,
      vm: identity.vm,
    },
    f.dependencies,
  );
  for await (const _chunk of resumed.control.read('credentials.json')) {
    /* A restart verifies the same master scope. */
  }
  assert.equal(f.calls.filter((call) => call.args.includes('-M')).length, 1);
});

test('foreign sockets and replaced master identities fail closed before payload transfer', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  await f.foreignSocket();
  await assert.rejects(async () => {
    for await (const _chunk of source.control.read('credentials.json')) {
      /* No foreign transport is used. */
    }
  }, /SOURCE_/);
  assert.equal(f.streams.length, 0);
  assert.equal(
    f.calls.filter((call) => call.args.includes('-O') || call.args.includes('-M')).length,
    0,
  );
  await f.expireMaster();
  for await (const _chunk of source.control.read('credentials.json')) {
    /* Establish our own scoped master. */
  }
  const before = f.streams.length;
  f.replacePid();
  await assert.rejects(async () => {
    for await (const _chunk of source.control.read('credentials.json')) {
      /* A replaced identity is never adopted. */
    }
  }, /SOURCE_/);
  assert.equal(f.streams.length, before);
  assert.equal(f.calls.filter((call) => call.args.includes('-M')).length, 1);
});

test('an expired owned master is rebuilt while close only detaches SSH and explicit power closes it first', async (t) => {
  const f = await fixture(t);
  const source = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  await source.prepare();
  for await (const _chunk of source.control.read('credentials.json')) {
    /* Initial master. */
  }
  await f.expireMaster(true);
  for await (const _chunk of source.control.read('credentials.json')) {
    /* Rebuilt after idle expiry. */
  }
  assert.equal(f.calls.filter((call) => call.args.includes('-M')).length, 2);
  await f.expireMaster();
  for await (const _chunk of source.control.read('credentials.json')) {
    /* A removed expired socket also rebuilds. */
  }
  assert.equal(f.calls.filter((call) => call.args.includes('-M')).length, 3);
  await source.close();
  assert.equal(
    f.calls.filter((call) => call.args[0] === 'stop' || call.args[0] === 'start').length,
    0,
  );
  assert.equal(
    f.calls.filter((call) => call.args[call.args.indexOf('-O') + 1] === 'exit').length,
    1,
  );

  const resumed = new LegacySource(config, f.helper, f.cache, identity, f.dependencies);
  for await (const _chunk of resumed.control.read('credentials.json')) {
    /* A separate owner resumes the same frozen snapshot. */
  }
  await resumed.stopVm();
  const stop = f.calls.findIndex((call) => call.args[0] === 'stop');
  assert.ok(stop > 0);
  assert.equal(f.calls[stop - 1].args[f.calls[stop - 1].args.indexOf('-O') + 1], 'exit');
});
