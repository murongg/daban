import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { componentIndex, componentTag } from '@daban/engine/component';
import { extractComponent } from '../apps/desktop/electron/component-install.ts';
import {
  type CheckpointInput,
  checkpointNames,
  type ReleaseContext,
  readCheckpoint,
  writeCheckpoint,
} from './checkpoint.ts';
import { fetchComponent } from './component-release.ts';
import {
  componentSourceId,
  referenceComponent,
  verifyLinux,
  withComponentStage,
} from './components.ts';
import { hashAsset } from './environment.ts';
import { packageMacUpdate } from './installer.ts';
import {
  finishComponent,
  finishDistribution,
  type NotaryReceipt,
  prepareDistribution,
  signingDiagnostics,
} from './sign.ts';

const runtimeZip = 'Daban-runtime-macos-arm64.zip';
const reference = 'runtime-macos-arm64.json';
const linux = ['linux.json', 'Daban-lima-macos-arm64.tar.gz', 'Daban-executor-linux-arm64.tar.gz'];
const copy = (source: string, target: string) =>
  copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
async function freezeRuntime(candidate: string, output: string, input: CheckpointInput) {
  await mkdir(output, { mode: 0o700 });
  for (const name of checkpointNames(input))
    await copy(path.join(candidate, name), path.join(output, name));
  return writeCheckpoint(output, input);
}
export async function restoreRuntime(
  output: string,
  context: ReleaseContext,
  fetch: (directory: string) => Promise<boolean>,
  cache?: string,
) {
  const input: CheckpointInput = { ...context, phase: 'runtime-prepared', cached: true };
  if (cache) {
    await readCheckpoint(cache, context, 'runtime-ready');
    await freezeRuntime(cache, output, input);
    return true;
  }
  return withComponentStage(async (stage) => {
    const candidate = path.join(stage, 'runtime');
    if (!(await fetch(candidate))) return false;
    await freezeRuntime(candidate, output, input);
    return true;
  });
}

