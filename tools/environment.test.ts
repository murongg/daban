import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { admitBuild, assertCleanImage, hashAsset, verifyAsset } from './environment.ts';

test('a runtime-image build exclusively owns a new root and cannot adopt an existing data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-environment-'));
  try {
    const fresh = join(root, 'new-image');
    const build = await admitBuild(fresh);
    assert.equal(build.versions.protocol, 32);
    assert.equal(build.output, fresh);
    assert.equal((await stat(fresh)).mode & 0o777, 0o700);
    assert.ok(build.limaHome.startsWith('/tmp/daban-image-'));
    await rm(build.limaHome, { recursive: true, force: true });
    const old = join(root, 'existing-user');
    await mkdir(old);
    await writeFile(join(old, 'runtime.json'), 'SYNTHETIC EXISTING DATA');
    await assert.rejects(admitBuild(old), { code: 'EEXIST' });
    assert.equal(await readFile(join(old, 'runtime.json'), 'utf8'), 'SYNTHETIC EXISTING DATA');
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
    assert.deepEqual(await hashAsset(file, 'sha256'), { bytes: bytes.length, digest });
    assert.equal(await verifyAsset(file, 'sha256', digest), bytes.length);
    await assert.rejects(verifyAsset(file, 'sha256', '0'.repeat(64)), /ASSET_INTEGRITY_FAILED/);
    const linked = join(root, 'linked');
    await symlink(file, linked);
    await assert.rejects(verifyAsset(linked, 'sha256', digest));
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
  assert.doesNotThrow(() => assertCleanImage(clean));
  for (const field of Object.keys(clean)) {
    assert.throws(() => assertCleanImage({ ...clean, [field]: 1 }), /IMAGE_NOT_CLEAN/);
    const incomplete: Record<string, unknown> = { ...clean };
    delete incomplete[field];
    assert.throws(() => assertCleanImage(incomplete), /IMAGE_NOT_CLEAN/);
  }
  assert.throws(() => assertCleanImage({ ...clean, authorizedKeyBytes: '0' }), /IMAGE_NOT_CLEAN/);
});
