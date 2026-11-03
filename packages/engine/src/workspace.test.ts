import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { WorkspaceFiles } from './workspace.js';

test('a new workspace reader rejects a planted root link rather than adopting private service data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workspace-link-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'private/secret'), 'SYNTHETIC-PRIVATE-47');
  await symlink(path.join(root, 'private'), path.join(root, 'shared'));
  await expect(new WorkspaceFiles(path.join(root, 'shared')).base()).rejects.toThrowError();
});
test('task preparation refuses planted ancestors and exclusive writes retain existing input bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workspace-create-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared'),
    privateRoot = path.join(root, 'private');
  await mkdir(shared);
  await mkdir(privateRoot);
  const workspace = new WorkspaceFiles(shared);
  await symlink(privateRoot, path.join(shared, 'model-runs'));
  const create = (parts: string[]) => workspace.create(parts);
  await expect(create(['model-runs', 'mock-run', 'a'])).rejects.toThrowError();
  await expect(access(path.join(privateRoot, 'mock-run'))).rejects.toThrowError();
  await rm(path.join(shared, 'model-runs'));
  const directory = await create(['model-runs', 'mock-run', 'a']);
  try {
    await directory.write('input.txt', 'SYNTHETIC-INPUT-53');
    await expect(directory.write('input.txt', 'SYNTHETIC-REPLACE')).rejects.toThrowError();
    expect(await readFile(path.join(directory.path, 'input.txt'), 'utf8')).toBe(
      'SYNTHETIC-INPUT-53',
    );
    await rename(directory.path, path.join(shared, 'moved'));
    await symlink(privateRoot, directory.path);
    await expect(directory.verify()).rejects.toMatchObject({ code: 'TASK_DIRECTORY_MOVED' });
    await expect(directory.write('new.txt', 'SYNTHETIC-ATTACK')).rejects.toMatchObject({
      code: 'TASK_DIRECTORY_MOVED',
    });
    await expect(access(path.join(privateRoot, 'new.txt'))).rejects.toThrowError();
  } finally {
    await directory.close();
  }
});