export async function prepareRuntime(
  output: string,
  context: ReleaseContext,
  operations: {
    fetch: (directory: string) => Promise<boolean>;
    prepare: (directory: string) => Promise<NotaryReceipt>;
  },
) {
  return withComponentStage(async (stage) => {
    const candidate = path.join(stage, 'runtime');
    const cached = await operations.fetch(candidate);
    const input: CheckpointInput = cached
      ? { ...context, phase: 'runtime-prepared', cached: true }
      : {
          ...context,
          phase: 'runtime-prepared',
          cached: false,
          receipt: await operations.prepare(candidate),
        };
    return freezeRuntime(candidate, output, input);
  });
}
export async function finishRuntime(
  input: string,
  output: string,
  context: ReleaseContext,
  complete: (archive: string, target: string) => Promise<unknown>,
) {
  const saved = await readCheckpoint(input, context, 'runtime-prepared');
  assert.ok(saved.phase === 'runtime-prepared');
  await mkdir(output, { mode: 0o700 });
  const archive = path.join(output, runtimeZip);
  if (saved.cached) await copy(path.join(input, runtimeZip), archive);
  else await complete(path.join(input, 'runtime-signed.zip'), archive);
  for (const name of linux) await copy(path.join(input, name), path.join(output, name));
  await writeFile(
    path.join(output, reference),
    JSON.stringify(await referenceComponent(archive, context.source, 'darwin', 'arm64'), null, 2) +
      '\n',
    { flag: 'wx' },
  );
  return writeCheckpoint(output, { ...context, phase: 'runtime-ready' });
}
async function runtimeBinding(directory: string, context: ReleaseContext) {
  await readCheckpoint(directory, context, 'runtime-ready');
  // Two signed builds can share a source ID but differ in bytes; bind the client to its exact runtime.
  return (await hashAsset(path.join(directory, reference), 'sha256')).digest;
}
export async function prepareClient(
  runtime: string,
  output: string,
  context: ReleaseContext,
  operations: {
    prepare: (
      reference: string,
      stage: string,
    ) => Promise<{ app: string; dmg: string; receipt: NotaryReceipt }>;
    archive: (app: string, target: string) => Promise<unknown>;
  },
) {
  const binding = await runtimeBinding(runtime, context);
  await mkdir(output, { mode: 0o700 });
  return withComponentStage(async (stage) => {
    const prepared = await operations.prepare(path.join(runtime, reference), stage);
    const embedded = JSON.parse(
      await readFile(path.join(prepared.app, 'Contents/Resources/runtime.json'), 'utf8'),
    );
    assert.deepEqual(
      embedded,
      JSON.parse(await readFile(path.join(runtime, reference), 'utf8')),
      'CLIENT_RUNTIME_BINDING',
    );
    const version = JSON.parse(
      await readFile(path.join(prepared.app, 'Contents/Resources/app/package.json'), 'utf8'),
    ).version;
    assert.equal(version, context.release, 'CLIENT_RELEASE_VERSION');
    const name = `Daban-${context.release}-macos-arm64.dmg`;
    assert.equal(path.basename(prepared.dmg), name, 'CLIENT_RELEASE_VERSION');
    await operations.archive(prepared.app, path.join(output, 'client-signed.zip'));
    await copy(prepared.dmg, path.join(output, name));
    return writeCheckpoint(output, {
      ...context,
      phase: 'client-prepared',
      receipt: prepared.receipt,
      runtime: binding,
    });
  });
}
export async function finishClient(
  runtime: string,
  input: string,
  output: string,
  context: ReleaseContext,
  complete: (archive: string, dmg: string, runtime: string, output: string) => Promise<unknown>,
) {
  const binding = await runtimeBinding(runtime, context);
  const saved = await readCheckpoint(input, context, 'client-prepared');
  assert.ok(saved.phase === 'client-prepared');
  assert.equal(saved.runtime, binding, 'CLIENT_RUNTIME_BINDING');
  await mkdir(output, { mode: 0o700 });
  const dmg = path.join(output, `Daban-${context.release}-macos-arm64.dmg`);
  await copy(path.join(input, path.basename(dmg)), dmg);
  await complete(path.join(input, 'client-signed.zip'), dmg, runtime, output);
  // Keep electron-builder's generated channel name for both stable and prerelease builds.
  const channels = (await readdir(output)).filter((name) =>
    /^[a-zA-Z0-9][a-zA-Z0-9.-]*-mac\.yml$/.test(name),
  );
  assert.equal(channels.length, 1, 'CLIENT_UPDATE_CHANNEL');
  return writeCheckpoint(output, {
    ...context,
    phase: 'client-ready',
    runtime: binding,
    receipt: saved.receipt,
    update: channels[0],
  });
}
export async function stageMacArtifacts(
  runtime: string,
  client: string,
  components: string,
  release: string,
  context: ReleaseContext,
) {
  const binding = await runtimeBinding(runtime, context);
  const saved = await readCheckpoint(client, context, 'client-ready');
  assert.ok(saved.phase === 'client-ready');
  assert.equal(saved.runtime, binding, 'CLIENT_RUNTIME_BINDING');
  await mkdir(components, { recursive: true, mode: 0o700 });
  await mkdir(release, { mode: 0o700 });
  for (const name of checkpointNames({ ...context, phase: 'runtime-ready' }))
    await copy(path.join(runtime, name), path.join(components, name));
  for (const name of checkpointNames(saved))
    await copy(path.join(client, name), path.join(release, name));
}

