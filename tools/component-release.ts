import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { qemuFilename } from '@daban/engine/component';
import { hashAsset } from './environment.ts';

type Run = (args: string[]) => Promise<string>;
const execute = promisify(execFile);
// The independently published Windows environment is about 1.6 GiB; ordinary uplinks can take over 20 minutes.
const gh: Run = async (args) =>
  (await execute('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60 * 60 * 1000 }))
    .stdout;
interface Release {
  draft: boolean;
  assets: { name: string; digest: string; size: number }[];
}
const releaseAsset =
  /^(?:Daban-runtime-(?:macos-arm64|windows-x64)\.zip|Daban-lima-macos-arm64\.tar\.gz|Daban-executor-linux-arm64\.tar\.gz|linux\.json)$/;
const allowedAsset = (tag: string, name: string) =>
  tag.startsWith('qemu-') ? name === qemuFilename() : releaseAsset.test(name);
async function release(tag: string, run: Run): Promise<Release | undefined> {
  if (!/^(?:runtime|qemu)-[a-f0-9]{24}$/.test(tag)) throw Error('COMPONENT_RELEASE_TAG');
  let text: string;
  try {
    text = await run(['api', `repos/murongg/daban/releases/tags/${tag}`]);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /HTTP 404/.test(error.stderr)
    )
      text = await run([
        'api',
        'repos/murongg/daban/releases?per_page=100',
        '--jq',
        `.[] | select(.draft == true and .tag_name == "${tag}")`,
      ]);
    else throw error;
    if (!text.trim()) return undefined;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('assets' in value) || !Array.isArray(value.assets))
    throw Error('COMPONENT_RELEASE_RESPONSE');
  const assets: Release['assets'] = [];
  for (const asset of value.assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      !('name' in asset) ||
      typeof asset.name !== 'string' ||
      !('digest' in asset) ||
      typeof asset.digest !== 'string' ||
      !('size' in asset) ||
      typeof asset.size !== 'number'
    )
      throw Error('COMPONENT_RELEASE_RESPONSE');
    assets.push({ name: asset.name, digest: asset.digest, size: asset.size });
  }
  return { draft: 'draft' in value && value.draft === true, assets };
}
export async function fetchComponent(
  tag: string,
  filename: string,
  directory: string,
  run: Run = gh,
) {
  if (!allowedAsset(tag, filename)) throw Error('COMPONENT_RELEASE_ASSET');
  const current = await release(tag, run);
  const found = current?.draft
    ? undefined
    : current?.assets.find((asset) => asset.name === filename);
  if (!found) return false;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(found.digest) ||
    !Number.isSafeInteger(found.size) ||
    found.size < 1 ||
    found.size > 2 * 1024 ** 3
  )
    throw Error('COMPONENT_RELEASE_RESPONSE');
  await mkdir(directory, { recursive: true });
  await run([
    'release',
    'download',
    tag,
    '--repo',
    'murongg/daban',
    '--dir',
    directory,
    '--pattern',
    filename,
  ]);
  const file = path.join(directory, filename);
  if (
    (await stat(file)).size !== found.size ||
    'sha256:' + (await hashAsset(file, 'sha256')).digest !== found.digest
  )
    throw Error('COMPONENT_RELEASE_INTEGRITY');
  return true;
}
export async function publishComponent(
  tag: string,
  commit: string,
  files: string[],
  run: Run = gh,
) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !files.length ||
    files.length > 5 ||
    new Set(files.map((file) => path.basename(file))).size !== files.length
  )
    throw Error('COMPONENT_RELEASE_COMMIT');
  const current = await release(tag, run);
  const additions: string[] = [];
  for (const file of files) {
    if (!allowedAsset(tag, path.basename(file))) throw Error('COMPONENT_RELEASE_ASSET');
    const saved = current?.assets.find((asset) => asset.name === path.basename(file));
    if (saved) {
      // Public runtime assets are immutable, including retries of a desktop release.
      if (saved.digest !== 'sha256:' + (await hashAsset(file, 'sha256')).digest)
        throw Error('COMPONENT_RELEASE_CONFLICT');
    } else additions.push(file);
  }
  if (!current)
    await run([
      'release',
      'create',
      tag,
      '--repo',
      'murongg/daban',
      '--target',
      commit,
      '--title',
      tag.startsWith('qemu-')
        ? `Daban Linux for Windows ${tag.slice(5)}`
        : `Daban runtime ${tag.slice(8)}`,
      '--notes',
      'Runtime components downloaded by Daban when needed. / Daban 按需下载的运行组件。',
      '--prerelease',
      '--latest=false',
      ...additions,
    ]);
  else if (additions.length)
    await run(['release', 'upload', tag, '--repo', 'murongg/daban', ...additions]);
  if (additions.length || current?.draft) {
    const published = await release(tag, run);
    for (const file of files) {
      const asset = published?.assets.find((item) => item.name === path.basename(file));
      if (
        !asset ||
        asset.digest !== 'sha256:' + (await hashAsset(file, 'sha256')).digest ||
        asset.size !== (await stat(file)).size
      )
        throw Error('COMPONENT_RELEASE_INTEGRITY');
    }
  }
  // gh creates a draft while uploading. Retry that same draft and publish only after every pinned asset verifies.
  if (current?.draft) {
    await run([
      'release',
      'edit',
      tag,
      '--repo',
      'murongg/daban',
      '--draft=false',
      '--prerelease',
      '--latest=false',
    ]);
    const published = await release(tag, run);
    if (!published || published.draft) throw Error('COMPONENT_RELEASE_INTEGRITY');
  }
}

export async function verifyPublishedComponent(
  tag: string,
  filename: string,
  expected: { bytes: number; sha256: string },
  run: Run = gh,
) {
  if (!allowedAsset(tag, filename)) throw Error('COMPONENT_RELEASE_ASSET');
  const current = await release(tag, run);
  const asset = current?.draft ? undefined : current?.assets.find((item) => item.name === filename);
  if (!asset || asset.size !== expected.bytes || asset.digest !== 'sha256:' + expected.sha256)
    throw Error('COMPONENT_RELEASE_INTEGRITY');
}
