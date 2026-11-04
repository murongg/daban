import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  componentFilename,
  componentIndex,
  componentTag,
  type LinuxIndex,
  linuxFilename,
  linuxIndex,
} from '@daban/engine/component';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  componentPaths,
  extractComponent,
  verifyComponent,
} from '../apps/desktop/electron/component-install.ts';
import { fetchComponent, publishComponent } from './component-release.ts';
import {
  assembleComponent,
  assembleLinux,
  componentSourceId,
  verifyLinux,
  withComponentStage,
} from './components.ts';
import { hashAsset } from './environment.ts';
import { materializeHost, sealHostPackage, verifyExecutorBuild } from './roles.ts';
import { signComponent, signLinux } from './sign.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const [action, input, nodeDirectory, environmentDirectory] = process.argv.slice(2);
const id = await componentSourceId(root);
if (!['id', 'publish'].includes(action))
  assert.ok(
    (process.platform === 'darwin' && process.arch === 'arm64') ||
      (process.platform === 'win32' && process.arch === 'x64'),
    'COMPONENT_PLATFORM',
  );
const platform = process.platform === 'darwin' ? 'darwin' : 'win32';
const arch = platform === 'darwin' ? 'arm64' : 'x64';
const asset = { platform, arch, bytes: 1, sha256: '0'.repeat(64) };
const filename = componentFilename(
  componentIndex({ version: 1, id, assets: [asset] }, id).assets[0],
);
if (action === 'id') console.log(componentTag(id));
else if (action === 'fetch') {
  assert.ok(input && process.env.GITHUB_OUTPUT, 'COMPONENT_ARGUMENTS');
  const cached = await fetchComponent(componentTag(id), filename, path.resolve(input));
  if (cached && platform === 'darwin') {
    for (const name of ['linux.json', linuxFilename('lima'), linuxFilename('executor')]) {
      assert.ok(
        await fetchComponent(componentTag(id), name, path.resolve(input)),
        'COMPONENT_RELEASE_ASSETS',
      );
    }
    await verifyLinux(input, id);
  }
  await appendFile(process.env.GITHUB_OUTPUT, `cached=${cached}\n`);
} else if (action === 'publish') {
  assert.ok(input && process.env.EXPECTED_COMMIT, 'COMPONENT_ARGUMENTS');
  const files: string[] = [];
  for (const name of await readdir(input)) {
    if (!/^runtime-(macos-arm64|windows-x64)\.json$/.test(name)) continue;
    const index = componentIndex(JSON.parse(await readFile(path.join(input, name), 'utf8')), id);
    for (const item of index.assets) {
      const archive = path.join(input, componentFilename(item));
      assert.equal((await stat(archive)).size, item.bytes);
      assert.equal((await hashAsset(archive, 'sha256')).digest, item.sha256);
      files.push(archive);
    }
  }
  assert.equal(files.length, 2, 'COMPONENT_RELEASE_ASSETS');
  await verifyLinux(input, id);
  for (const kind of ['lima', 'executor'] as const)
    files.push(path.join(input, linuxFilename(kind)));
  files.push(path.join(input, 'linux.json'));
  await publishComponent(componentTag(id), process.env.EXPECTED_COMMIT, files);
} else if (action === 'build') {
  assert.ok(input && nodeDirectory, 'COMPONENT_ARGUMENTS');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const signing = {
    identity: process.env.MACOS_SIGNING_IDENTITY ?? '',
    keychain: process.env.MACOS_KEYCHAIN,
  };
  let linuxReference: LinuxIndex | undefined;
  let linuxDirectory: string | undefined;
  if (platform === 'darwin') {
    assert.ok(environmentDirectory, 'COMPONENT_ENVIRONMENT');
    if (!signing.identity) throw Error('DEVELOPER_ID_REQUIRED');
    linuxDirectory = await mkdtemp(path.join(tmpdir(), 'daban-linux-release-'));
    try {
      linuxReference = await assembleLinux(
        { output: linuxDirectory, environmentDirectory: path.resolve(environmentDirectory), id },
        (resources) => signLinux(resources, signing),
      );
    } catch (error) {
      await rm(linuxDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    console.time('runtime:assemble');
    const result = await assembleComponent({
      output: path.resolve(input),
      nodeDirectory: path.resolve(nodeDirectory),
      environmentDirectory: linuxDirectory && path.join(linuxDirectory, 'environment'),
      linuxReference,
      platform,
      arch,
      version,
      id,
    });
    console.timeEnd('runtime:assemble');
    const archive = path.resolve(input, filename);
    if (linuxDirectory) {
      for (const name of ['linux.json', linuxFilename('lima'), linuxFilename('executor')])
        await copyFile(path.join(linuxDirectory, name), path.join(input, name));
    }
    if (process.platform === 'darwin') {
      if (process.env.MACOS_SIGNING_IDENTITY)
        await signComponent(result.directory, archive, {
          identity: process.env.MACOS_SIGNING_IDENTITY,
          keychain: process.env.MACOS_KEYCHAIN,
        });
      else throw Error('DEVELOPER_ID_REQUIRED');
    } else {
      // Seal after materialization so the archive includes every dependency independently of build-machine links.
      console.time('runtime:materialize');
      await materializeHost(result.agent);
      console.timeEnd('runtime:materialize');
      console.time('runtime:seal');
      await sealHostPackage(result.agent);
      console.timeEnd('runtime:seal');
      console.time('runtime:archive');
      execFileSync('tar.exe', ['-a', '-cf', archive, '-C', path.resolve(input), 'DabanRuntime']);
      console.timeEnd('runtime:archive');
    }
    console.log(archive);
  } finally {
    if (linuxDirectory) await rm(linuxDirectory, { recursive: true, force: true });
  }
} else if (action === 'validate') {
  assert.ok(input && nodeDirectory && environmentDirectory, 'COMPONENT_ARGUMENTS');
  const reference = componentIndex(JSON.parse(await readFile(environmentDirectory, 'utf8')), id);
  const expected = reference.assets.find(
    (item) => item.platform === platform && item.arch === arch,
  );
  assert.ok(expected, 'COMPONENT_PLATFORM');
  const archive = path.resolve(nodeDirectory);
  console.time('runtime:archive-integrity');
  assert.equal((await stat(archive)).size, expected.bytes);
  assert.equal((await hashAsset(archive, 'sha256')).digest, expected.sha256);
  console.timeEnd('runtime:archive-integrity');
  await withComponentStage(async (temporary) => {
    console.time('runtime:extract');
    // Extraction must inherit private ACLs rather than the Windows shared temp permissions.
    const stage = await secureDirectory(path.join(temporary, 'private'));
    await extractComponent(archive, stage, platform);
    console.timeEnd('runtime:extract');
    console.time('runtime:verify');
    await verifyComponent({
      directory: stage,
      id,
      platform,
      arch,
      archive,
      publisher: path.resolve(input),
    });
    console.timeEnd('runtime:verify');
    if (platform === 'darwin') {
      const directory = path.dirname(archive);
      const entry = componentPaths(stage, platform).entry;
      const linux = linuxIndex(
        JSON.parse(await readFile(path.join(path.dirname(entry), 'linux.json'), 'utf8')),
        id,
      );
      assert.deepEqual(linux, await verifyLinux(directory, id));
      await verifyExecutorBuild(path.join(directory, linuxFilename('executor')));
    }
    assert.equal(
      execFileSync(componentPaths(stage, platform).executable, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      'v24.22.1',
    );
  });
  console.log('Verified downloaded runtime integrity, publisher trust and standalone Node.');
} else if (action === 'reference') {
  assert.ok(input && nodeDirectory, 'COMPONENT_ARGUMENTS');
  const archive = path.resolve(input);
  const reference = componentIndex(
    {
      version: 1,
      id,
      assets: [
        {
          ...asset,
          bytes: (await stat(archive)).size,
          sha256: (await hashAsset(archive, 'sha256')).digest,
        },
      ],
    },
    id,
  );
  await mkdir(path.dirname(path.resolve(nodeDirectory)), { recursive: true });
  await writeFile(path.resolve(nodeDirectory), JSON.stringify(reference, null, 2) + '\n');
} else throw Error('COMPONENT_ACTION');