const execute = promisify(execFile);
const run = async (program: string, args: string[]) => {
  const value = await execute(program, args, {
    timeout: 90 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(value.stdout);
  process.stderr.write(value.stderr);
  return value.stdout;
};
async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [action, input, output, extra, release] = process.argv.slice(2);
  const context: ReleaseContext = {
    commit: (await run('git', ['rev-parse', 'HEAD'])).trim(),
    source: await componentSourceId(root),
    release: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  };
  const published = async (directory: string) => {
    if (!(await fetchComponent(componentTag(context.source), runtimeZip, directory))) return false;
    for (const name of linux)
      assert.ok(
        await fetchComponent(componentTag(context.source), name, directory),
        'COMPONENT_RELEASE_ASSETS',
      );
    await verifyLinux(directory, context.source);
    return true;
  };
  if (action === 'stage') {
    assert.ok(input && output && extra && release, 'MACOS_ARGUMENTS');
    await stageMacArtifacts(input, output, extra, release, context);
    return;
  }
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  if (action === 'runtime-cache') {
    assert.ok(input && process.env.GITHUB_OUTPUT, 'MACOS_ARGUMENTS');
    const cached = await restoreRuntime(
      input,
      context,
      published,
      process.env.RUNTIME_CACHE || undefined,
    );
    await appendFile(process.env.GITHUB_OUTPUT, `cached=${cached}\n`);
    return;
  }
  assert.ok(input && output, 'MACOS_ARGUMENTS');
  const node = (args: string[]) => run(process.execPath, ['--experimental-strip-types', ...args]);
  const signing = {
    identity: process.env.MACOS_SIGNING_IDENTITY ?? '',
    keychain: process.env.MACOS_KEYCHAIN,
  };
  if (action === 'runtime-prepare') {
    assert.ok(extra, 'MACOS_ARGUMENTS');
    await prepareRuntime(output, context, {
      fetch: published,
      prepare: async (directory) => {
        await node([path.join(root, 'tools/component.ts'), 'prepare', directory, input, extra]);
        return JSON.parse(
          await readFile(path.join(directory, 'notarization.json'), 'utf8'),
        ) as NotaryReceipt;
      },
    });
  } else if (action === 'runtime-finish') {
    await finishRuntime(input, output, context, async (archive, target) =>
      withComponentStage(async (stage) => {
        await extractComponent(archive, stage, 'darwin');
        const app = path.join(stage, 'DabanRuntime.app');
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
        await finishComponent(app, target);
      }),
    );
    await verifyLinux(output, context.source);
  } else if (action === 'client-prepare') {
    await prepareClient(input, output, context, {
      prepare: async (ref, stage) => {
        const bundle = path.join(stage, 'bundle');
        await node([path.join(root, 'tools/desktop.ts'), ref, bundle]);
        const app = path.join(bundle, 'Daban.app');
        return { app, ...(await prepareDistribution(app, path.join(stage, 'signed'), signing)) };
      },
      archive: (app, target) => run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, target]),
    });
  } else if (action === 'client-finish') {
    assert.ok(extra, 'MACOS_ARGUMENTS');
    await finishClient(input, output, extra, context, async (archive, dmg, runtime, target) =>
      withComponentStage(async (stage) => {
        await extractComponent(archive, stage, 'darwin');
        const app = path.join(stage, 'Daban.app');
        assert.equal(
          JSON.parse(await readFile(path.join(app, 'Contents/Resources/app/package.json'), 'utf8'))
            .version,
          context.release,
          'CLIENT_RELEASE_VERSION',
        );
        assert.deepEqual(
          JSON.parse(await readFile(path.join(app, 'Contents/Resources/runtime.json'), 'utf8')),
          componentIndex(
            JSON.parse(await readFile(path.join(runtime, reference), 'utf8')),
            context.source,
          ),
          'CLIENT_RUNTIME_BINDING',
        );
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
        await run('/usr/bin/codesign', ['--verify', '--strict', dmg]);
        await finishDistribution(app, dmg);
        await packageMacUpdate(app, target);
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
        await node([
          path.join(root, 'tools/component.ts'),
          'validate',
          app,
          path.join(runtime, runtimeZip),
          path.join(runtime, reference),
        ]);
      }),
    );
  } else throw Error('MACOS_ACTION');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main().catch((error: unknown) => {
    for (const detail of signingDiagnostics(error)) console.error(detail);
    throw error;
  });
