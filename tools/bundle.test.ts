import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bundle-links-'));
  const bundle = path.join(root, 'Mock.app');
  const framework = path.join(bundle, 'Contents/Frameworks/Mock.framework');
  await mkdir(path.join(framework, 'Versions/A'), { recursive: true });
  await writeFile(path.join(framework, 'Versions/A/Mock'), 'SYNTHETIC FRAMEWORK');
  await symlink('A', path.join(framework, 'Versions/Current'), 'dir');
  await symlink('Versions/Current/Mock', path.join(framework, 'Mock'));
  return { root, bundle, framework };
}

test('accepts internal framework links when a parent directory has a filesystem alias', async (t) => {
  const { verifyBundleLinks } = await import('./bundle.ts');
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const alias = path.join(f.root, 'alias');
  await symlink(f.bundle, alias, 'junction');
  await expect(verifyBundleLinks(alias)).resolves.toBeUndefined();
});

test.each([false, true])(
  'rejects direct and chained escapes to a sibling bundle (%s)',
  async (chain) => {
    const { verifyBundleLinks } = await import('./bundle.ts');
    const f = await fixture();
    try {
      const outside = path.join(f.root, 'Mock.app-other');
      await mkdir(outside);
      await writeFile(path.join(outside, 'private'), 'SYNTHETIC OUTSIDE DATA');
      const target = path.join(f.framework, 'escape');
      if (chain) {
        await symlink(outside, path.join(f.framework, 'outside'), 'junction');
        await symlink('outside/private', target);
      } else await symlink(path.join(outside, 'private'), target);
      await expect(verifyBundleLinks(f.bundle)).rejects.toThrow('APP_LINK_ESCAPES_BUNDLE');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('rejects a dangling framework link', async (t) => {
  const { verifyBundleLinks } = await import('./bundle.ts');
  const f = await fixture();
  t.onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await symlink('missing', path.join(f.framework, 'dangling'));
  await expect(verifyBundleLinks(f.bundle)).rejects.toMatchObject({ code: 'ENOENT' });
});
