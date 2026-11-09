import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const commit = 'a'.repeat(40);
interface Asset {
  id: number;
  name: string;
  size: number;
  digest: string;
  state: string;
}
async function api() {
  const value = await import('./publish.ts').catch(() => undefined);
  expect(value, 'CI publication must recover its own private draft').toBeDefined();
  if (!value) throw Error('PUBLISH_RECOVERY_REQUIRED');
  return value;
}
async function fixture(prerelease = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-client-publication-'));
  const directory = path.join(root, 'release');
  await mkdir(directory);
  const version = prerelease ? '1.2.3-beta.1' : '1.2.3',
    channel = prerelease ? 'beta' : 'latest';
  const names = [
    `Daban-${version}-macos-arm64.dmg`,
    `Daban-${version}-macos-arm64.zip`,
    `Daban-${version}-macos-arm64.zip.blockmap`,
    `Daban-${version}-windows-x64-setup.exe`,
    `Daban-${version}-windows-x64-setup.exe.blockmap`,
    `Daban-${version}-windows-x64.zip`,
    'CHANGELOG.en.md',
    'CHANGELOG.zh-CN.md',
    'SHA256SUMS.txt',
    `${channel}-mac.yml`,
    `${channel}.yml`,
  ];
  const assets: Asset[] = [];
  for (const [index, name] of names.entries()) {
    const data = Buffer.from('SYNTHETIC DISTRIBUTION ' + name);
    await writeFile(path.join(directory, name), data);
    assets.push({
      id: index + 1,
      name,
      size: data.length,
      digest: 'sha256:' + createHash('sha256').update(data).digest('hex'),
      state: 'uploaded',
    });
  }
  const notes = path.join(root, 'notes.md');
  await writeFile(notes, 'SYNTHETIC BILINGUAL RELEASE NOTES');
  return { root, directory, notes, version, tag: 'v' + version, assets };
}
function remote(hideDraft = false) {
  const value = { draft: true, assets: [] as Asset[] };
  let exists = false;
  let draftMisses = 0;
  let source = commit;
  const calls: string[][] = [];
  let fail = '';
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'api') {
      if (args[1] === '--method') {
        expect(value.draft).toBe(true);
        const id = Number(args.at(-1)!.split('/').at(-1));
        value.assets = value.assets.filter((a) => a.id !== id);
        return '';
      }
      if (args[1].includes('/commits/')) return JSON.stringify({ sha: source });
      if (args[1].includes('/releases?')) {
        if (!exists) return '';
        if (draftMisses > 0 && value.draft) {
          draftMisses -= 1;
          return '';
        }
        return JSON.stringify(value);
      }
      if (hideDraft && value.draft)
        throw Object.assign(new Error('SYNTHETIC_DRAFT_NOT_FOUND'), { stderr: 'HTTP 404' });
      if (!exists) throw Object.assign(new Error('SYNTHETIC_NOT_FOUND'), { stderr: 'HTTP 404' });
      return JSON.stringify(value);
    }
    if (args[1] === 'create') {
      exists = true;
      return '';
    }
    if (args[1] === 'upload') {
      const file = args.at(-1)!;
      const name = path.basename(file);
      if (fail === name) {
        fail = '';
        throw Error('SYNTHETIC_UPLOAD_FAILURE');
      }
      const data = await readFile(file);
      value.assets.push({
        id: 100 + calls.length,
        name,
        size: data.length,
        digest: 'sha256:' + createHash('sha256').update(data).digest('hex'),
        state: 'uploaded',
      });
      return '';
    }
    if (args[1] === 'edit') {
      expect(args).toContain('--draft=false');
      value.draft = false;
      return '';
    }
    throw Error('UNEXPECTED_PUBLISH_COMMAND');
  };
  return {
    value,
    calls,
    run,
    seed: () => {
      exists = true;
    },
    delayDraft: (reads: number) => {
      draftMisses = reads;
    },
    failNext: (name: string) => {
      fail = name;
    },
    moveTag: () => {
      source = 'c'.repeat(40);
    },
  };
}

