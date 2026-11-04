import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hashAsset } from './environment.ts';
import { releaseVersion } from './release.ts';

type Run = (args: string[]) => Promise<string>;
interface Asset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  state: string;
}
interface Release {
  draft: boolean;
  assets: Asset[];
}
const execute = promisify(execFile);
const gh: Run = async (args) =>
  (await execute('gh', args, { timeout: 60 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const repository = 'murongg/daban';
async function currentRelease(tag: string, run: Run): Promise<Release | undefined> {
  let response: string;
  try {
    response = await run(['api', `repos/${repository}/releases/tags/${tag}`]);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /HTTP 404/.test(error.stderr)
    )
      return;
    throw error;
  }
  const result = JSON.parse(response) as Release;
  assert.equal(typeof result?.draft, 'boolean', 'PUBLISH_RESPONSE');
  assert.ok(Array.isArray(result.assets), 'PUBLISH_RESPONSE');
  for (const asset of result.assets) {
    assert.ok(
      Number.isSafeInteger(asset.id) && asset.id > 0 && typeof asset.name === 'string',
      'PUBLISH_RESPONSE',
    );
    assert.ok(Number.isSafeInteger(asset.size) && asset.size >= 0, 'PUBLISH_RESPONSE');
    assert.ok(asset.digest === null || typeof asset.digest === 'string', 'PUBLISH_RESPONSE');
  }
  assert.equal(
    new Set(result.assets.map((a) => a.name)).size,
    result.assets.length,
    'PUBLISH_RESPONSE',
  );
  return result;
}
export async function publishClient(
  tag: string,
  commit: string,
  directory: string,
  notes: string,
  run: Run = gh,
) {
  const version = releaseVersion(tag, [tag.slice(1)]);
  assert.match(commit, /^[a-f0-9]{40}$/, 'PUBLISH_COMMIT');
  const names = await readdir(directory);
  const channels = names.filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9.-]*-mac\.yml$/.test(name));
  assert.equal(channels.length, 1, 'PUBLISH_FILES');
  const expected = [
    `Daban-${version}-macos-arm64.dmg`,
    `Daban-${version}-macos-arm64.zip`,
    `Daban-${version}-macos-arm64.zip.blockmap`,
    `Daban-${version}-windows-x64-setup.exe`,
    `Daban-${version}-windows-x64-setup.exe.blockmap`,
    `Daban-${version}-windows-x64.zip`,
    'CHANGELOG.en.md',
    'CHANGELOG.zh-CN.md',
    'SHA256SUMS.txt',
    channels[0],
    channels[0].replace(/-mac\.yml$/, '.yml'),
  ].sort();
  assert.deepEqual(names.sort(), expected, 'PUBLISH_FILES');
  const files: { name: string; file: string; size: number; digest: string }[] = [];
  for (const name of expected) {
    const file = path.join(directory, name),
      info = await lstat(file);
    assert.ok(
      info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0,
      'PUBLISH_FILES',
    );
    const hash = await hashAsset(file, 'sha256');
    files.push({ name, file, size: hash.bytes, digest: `sha256:${hash.digest}` });
  }
  const checkTag = async () => {
    const current = JSON.parse(await run(['api', `repos/${repository}/commits/${tag}`])) as {
      sha: unknown;
    };
    assert.equal(current.sha, commit, 'PUBLISH_COMMIT');
  };
  await checkTag();
  let release = await currentRelease(tag, run);
  if (!release) {
    await run([
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--draft',
      '--title',
      `Daban ${tag}`,
      '--notes-file',
      notes,
    ]);
    release = await currentRelease(tag, run);
  }
  assert.ok(release, 'PUBLISH_RESPONSE');
  const matches = (asset: Asset | undefined, file: (typeof files)[number]) =>
    asset?.state === 'uploaded' && asset.digest === file.digest && asset.size === file.size;
  if (!release.draft) {
    assert.deepEqual(release.assets.map((a) => a.name).sort(), expected, 'PUBLISH_IMMUTABLE');
    for (const file of files)
      assert.ok(
        matches(
          release.assets.find((a) => a.name === file.name),
          file,
        ),
        'PUBLISH_IMMUTABLE',
      );
    return;
  }
  assert.ok(
    release.assets.every((a) => expected.includes(a.name)),
    'PUBLISH_FILES',
  );
  for (const file of files) {
    const saved = release.assets.find((a) => a.name === file.name);
    if (matches(saved, file)) continue;
    // Replacement is restricted to a private draft; published version bytes are immutable.
    if (saved)
      await run(['api', '--method', 'DELETE', `repos/${repository}/releases/assets/${saved.id}`]);
    await run(['release', 'upload', tag, '--repo', repository, file.file]);
  }
  release = await currentRelease(tag, run);
  assert.ok(release?.draft, 'PUBLISH_STATE_CHANGED');
  assert.deepEqual(release.assets.map((a) => a.name).sort(), expected, 'PUBLISH_INTEGRITY');
  for (const file of files)
    assert.ok(
      matches(
        release.assets.find((a) => a.name === file.name),
        file,
      ),
      'PUBLISH_INTEGRITY',
    );
  await checkTag();
  await run([
    'release',
    'edit',
    tag,
    '--repo',
    repository,
    '--title',
    `Daban ${tag}`,
    '--notes-file',
    notes,
    '--draft=false',
    ...(version.includes('-') ? ['--prerelease', '--latest=false'] : ['--latest']),
  ]);
}
async function main() {
  const [directory, notes] = process.argv.slice(2),
    tag = process.env.RELEASE_TAG,
    commit = process.env.EXPECTED_COMMIT;
  assert.ok(directory && notes && tag && commit, 'PUBLISH_ARGUMENTS');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const versions = await Promise.all(
    ['.', 'apps/desktop', 'apps/agent', 'apps/runtime', 'packages/engine', 'packages/protocol'].map(
      async (location) =>
        JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'))
          .version as string,
    ),
  );
  releaseVersion(tag, versions);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    commit,
    'PUBLISH_COMMIT',
  );
  await publishClient(tag, commit, directory, notes);
  console.log(`Published verified release ${tag}.`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main();
