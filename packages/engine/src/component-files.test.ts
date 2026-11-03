import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyComponentTree, verifyHostFiles } from './component-files.js';

test('verifies materialized host files against the trusted archive manifest, not the mutable cache manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node'));
  const main = 'SYNTHETIC MAIN',
    node = 'SYNTHETIC NODE';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = {
    node: '0.0.0-synthetic',
    dsh: '0.0.0-synthetic',
    files: { 'main.js': hash(main), 'node\\node.exe': hash(node) },
  };
  await writeFile(path.join(root, 'main.js'), main);
  await writeFile(path.join(root, 'node/node.exe'), node);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await verifyHostFiles(root, manifest);
  await writeFile(path.join(root, 'main.js'), 'SYNTHETIC TAMPERED MAIN');
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      files: { ...manifest.files, 'main.js': hash('SYNTHETIC TAMPERED MAIN') },
    }),
  );
  await assert.rejects(verifyHostFiles(root, manifest), /COMPONENT_INTEGRITY/);
  await writeFile(path.join(root, 'main.js'), main);
  await writeFile(path.join(root, 'unexpected.js'), 'SYNTHETIC EXTRA MODULE');
  await assert.rejects(verifyHostFiles(root, manifest), /COMPONENT_INTEGRITY/);
  await assert.rejects(
    verifyHostFiles(root, { ...manifest, files: { '../outside': 'a'.repeat(64) } }),
    /COMPONENT_INTEGRITY/,
  );
});

test('rejects a component symlink that escapes its private installation tree', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const component = path.join(root, 'component');
  await mkdir(component);
  await writeFile(path.join(root, 'unrelated.txt'), 'SYNTHETIC UNRELATED DATA');
  await symlink('../unrelated.txt', path.join(component, 'escape'));
  await assert.rejects(verifyComponentTree(component), /COMPONENT_UNSAFE/);
  assert.equal(
    await readFile(path.join(root, 'unrelated.txt'), 'utf8'),
    'SYNTHETIC UNRELATED DATA',
  );
});
