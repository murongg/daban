import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedProtocol } from '@daban/protocol';
import { expect, test } from 'vitest';
import {
  admitBuild,
  assertCleanImage,
  environmentVersions,
  hashAsset,
  publishImage,
  verifyAsset,
} from './environment.ts';

test.skipIf(process.platform === 'win32')(
  'a runtime-image build exclusively owns a new root and cannot adopt an existing data directory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mock-environment-'));
    try {
      const fresh = join(root, 'new-image');
      const build = await admitBuild(fresh);
      expect(build.versions.protocol).toBe(managedProtocol);
      expect(build.output).toBe(fresh);
      expect((await stat(fresh)).mode & 0o777).toBe(0o700);
      expect.assert(build.limaHome.startsWith('/tmp/daban-image-'));
      await rm(build.limaHome, { recursive: true, force: true });
      const old = join(root, 'existing-user');
      await mkdir(old);
      await writeFile(join(old, 'runtime.json'), 'SYNTHETIC EXISTING DATA');
      await expect(admitBuild(old)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(join(old, 'runtime.json'), 'utf8')).toBe('SYNTHETIC EXISTING DATA');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('the guest build helper loads outside the repository without workspace packages or VM effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-standalone-image-helper-'));
  try {
    const file = join(root, 'environment.ts');
    await copyFile(new URL('./environment.ts', import.meta.url), file);
    const code = `const {assertCleanImage}=await import(${JSON.stringify(pathToFileURL(file).href)});assertCleanImage({runtimeEntries:0,providerCredentials:0,authorizedKeyBytes:0,sshHostKeys:0,homePrivateKeys:0,machineIdBytes:0,cloudInitEntries:0,randomSeedBytes:0});`;
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', code],
      { cwd: root, timeout: 5000, stdio: 'pipe' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a previous-version builder cannot be published under the current runtime version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-stale-image-builder-'));
  try {
    await writeFile(
      join(root, 'build.json'),
      JSON.stringify({
        output: root,
        limaHome: '/tmp/daban-image-mock',
        id: 'mock-build',
        versions: { ...environmentVersions, protocol: environmentVersions.protocol - 1 },
      }),
    );
    const clean = {
      runtimeEntries: 0,
      providerCredentials: 0,
      authorizedKeyBytes: 0,
      sshHostKeys: 0,
      homePrivateKeys: 0,
      machineIdBytes: 0,
      cloudInitEntries: 0,
      randomSeedBytes: 0,
    };
    await expect(publishImage(root, clean, join(root, 'mock-lima.tar.gz'))).rejects.toThrowError(
      /IMAGE_BUILD_VERSION/,
    );
    expect(await readdir(root)).toStrictEqual(['build.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('vendor assets need matching hashes and regular unlinked files before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-runtime-asset-'));
  try {
    const file = join(root, 'tool.tar.gz');
    const bytes = Buffer.from('SYNTHETIC PUBLIC ASSET');
    await writeFile(file, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(await hashAsset(file, 'sha256')).toStrictEqual({ bytes: bytes.length, digest });
    expect(await verifyAsset(file, 'sha256', digest)).toBe(bytes.length);
    await expect(verifyAsset(file, 'sha256', '0'.repeat(64))).rejects.toThrowError(
      /ASSET_INTEGRITY_FAILED/,
    );
    const linked = join(root, 'linked');
    await symlink(file, linked);
    await expect(verifyAsset(linked, 'sha256', digest)).rejects.toThrowError();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a generic image cannot be released with builder access, machine identity, credentials or runtime data', () => {
  const clean = {
    runtimeEntries: 0,
    providerCredentials: 0,
    authorizedKeyBytes: 0,
    sshHostKeys: 0,
    homePrivateKeys: 0,
    machineIdBytes: 0,
    cloudInitEntries: 0,
    randomSeedBytes: 0,
  };
  expect(() => assertCleanImage(clean)).not.toThrowError();
  for (const field of Object.keys(clean)) {
    expect(() => assertCleanImage({ ...clean, [field]: 1 })).toThrowError(/IMAGE_NOT_CLEAN/);
    const incomplete: Record<string, unknown> = { ...clean };
    delete incomplete[field];
    expect(() => assertCleanImage(incomplete)).toThrowError(/IMAGE_NOT_CLEAN/);
  }
  expect(() => assertCleanImage({ ...clean, authorizedKeyBytes: '0' })).toThrowError(
    /IMAGE_NOT_CLEAN/,
  );
});
