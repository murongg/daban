import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function packageNotices(resources: string, owner: string) {
  // Electron already owns Resources/LICENSE; keep its notice and ship Daban's license separately.
  await copyFile(
    new URL('../LICENSE', import.meta.url),
    path.join(resources, 'DABAN-LICENSE'),
    constants.COPYFILE_EXCL,
  );
  const requireDesktop = createRequire(owner);
  const seen = new Set<string>();
  async function updaterNotices(name: string, from: string) {
    const file = createRequire(from).resolve(`${name}/package.json`);
    const pkg = JSON.parse(await readFile(file, 'utf8')) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    };
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) return;
    seen.add(id);
    const directory = path.dirname(file);
    const target = path.join(resources, 'updater-notices', id.replaceAll('/', '_'));
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isFile() && /^(licen[sc]e|notice|copyright)(\.|$)/i.test(entry.name))
        await copyFile(
          path.join(directory, entry.name),
          path.join(target, entry.name),
          constants.COPYFILE_EXCL,
        );
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      await updaterNotices(dependency, file);
  }
  await updaterNotices('electron-updater', owner);
  await updaterNotices('builder-util-runtime', owner);
  const frontendNotices = path.join(resources, 'frontend-notices');
  await mkdir(frontendNotices);
  for (const [name, names] of [
    ['dompurify', ['LICENSE', 'LICENSE-MPL']],
    ['katex', ['LICENSE']],
    ['mermaid', ['LICENSE']],
  ] as const) {
    const directory = path.dirname(path.dirname(requireDesktop.resolve(name)));
    assert.equal(
      JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).name,
      name,
    );
    for (const file of names)
      await copyFile(
        path.join(directory, file),
        path.join(frontendNotices, `${name}-${file}`),
        constants.COPYFILE_EXCL,
      );
  }
  await copyFile(
    path.join(path.dirname(owner), 'licenses/remark-math-LICENSE'),
    path.join(frontendNotices, 'remark-math-LICENSE'),
    constants.COPYFILE_EXCL,
  );
  await cp(
    path.join(path.dirname(owner), 'licenses/controls'),
    path.join(frontendNotices, 'controls'),
    { recursive: true, force: false, errorOnExist: true },
  );
}
