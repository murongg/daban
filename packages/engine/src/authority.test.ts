import fs, { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Authority, ViewerGrants } from './authority.js';
import { privateMetadata, secureDirectory } from './private-files.js';

test('a token replaced by a link between validation and open cannot truncate another private file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-authority-race-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await secureDirectory(root);
  const token = path.join(root, 'model/control-token');
  const other = path.join(root, 'synthetic-private');
  await new Authority(token).publish();
  await writeFile(other, 'SYNTHETIC-KEEP-53', { mode: 0o600 });
  const original = fs.open;
  let replaced = false;
  vi.spyOn(fs, 'open').mockImplementation(async (named, flags, mode) => {
    if (named === token && !replaced) {
      replaced = true;
      await rm(token);
      await symlink(other, token);
    }
    return original(named, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    await expect(new Authority(token).publish()).rejects.toThrowError();
    expect(replaced).toBe(true);
    expect(await readFile(other, 'utf8')).toBe('SYNTHETIC-KEEP-53');
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
});

test('control capability publication refuses public files, links and foreign ownership safeguards', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-authority-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await secureDirectory(root);
  const file = path.join(root, 'model/control-token');
  const authority = new Authority(file);
  await authority.publish();
  expect(authority.token).toMatch(/^[a-f0-9]{64}$/);
  expect(await privateMetadata(file, await stat(file), 0o600)).toBe(true);
  expect(await privateMetadata(path.dirname(file), await stat(path.dirname(file)), 0o700)).toBe(
    true,
  );
  expect((await readFile(file, 'utf8')).trim()).toBe(authority.token);
  const second = new Authority(file);
  await second.publish();
  expect(second.token).not.toBe(authority.token);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await expect(new Authority(file).publish()).rejects.toMatchObject({
      code: 'CONTROL_AUTH_UNSAFE',
    });
  }
  await rm(file);
  const other = path.join(root, 'synthetic-private');
  await writeFile(other, 'SYNTHETIC-KEEP-47', { mode: 0o600 });
  await symlink(other, file);
  await expect(new Authority(file).publish()).rejects.toThrowError();
  expect(await readFile(other, 'utf8')).toBe('SYNTHETIC-KEEP-47');
  await rm(file);
  await link(other, file);
  await expect(new Authority(file).publish()).rejects.toMatchObject({
    code: 'CONTROL_AUTH_UNSAFE',
  });
  expect(await readFile(other, 'utf8')).toBe('SYNTHETIC-KEEP-47');
});
test('viewer grants are scoped to one Bot and screen instance and retire before slot reuse', () => {
  const grants = new ViewerGrants();
  const a = grants.issue('mock-a', 'mock-screen-a');
  const b = grants.issue('mock-b', 'mock-screen-b');
  expect(grants.instance(a, 'mock-a')).toBe('mock-screen-a');
  expect(grants.instance(a, 'mock-b')).toBe(undefined);
  expect(grants.instance('SYNTHETIC-UNKNOWN', 'mock-a')).toBe(undefined);
  grants.retire('mock-a', 'mock-screen-a');
  const replacement = grants.issue('mock-a', 'mock-screen-new');
  expect(grants.instance(a, 'mock-a')).toBe(undefined);
  expect(replacement).not.toBe(a);
  expect(grants.instance(b, 'mock-b')).toBe('mock-screen-b');
});
