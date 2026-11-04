import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { qemuFilename, qemuTag, windowsEnvironment } from '@daban/engine/component';
import { expect, test } from 'vitest';
import { publishComponent, verifyPublishedComponent } from './component-release.ts';
import { hashAsset } from './environment.ts';

test('runtime publication never overwrites an existing asset and checks its digest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-runtime-release-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Daban-runtime-macos-arm64.zip');
  await writeFile(file, 'SYNTHETIC SIGNED ARCHIVE');
  const digest = (await hashAsset(file, 'sha256')).digest;
  const calls: string[][] = [];
  let remote = digest;
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({
      assets: [{ name: path.basename(file), digest: `sha256:${remote}`, size: 24 }],
    });
  };
  await publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run);
  expect(calls.length).toBe(1);
  remote = 'c'.repeat(64);
  await expect(
    publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run),
  ).rejects.toThrowError(/COMPONENT_RELEASE_CONFLICT/);
  expect(calls.some((args) => args.includes('upload'))).toBe(false);
});

test('checks uploaded runtime digests before allowing the desktop release to continue', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-runtime-publish-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Daban-runtime-windows-x64.zip');
  await writeFile(file, 'SYNTHETIC WINDOWS ARCHIVE');
  const digest = (await hashAsset(file, 'sha256')).digest;
  let created = false,
    inspections = 0;
  const run = async (args: string[]) => {
    if (args[0] === 'api') {
      if (args.includes('--jq')) return '';
      inspections++;
      if (!created) throw Object.assign(Error('not found'), { stderr: 'HTTP 404' });
      return JSON.stringify({
        assets: [
          {
            name: path.basename(file),
            size: Buffer.byteLength('SYNTHETIC WINDOWS ARCHIVE'),
            digest: `sha256:${digest}`,
          },
        ],
      });
    }
    expect(args.slice(0, 2)).toStrictEqual(['release', 'create']);
    expect.assert(args.includes('--latest=false'));
    created = true;
    return '';
  };
  await publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run);
  expect(inspections).toBe(2);
});

test('resumes an interrupted draft upload and verifies its bytes before publishing it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-qemu-draft-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, qemuFilename());
  await writeFile(file, 'SYNTHETIC ENVIRONMENT');
  const sha256 = (await hashAsset(file, 'sha256')).digest;
  const reference = { ...windowsEnvironment, bytes: 21, sha256 };
  let draft = true,
    uploaded = false;
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') {
      if (!args.includes('--jq') && draft)
        throw Object.assign(Error('not found'), { stderr: 'HTTP 404' });
      return JSON.stringify({
        draft,
        assets: uploaded ? [{ name: qemuFilename(), size: 21, digest: 'sha256:' + sha256 }] : [],
      });
    }
    if (args[1] === 'upload') uploaded = true;
    else if (args[1] === 'edit') {
      expect(uploaded).toBe(true);
      expect(args).toContain('--draft=false');
      draft = false;
    } else throw Error('DRAFT_MUST_NOT_BE_RECREATED');
    return '';
  };
  await expect(
    verifyPublishedComponent(qemuTag(reference), qemuFilename(), reference, run),
  ).rejects.toThrow('COMPONENT_RELEASE_INTEGRITY');
  await publishComponent(qemuTag(reference), 'b'.repeat(40), [file], run);
  expect(draft).toBe(false);
  await verifyPublishedComponent(qemuTag(reference), qemuFilename(), reference, run);
  expect(calls.some((args) => args[1] === 'create')).toBe(false);
});

test('publishes both optional Linux payloads with the host runtimes and refuses digest replacement', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-linux-publication-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const names = [
    'Daban-runtime-macos-arm64.zip',
    'Daban-runtime-windows-x64.zip',
    'Daban-lima-macos-arm64.tar.gz',
    'Daban-executor-linux-arm64.tar.gz',
    'linux.json',
  ];
  const files = names.map((name) => path.join(root, name));
  for (const file of files) await writeFile(file, 'SYNTHETIC RELEASE DATA');
  const assets = await Promise.all(
    files.map(async (file) => ({
      name: path.basename(file),
      size: 21,
      digest: 'sha256:' + (await hashAsset(file, 'sha256')).digest,
    })),
  );
  await expect(
    publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), files, async () =>
      JSON.stringify({ assets }),
    ),
  ).resolves.toBeUndefined();
  assets[2].digest = 'sha256:' + 'c'.repeat(64);
  await expect(
    publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), files, async () =>
      JSON.stringify({ assets }),
    ),
  ).rejects.toThrowError(/COMPONENT_RELEASE_CONFLICT/);
});

test('environment releases are immutable and cannot publish host archives under an environment tag', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-qemu-publication-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, qemuFilename());
  await writeFile(file, 'SYNTHETIC ENVIRONMENT');
  const digest = (await hashAsset(file, 'sha256')).digest;
  const tag = qemuTag(windowsEnvironment);
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({
      assets: [{ name: qemuFilename(), digest: 'sha256:' + digest, size: 21 }],
    });
  };
  await publishComponent(tag, 'b'.repeat(40), [file], run);
  expect(calls).toHaveLength(1);
  await expect(
    publishComponent(tag, 'b'.repeat(40), [path.join(root, 'Daban-runtime-windows-x64.zip')], run),
  ).rejects.toThrow('COMPONENT_RELEASE_ASSET');
  await expect(
    publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run),
  ).rejects.toThrow('COMPONENT_RELEASE_ASSET');
});

test('client publication requires an existing environment with exactly the sealed digest and length', async () => {
  const reference = { ...windowsEnvironment, bytes: 100, sha256: 'a'.repeat(64) };
  const run = async () =>
    JSON.stringify({
      assets: [
        { name: qemuFilename(), digest: 'sha256:' + reference.sha256, size: reference.bytes },
      ],
    });
  await expect(
    verifyPublishedComponent(qemuTag(reference), qemuFilename(), reference, run),
  ).resolves.toBeUndefined();
  await expect(
    verifyPublishedComponent(qemuTag(reference), qemuFilename(), { ...reference, bytes: 99 }, run),
  ).rejects.toThrow('COMPONENT_RELEASE_INTEGRITY');
  await expect(
    verifyPublishedComponent(
      qemuTag(reference),
      qemuFilename(),
      { ...reference, sha256: 'b'.repeat(64) },
      run,
    ),
  ).rejects.toThrow('COMPONENT_RELEASE_INTEGRITY');
});
