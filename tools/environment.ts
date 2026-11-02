import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export const environmentVersions = {
  lima: '2.2.1',
  node: '24.22.1',
  dsh: '0.2.1-rc.3',
  // The host test binds this to managedProtocol; this helper must also load in the bare guest.
  protocol: 42,
};
export const environmentAssets = {
  lima: {
    url: 'https://github.com/lima-vm/lima/releases/download/v2.2.1/lima-2.2.1-Darwin-arm64.tar.gz',
    algorithm: 'sha256' as const,
    digest: '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e',
  },
  node: {
    url: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.xz',
    algorithm: 'sha256' as const,
    digest: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
  },
  debian: {
    url: 'https://cloud.debian.org/images/cloud/trixie/20261001-2618/debian-13-genericcloud-arm64-20261001-2618.qcow2',
    algorithm: 'sha512' as const,
    digest:
      'd8470b8c6c38fead046c794b5800a5a7b96672d5bcf543cc230ceb0c4b8ace05ed341a0c8928045422243fde26b2f1f2f58e99244c65709ffda2e3d4b674dd5a',
  },
};
export async function admitBuild(directory: string) {
  const output = resolve(directory);
  // Never adopt an existing profile, Lima home or disk as an image-building workspace.
  await mkdir(output, { mode: 0o700 });
  const limaHome = await mkdtemp('/tmp/daban-image-');
  const build = { output, limaHome, id: randomUUID(), versions: environmentVersions };
  await writeFile(`${output}/build.json`, JSON.stringify(build, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return build;
}
export async function verifyAsset(file: string, algorithm: 'sha256' | 'sha512', expected: string) {
  const result = await hashAsset(file, algorithm);
  if (result.digest !== expected) throw new Error('ASSET_INTEGRITY_FAILED');
  return result.bytes;
}
export async function hashAsset(file: string, algorithm: 'sha256' | 'sha512') {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('ASSET_NOT_REGULAR');
    const hash = createHash(algorithm);
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('ASSET_INTEGRITY_FAILED');
    return { bytes: before.size, digest: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}
export async function publishImage(directory: string, report: unknown, limaArchive: string) {
  assertCleanImage(report);
  const output = resolve(directory);
  const build = JSON.parse(await readFile(join(output, 'build.json'), 'utf8')) as {
    output: string;
    limaHome: string;
    id: string;
    versions: typeof environmentVersions;
  };
  assert.equal(build.output, output);
  // A sanitized previous producer is still not the current release's payload.
  assert.deepEqual(build.versions, environmentVersions, 'IMAGE_BUILD_VERSION');
  assert.match(build.limaHome, /^\/tmp\/daban-image-[a-zA-Z0-9]+$/);
  const binary = join(output, 'tools/bin/limactl');
  const state = JSON.parse(
    execFileSync(binary, ['list', '--json', 'seed'], {
      env: { ...process.env, LIMA_HOME: build.limaHome },
      encoding: 'utf8',
    }),
  );
  assert.equal(state.name, 'seed');
  assert.equal(state.status, 'Stopped');
  assert.equal(await realpath(state.dir), await realpath(join(build.limaHome, 'seed')));
  assert.equal(state.config.images[0].digest, `sha512:${environmentAssets.debian.digest}`);
  // Lima omits empty slices from its JSON status; a present non-empty mount list is still rejected.
  assert.ok(
    state.config.mounts === undefined ||
      (Array.isArray(state.config.mounts) && state.config.mounts.length === 0),
  );
  assert.deepEqual(JSON.parse(await readFile(join(output, 'seed.yaml'), 'utf8')).mounts, []);
  const limaBytes = await verifyAsset(limaArchive, 'sha256', environmentAssets.lima.digest);
  const staging = join(output, 'pack-building');
  await mkdir(staging, { mode: 0o700 });
  const source = await open(
    join(build.limaHome, 'seed/disk'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let rawBytes: number;
  let rawSha256: string;
  try {
    const before = await source.stat();
    assert.ok(before.isFile() && before.nlink === 1);
    assert.equal(before.size, 16 * 1024 ** 3);
    rawBytes = before.size;
    const rawHash = createHash('sha256');
    await pipeline(
      source.createReadStream({ autoClose: false }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          rawHash.update(chunk);
          yield chunk;
        }
      },
      createGzip({ level: 6 }),
      createWriteStream(join(staging, 'system.raw.gz'), { flags: 'wx', mode: 0o600 }),
    );
    rawSha256 = rawHash.digest('hex');
    const after = await source.stat();
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally {
    await source.close();
  }
  const compressed = await hashAsset(join(staging, 'system.raw.gz'), 'sha256');
  await copyFile(limaArchive, join(staging, 'lima.tar.gz'), constants.COPYFILE_EXCL);
  const manifest = {
    version: 1,
    id: `daban-${environmentVersions.protocol}-${compressed.digest.slice(0, 16)}`,
    platform: 'darwin',
    arch: 'arm64',
    versions: environmentVersions,
    cpus: 2,
    memoryGiB: 3,
    diskGiB: 16,
    user: { name: 'daban', uid: 2000 },
    image: {
      file: 'system.raw.gz',
      bytes: compressed.bytes,
      rawBytes,
      rawSha256,
      sha256: compressed.digest,
    },
    lima: { file: 'lima.tar.gz', bytes: limaBytes, sha256: environmentAssets.lima.digest },
  };
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(
    join(staging, 'COMPONENTS.md'),
    '# daban environment components\n\nLima 2.2.1: https://github.com/lima-vm/lima/releases/tag/v2.2.1 (notices inside lima.tar.gz).\nNode.js24.22.1: https://nodejs.org/ (LICENSE inside /opt/bot-prototype/node).\nDeepSeek Harness0.2.1-rc.3: https://github.com/deepseek-ai/deepseek-harness (MIT notices retained in installed packages).\nDebian13package copyright/license files remain under /usr/share/doc. Chromium and npm dependencies retain their installed notices.\n\nThis local development payload is not a signed/notarized public release.\n',
  );
  for (const file of ['system.raw.gz', 'lima.tar.gz', 'manifest.json', 'COMPONENTS.md'])
    await chmod(join(staging, file), 0o644);
  await chmod(staging, 0o755);
  await rename(staging, join(output, 'pack'));
  return manifest;
}
export function assertCleanImage(value: unknown) {
  const fields = [
    'runtimeEntries',
    'providerCredentials',
    'authorizedKeyBytes',
    'sshHostKeys',
    'homePrivateKeys',
    'machineIdBytes',
    'cloudInitEntries',
    'randomSeedBytes',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    fields.some((field) => Reflect.get(value, field) !== 0)
  )
    throw new Error('IMAGE_NOT_CLEAN');
}
export function seedTemplate() {
  return {
    minimumLimaVersion: environmentVersions.lima,
    vmType: 'vz',
    arch: 'aarch64',
    cpus: 2,
    memory: '3GiB',
    disk: '16GiB',
    images: [
      {
        location: environmentAssets.debian.url,
        arch: 'aarch64',
        digest: `sha512:${environmentAssets.debian.digest}`,
      },
    ],
    user: { name: 'daban', uid: 2000, home: '/home/daban', shell: '/bin/bash' },
    mounts: [],
    containerd: { system: false, user: false },
    portForwards: [{ guestPort: 0, ignore: true }],
    hostResolver: { enabled: true },
    upgradePackages: false,
  };
}
