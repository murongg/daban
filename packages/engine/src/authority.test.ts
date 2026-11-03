import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Authority, ViewerGrants } from './authority.js';

test('control capability publication refuses public files, links and foreign ownership safeguards', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-authority-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'model/control-token');
  const authority = new Authority(file);
  await authority.publish();
  expect(authority.token).toMatch(/^[a-f0-9]{64}$/);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  expect((await readFile(file, 'utf8')).trim()).toBe(authority.token);
  const second = new Authority(file);
  await second.publish();
  expect(second.token).not.toBe(authority.token);
  await chmod(file, 0o644);
  await expect(new Authority(file).publish()).rejects.toMatchObject({
    code: 'CONTROL_AUTH_UNSAFE',
  });
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
