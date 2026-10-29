import assert from 'node:assert/strict';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { manifest, present, run, verify } from '../electron/environment';
import { type HostConfig, ManagedHost } from '../electron/host';
import { availablePort } from '../electron/ports';
import { Setup } from '../electron/setup';

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const [rootArgument, resourcesArgument, builderArgument, phase] = process.argv.slice(2);
assert.ok(phase === undefined || phase === 'recheck');
const recheck = phase === 'recheck';
const root = await realpath(rootArgument),
  resources = await realpath(resourcesArgument),
  builder = await realpath(builderArgument);
assert.equal(
  path.dirname(root),
  await realpath(path.join(os.homedir(), '.local/share/daban/verify')),
);
assert.match(path.basename(root), /^ports-core-[a-zA-Z0-9-]+$/);
const info = await lstat(root);
assert.equal(info.uid, process.getuid?.());
assert.equal(info.mode & 0o777, 0o700);
const marker = JSON.parse(await readFile(path.join(root, 'owner.json'), 'utf8')) as {
  purpose: string;
  builder: string;
  artifact: string;
};
assert.equal(marker.purpose, 'synthetic-setup-port-check');
const payload = await manifest(resources);
assert.equal(payload.id, marker.artifact);
assert.equal(payload.versions.protocol, 27);
const build = JSON.parse(await readFile(path.join(builder, 'build.json'), 'utf8')) as {
  output: string;
  limaHome: string;
  id: string;
};
assert.equal(build.output, builder);
assert.equal(build.id, marker.builder);
assert.match(build.limaHome, /^\/tmp\/daban-image-[a-zA-Z0-9]+$/);
const builderState = await run(
  path.join(builder, 'tools/bin/limactl'),
  ['list', '--json', 'seed'],
  { env: { ...process.env, LIMA_HOME: build.limaHome } },
);
assert.equal(builderState.code, 0);
const producer = JSON.parse(builderState.stdout) as { name: string; status: string; dir: string };
assert.equal(producer.name, 'seed');
assert.equal(producer.status, 'Stopped');
assert.equal(await realpath(producer.dir), await realpath(path.join(build.limaHome, 'seed')));
const source = path.join(producer.dir, 'disk');
await verify(source, payload.image.rawBytes, payload.image.rawSha256, new AbortController().signal);

const userData = path.join(root, 'profile');
if (await present(userData)) {
  const existing = await lstat(userData);
  assert.equal(existing.isSymbolicLink(), false);
  assert.equal(existing.uid, process.getuid?.());
  assert.equal(existing.mode & 0o777, 0o700);
  assert.equal(
    JSON.parse(await readFile(path.join(userData, 'setup.json'), 'utf8')).stage,
    recheck ? 'ready' : 'assets',
  );
  assert.equal(await present(path.join(userData, 'runtime.json')), recheck);
  if (recheck) {
    const config = JSON.parse(
      await readFile(path.join(userData, 'runtime.json'), 'utf8'),
    ) as HostConfig;
    const state = await run(config.limactl, ['list', '--json', config.vm], {
      env: { ...process.env, LIMA_HOME: config.limaHome },
    });
    assert.equal(state.code, 0);
    assert.equal(JSON.parse(state.stdout).status, 'Stopped');
    await link(path.join(userData, 'runtime.json'), path.join(root, 'runtime-before-recheck.json'));
    await unlink(path.join(userData, 'runtime.json'));
  }
} else await mkdir(userData, { mode: 0o700 });
let preparing = !recheck,
  setup: Setup,
  blocked = 0,
  accepted = 0;
