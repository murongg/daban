import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceFiles } from './workspace.js';

test('a new workspace reader rejects a planted root link rather than adopting private service data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workspace-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'private/secret'), 'SYNTHETIC-PRIVATE-47');
  await symlink(path.join(root, 'private'), path.join(root, 'shared'));
  await assert.rejects(new WorkspaceFiles(path.join(root, 'shared')).base());
});
test('task preparation refuses planted ancestors and exclusive writes retain existing input bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workspace-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared'),
    privateRoot = path.join(root, 'private');
  await mkdir(shared);
  await mkdir(privateRoot);
  const workspace = new WorkspaceFiles(shared);
  await symlink(privateRoot, path.join(shared, 'model-runs'));
  const create = (parts: string[]) => workspace.create(parts);
  await assert.rejects(create(['model-runs', 'mock-run', 'a']));
  await assert.rejects(access(path.join(privateRoot, 'mock-run')));
  await rm(path.join(shared, 'model-runs'));
  const directory = await create(['model-runs', 'mock-run', 'a']);
  try {
    await directory.write('input.txt', 'SYNTHETIC-INPUT-53');
    await assert.rejects(directory.write('input.txt', 'SYNTHETIC-REPLACE'));
    assert.equal(
      await readFile(path.join(directory.path, 'input.txt'), 'utf8'),
      'SYNTHETIC-INPUT-53',
    );
    await rename(directory.path, path.join(shared, 'moved'));
    await symlink(privateRoot, directory.path);
    await assert.rejects(directory.verify(), { code: 'TASK_DIRECTORY_MOVED' });
    await assert.rejects(directory.write('new.txt', 'SYNTHETIC-ATTACK'), {
      code: 'TASK_DIRECTORY_MOVED',
    });
    await assert.rejects(access(path.join(privateRoot, 'new.txt')));
  } finally {
    await directory.close();
  }
});
