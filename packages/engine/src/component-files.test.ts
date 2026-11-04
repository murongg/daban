import { createHash } from 'node:crypto';
import fs, { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { verifyComponentTree, verifyHostFiles } from './component-files.js';
import { secureDirectory } from './private-files.js';

async function payload() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-host-files-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  await mkdir(path.join(root, 'node'), { mode: 0o700 });
  const files: Record<string, string> = {};
  for (const name of [
    'main.js',
    'node/node.exe',
    ...Array.from({ length: 6 }, (_, i) => `${i}.js`),
  ]) {
    const bytes = `SYNTHETIC ${name}`;
    await writeFile(path.join(root, name), bytes, { mode: 0o600 });
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  return { root, temporary, manifest: { node: '0.0.0-synthetic', dsh: '0.0.0-synthetic', files } };
}

test('verifies independent host files concurrently with at most four open handles', async () => {
  const { root, temporary, manifest } = await payload();
  const original = fs.open;
  const active = new Set<Awaited<ReturnType<typeof fs.open>>>();
  let peak = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    active.add(handle);
    peak = Math.max(peak, active.size);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      try {
        await close();
      } finally {
        active.delete(handle);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await verifyHostFiles(root, manifest);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(active.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('waits for in-flight file handles to close before reporting an integrity failure', async () => {
  const { root, temporary, manifest } = await payload();
  manifest.files['main.js'] = '0'.repeat(64);
  const original = fs.open;
  const active = new Set<Awaited<ReturnType<typeof fs.open>>>();
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    active.add(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        await close();
      } finally {
        active.delete(handle);
      }
    });
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await expect(verifyHostFiles(root, manifest)).rejects.toThrowError(/COMPONENT_INTEGRITY/);
    expect(active.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('preserves hard-link rejection and cancellation during host verification', async (t) => {
  const { root, temporary, manifest } = await payload();
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const cancellation = new AbortController();
  cancellation.abort(Error('synthetic cancellation'));
  await expect(verifyHostFiles(root, manifest, cancellation.signal)).rejects.toThrowError(
    /synthetic cancellation/,
  );
  await link(path.join(root, 'main.js'), path.join(root, 'alias.js'));
  await expect(verifyHostFiles(root, manifest)).rejects.toThrowError(/COMPONENT_UNSAFE/);
});

test('verifies materialized host files against the trusted archive manifest, not the mutable cache manifest', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-component-files-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private'));
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
