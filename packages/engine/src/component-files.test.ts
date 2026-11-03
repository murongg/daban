import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { verifyComponentTree, verifyHostFiles } from './component-files.js';

test('verifies materialized host files against the trusted archive manifest, not the mutable cache manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-files-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  // Fixtures must remain private even when the shell permits group-writable files.
  await mkdir(path.join(root, 'node'), { mode: 0o700 });
  const main = 'SYNTHETIC MAIN',
    node = 'SYNTHETIC NODE';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = {
    node: '0.0.0-synthetic',
    dsh: '0.0.0-synthetic',
    files: { 'main.js': hash(main), 'node\\node.exe': hash(node) },
  };
  await writeFile(path.join(root, 'main.js'), main, { mode: 0o600 });
  await writeFile(path.join(root, 'node/node.exe'), node, { mode: 0o600 });
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await verifyHostFiles(root, manifest);
  await writeFile(path.join(root, 'main.js'), 'SYNTHETIC TAMPERED MAIN');
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      files: { ...manifest.files, 'main.js': hash('SYNTHETIC TAMPERED MAIN') },
    }),
  );
  await expect(verifyHostFiles(root, manifest)).rejects.toThrowError(/COMPONENT_INTEGRITY/);
  await writeFile(path.join(root, 'main.js'), main);
  await writeFile(path.join(root, 'unexpected.js'), 'SYNTHETIC EXTRA MODULE', { mode: 0o600 });
  await expect(verifyHostFiles(root, manifest)).rejects.toThrowError(/COMPONENT_INTEGRITY/);
  await expect(
    verifyHostFiles(root, { ...manifest, files: { '../outside': 'a'.repeat(64) } }),
  ).rejects.toThrowError(/COMPONENT_INTEGRITY/);
});

test('rejects a component symlink that escapes its private installation tree', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-link-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const component = path.join(root, 'component');
  await mkdir(component);
  await writeFile(path.join(root, 'unrelated.txt'), 'SYNTHETIC UNRELATED DATA');
  await symlink('../unrelated.txt', path.join(component, 'escape'));
  await expect(verifyComponentTree(component)).rejects.toThrowError(/COMPONENT_UNSAFE/);
  expect(await readFile(path.join(root, 'unrelated.txt'), 'utf8')).toBe('SYNTHETIC UNRELATED DATA');
});