let bindingError: Error | undefined, binding: Promise<unknown> | undefined;
const server = net.createServer((socket) => {
  accepted++;
  socket.destroy();
});
const effects: string[] = [];
const options = {
  userData,
  resources,
  run: async (...args: Parameters<typeof run>) => {
    effects.push(args[1][0]);
    return run(...args);
  },
  onChange: (state: { phase: string; progress?: number }) => {
    if (preparing && state.phase === 'extracting' && state.progress === 0)
      setup.cancel().catch(() => {});
    if (!preparing && state.phase === 'starting') {
      binding = readFile(path.join(userData, 'setup.json'), 'utf8').then((text) => {
        blocked = Number(JSON.parse(text).port);
        return new Promise<unknown>((resolve, reject) => {
          server.once('error', reject);
          server.listen(blocked, '127.0.0.1', () => resolve(undefined));
        });
      });
      binding.catch((error: Error) => {
        bindingError = error;
      });
    }
  },
};
if (!recheck) {
  setup = new Setup(options);
  await setup.start();
  await setup.settled;
  const paused = await setup.status();
  assert.ok(paused.phase === 'cancelled' || paused.error === 'SETUP_SPACE', JSON.stringify(paused));
  await setup.close();
}
const initial = JSON.parse(await readFile(path.join(userData, 'setup.json'), 'utf8')) as {
  scope: string;
  id: string;
  port: number;
};
const owned = path.join(
  '/Users/Shared',
  `.daban-${process.getuid?.()}-${initial.scope.slice(0, 12)}-${initial.id.slice(0, 8)}`,
);
const owner = JSON.parse(await readFile(path.join(owned, 'owner.json'), 'utf8')) as {
  id: string;
  scope: string;
  artifact: string;
};
assert.equal(owner.id, initial.id);
assert.equal(owner.scope, initial.scope);
assert.equal(owner.artifact, payload.id);
// This is a prepared-cache resume, using only the digest-matching clean producer, never a user VM disk.
if (!recheck)
  assert.equal(
    (await run('/bin/cp', ['-c', '-n', source, path.join(owned, 'system.raw')])).code,
    0,
  );
preparing = false;
setup = new Setup(options);
let host: ManagedHost | undefined, config: HostConfig | undefined;
try {
  await setup.start();
  await setup.settled;
  await binding;
  assert.equal(bindingError, undefined);
  assert.equal((await setup.status()).phase, 'complete', JSON.stringify(await setup.status()));
  config = JSON.parse(await readFile(path.join(userData, 'runtime.json'), 'utf8')) as HostConfig;
  assert.equal(config.limaHome, path.join(owned, 'lima'));
  assert.equal(config.vm, 'daban');
  assert.ok(blocked > 1024 && config.port !== blocked);
  assert.equal(server.listening, true);
  assert.equal(accepted, 0);
  assert.equal(effects.filter((value) => value === 'create').length, recheck ? 0 : 1);
  assert.equal(effects.filter((value) => value === 'start').length, 1);
  host = new ManagedHost(config, path.join(userData, 'verify-tunnel.sock'));
  const client = await host.connectExisting(),
    snapshot = await client.status();
  assert.equal(snapshot.phase, 'ready');
  assert.equal(snapshot.protocolVersion, 27);
  assert.equal(snapshot.model.configured, false);
  assert.equal(snapshot.model.available, true);
  assert.equal(await host.portConflict(), false);
  const before = effects.length;
  const reopened = new Setup(options);
  assert.equal((await reopened.status()).phase, 'existing');
  await reopened.start();
  assert.equal(effects.length, before);
  await reopened.close();
  const result = {
    verified: true,
    scope: `actual macOS Setup/controller and real Linux/SSH, ${recheck ? 'same stopped VM recheck' : 'prepared-cache resume'}`,
    config,
    artifact: payload.id,
    blockedPort: blocked,
    chosenPort: config.port,
    foreignListenerRetained: server.listening,
    foreignConnections: accepted,
    vmCreationsThisRun: recheck ? 0 : 1,
    sameVmRetained: true,
    existingConfigReopenHadNoEffects: true,
    privateMasterRecognized: true,
    providerConfigured: false,
    modelTurns: 0,
    nativeElectronUi: false,
  };
  await writeFile(
    path.join(root, recheck ? 'recheck.json' : 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  console.log(JSON.stringify(result));
} finally {
  await host?.close();
  await setup.close();
  if (server.listening)
    await new Promise<unknown>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
  if (config) {
    assert.equal(await availablePort(config.port), config.port);
    const state = await run(config.limactl, ['list', '--json', config.vm], {
      env: { ...process.env, LIMA_HOME: config.limaHome },
    });
    assert.equal(state.code, 0);
    const value = JSON.parse(state.stdout) as { dir: string; status: string };
    assert.equal(await realpath(value.dir), await realpath(path.join(owned, 'lima/daban')));
    if (value.status === 'Running')
      assert.equal(
        (
          await run(config.limactl, ['stop', '--tty=false', config.vm], {
            env: { ...process.env, LIMA_HOME: config.limaHome },
          })
        ).code,
        0,
      );
  }
}
