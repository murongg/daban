import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function packageNotices(resources: string, owner: string) {
  const requireDesktop = createRequire(owner);
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