test('CI resumes a partially uploaded draft and verifies every file before making it public', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote();
  server.failNext('Daban-1.2.3-macos-arm64.zip');
  await expect(pub.publishClient(f.tag, commit, f.directory, f.notes, server.run)).rejects.toThrow(
    'SYNTHETIC_UPLOAD_FAILURE',
  );
  expect(server.value.draft).toBe(true);
  const before = server.calls.filter((a) => a[1] === 'upload').map((a) => path.basename(a.at(-1)!));
  await pub.publishClient(f.tag, commit, f.directory, f.notes, server.run);
  expect(server.value.draft).toBe(false);
  expect(server.value.assets).toHaveLength(11);
  expect(server.calls.filter((a) => a[1] === 'create')).toHaveLength(1);
  for (const name of before.filter((n) => n !== 'Daban-1.2.3-macos-arm64.zip'))
    expect(
      server.calls.filter((a) => a[1] === 'upload' && path.basename(a.at(-1)!) === name),
    ).toHaveLength(1);
});

test('replaces a stale asset only while the release is a private draft', async (t) => {
  const pub = await api();
  const f = await fixture(true);
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote();
  server.seed();
  server.value.assets = f.assets.map((a) => ({ ...a }));
  server.value.assets[0].digest = 'sha256:' + '0'.repeat(64);
  await pub.publishClient(f.tag, commit, f.directory, f.notes, server.run);
  expect(server.calls.filter((a) => a[1] === '--method')).toHaveLength(1);
  expect(server.calls.filter((a) => a[1] === 'upload')).toHaveLength(1);
  expect(server.calls.find((a) => a[1] === 'edit')).toContain('--prerelease');
  expect(server.calls.find((a) => a[1] === 'edit')).toContain('--latest=false');
});

test('finds and resumes a draft when the tag endpoint returns 404', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote(true);
  server.seed();
  server.value.assets = f.assets.slice(0, 3);
  await pub.publishClient(f.tag, commit, f.directory, f.notes, server.run);
  expect(server.value.draft).toBe(false);
  expect(server.calls.filter((a) => a[1] === 'create')).toHaveLength(0);
  expect(server.calls.filter((a) => a[1] === 'upload')).toHaveLength(8);
  expect(server.calls.some((a) => a.includes('--paginate'))).toBe(true);
});

test('publishes when a newly created draft is missing from the first two lookups', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote(true);
  server.delayDraft(2);
  await pub.publishClient(f.tag, commit, f.directory, f.notes, server.run);
  expect(server.value.draft).toBe(false);
  expect(server.value.assets).toHaveLength(11);
  expect(server.calls.filter((a) => a[1] === 'create')).toHaveLength(1);
});

test('a tag moved during upload keeps the complete release private', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote();
  const run = async (args: string[]) => {
    const response = await server.run(args);
    if (args[1] === 'upload') server.moveTag();
    return response;
  };
  await expect(pub.publishClient(f.tag, commit, f.directory, f.notes, run)).rejects.toThrow(
    /PUBLISH_COMMIT/,
  );
  expect(server.value.assets).toHaveLength(11);
  expect(server.value.draft).toBe(true);
  expect(server.calls.some((a) => a[1] === 'edit')).toBe(false);
});

test('confirms the release is public after the publish request', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote();
  const run = async (args: string[]) => {
    const response = await server.run(args);
    if (args[1] === 'edit') server.value.draft = true;
    return response;
  };
  await expect(pub.publishClient(f.tag, commit, f.directory, f.notes, run)).rejects.toThrow(
    /PUBLISH_INTEGRITY/,
  );
});

test('published releases are immutable and matching completed publication is a no-op', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote();
  server.seed();
  server.value.draft = false;
  server.value.assets = f.assets.map((a) => ({ ...a }));
  await pub.publishClient(f.tag, commit, f.directory, f.notes, server.run);
  expect(server.calls.every((a) => a[0] === 'api' && a[1] !== '--method')).toBe(true);
  server.value.assets[0].digest = 'sha256:' + '0'.repeat(64);
  await expect(pub.publishClient(f.tag, commit, f.directory, f.notes, server.run)).rejects.toThrow(
    /PUBLISH_IMMUTABLE/,
  );
  expect(server.calls.every((a) => a[0] === 'api' && a[1] !== '--method')).toBe(true);
});

test('tag changes and unexpected local files fail before any publication mutation', async (t) => {
  const pub = await api();
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const server = remote();
  server.moveTag();
  await expect(pub.publishClient(f.tag, commit, f.directory, f.notes, server.run)).rejects.toThrow(
    /PUBLISH_COMMIT/,
  );
  expect(server.calls.some((a) => a[0] === 'release')).toBe(false);
  await writeFile(path.join(f.directory, 'private.keychain-db'), 'SYNTHETIC PRIVATE MATERIAL');
  await expect(pub.publishClient(f.tag, commit, f.directory, f.notes, server.run)).rejects.toThrow(
    /PUBLISH_FILES/,
  );
});
