import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentFilename, componentIndex, componentTag } from '@daban/engine/component';
import {
  componentPaths,
  extractComponent,
  verifyComponent,
} from '../apps/desktop/electron/component-install.ts';
import { fetchComponent, publishComponent } from './component-release.ts';
import { assembleComponent, componentSourceId } from './components.ts';
import { hashAsset } from './environment.ts';
import { sealHostPackage } from './roles.ts';
import { signComponent } from './sign.ts';

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
  await publishComponent(componentTag(id), process.env.EXPECTED_COMMIT, files);
} else if (action === 'build') {
  assert.ok(input && nodeDirectory, 'COMPONENT_ARGUMENTS');
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const result = await assembleComponent({
    output: path.resolve(input),
    nodeDirectory: path.resolve(nodeDirectory),
    environmentDirectory: environmentDirectory && path.resolve(environmentDirectory),
    platform,
    arch,
    version,
    id,
  });
  const archive = path.resolve(input, filename);
  if (process.platform === 'darwin') {
    if (process.env.MACOS_SIGNING_IDENTITY)
      await signComponent(result.directory, archive, {
        identity: process.env.MACOS_SIGNING_IDENTITY,
        keychain: process.env.MACOS_KEYCHAIN,
      });
    else throw Error('DEVELOPER_ID_REQUIRED');
  } else {
    // Materialize npm file: junctions before sealing: installed bytes must be independent of the build machine.
    const materialized = result.directory + '-materialized';
    await cp(result.directory, materialized, { recursive: true, dereference: true });
    await rm(result.directory, { recursive: true });
    await rename(materialized, result.directory);
    await sealHostPackage(result.agent);
    execFileSync('tar.exe', ['-a', '-cf', archive, '-C', path.resolve(input), 'DabanRuntime']);
  }
  console.log(archive);
} else if (action === 'validate') {
  assert.ok(input && nodeDirectory && environmentDirectory, 'COMPONENT_ARGUMENTS');
  const reference = componentIndex(JSON.parse(await readFile(environmentDirectory, 'utf8')), id);
  const expected = reference.assets.find(
    (item) => item.platform === platform && item.arch === arch,
  );
  assert.ok(expected, 'COMPONENT_PLATFORM');
  const archive = path.resolve(nodeDirectory);
  assert.equal((await stat(archive)).size, expected.bytes);
  assert.equal((await hashAsset(archive, 'sha256')).digest, expected.sha256);
  const stage = await mkdtemp(path.join(tmpdir(), 'daban-runtime-validation-'));
  try {
    await extractComponent(archive, stage, platform);
    await verifyComponent({
      directory: stage,
      id,
      platform,
      arch,
      archive,
      publisher: path.resolve(input),
    });
    assert.equal(
      execFileSync(componentPaths(stage, platform).executable, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      'v24.22.1',
    );
    console.log('Verified downloaded runtime integrity, publisher trust and standalone Node.');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
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
