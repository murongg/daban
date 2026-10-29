import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'apps/runtime/src');
const output = join(root, 'dist-runtime/runtime');
await mkdir(output, { recursive: true });
for (const name of await readdir(source))
  if (/\.(html|css|py|service)$/.test(name)) await copyFile(join(source, name), join(output, name));
const manifest = JSON.parse(await readFile(join(root, 'apps/runtime/package.json'), 'utf8'));
// A VM cannot follow npm workspace links back to the source checkout.
manifest.dependencies['@daban/protocol'] = 'file:./vendor/protocol';
delete manifest.scripts;
await writeFile(join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(join(root, 'packages/protocol/dist'), join(output, 'vendor/protocol/dist'), {
  recursive: true,
});
await copyFile(
  join(root, 'packages/protocol/package.json'),
  join(output, 'vendor/protocol/package.json'),
);
const lock = JSON.parse(await readFile(join(root, 'apps/runtime/standalone-lock.json'), 'utf8'));
assert.deepEqual(
  lock.packages[''].dependencies,
  manifest.dependencies,
  'standalone lock must match runtime dependencies',
);
assert.deepEqual(
  lock.packages[''].devDependencies,
  manifest.devDependencies,
  'standalone lock must match test dependencies',
);
await copyFile(join(root, 'apps/runtime/standalone-lock.json'), join(output, 'package-lock.json'));
