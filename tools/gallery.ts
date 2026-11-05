import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleGraph } from './roles.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'outputs/gallery-standalone');
// This is a generated package directory, never the gallery's persistent data volume.
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'vendor/engine/dist'), { recursive: true });
await mkdir(path.join(output, 'vendor/protocol'), { recursive: true });
const engine = JSON.parse(await readFile(path.join(root, 'packages/engine/package.json'), 'utf8'));
engine.exports = { './gallery': engine.exports['./gallery'] };
engine.dependencies = {
  '@better-auth/drizzle-adapter': engine.dependencies['@better-auth/drizzle-adapter'],
  '@daban/protocol': 'file:../protocol',
  'better-auth': engine.dependencies['better-auth'],
  'drizzle-orm': engine.dependencies['drizzle-orm'],
  yaml: engine.dependencies.yaml,
};
delete engine.devDependencies;
delete engine.scripts;
await writeFile(
  path.join(output, 'vendor/engine/package.json'),
  `${JSON.stringify(engine, null, 2)}\n`,
);
for (const file of await moduleGraph(path.join(root, 'packages/engine/dist'), ['gallery.js'])) {
  const destination = path.join(output, 'vendor/engine/dist', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, 'packages/engine/dist', file), destination);
}
await cp(path.join(root, 'packages/protocol/dist'), path.join(output, 'vendor/protocol/dist'), {
  recursive: true,
});
const protocol = JSON.parse(
  await readFile(path.join(root, 'packages/protocol/package.json'), 'utf8'),
);
delete protocol.scripts;
delete protocol.devDependencies;
await writeFile(
  path.join(output, 'vendor/protocol/package.json'),
  `${JSON.stringify(protocol, null, 2)}\n`,
);
const manifest = JSON.parse(await readFile(path.join(root, 'apps/gallery/package.json'), 'utf8'));
manifest.dependencies = {
  '@daban/engine': 'file:./vendor/engine',
  '@daban/protocol': 'file:./vendor/protocol',
};
manifest.scripts = { start: 'node main.js', admin: 'node main.js' };
delete manifest.devDependencies;
await writeFile(path.join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(path.join(root, 'dist-gallery/main.js'), path.join(output, 'main.js'));
await cp(path.join(root, 'dist-gallery/web'), path.join(output, 'web'), { recursive: true });
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
const lockfile = path.join(root, 'apps/gallery/standalone-lock.json');
if (process.argv.includes('--update-lock')) {
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--cache',
      path.join(root, 'outputs/npm-gallery-cache'),
    ],
    { cwd: output, stdio: 'inherit' },
  );
  await copyFile(path.join(output, 'package-lock.json'), lockfile);
} else {
  const lock = JSON.parse(await readFile(lockfile, 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'GALLERY_LOCK_MISMATCH');
  assert.equal(lock.version, manifest.version, 'GALLERY_LOCK_VERSION');
  await copyFile(lockfile, path.join(output, 'package-lock.json'));
}
console.log(`Standalone gallery ready: ${output}`);
