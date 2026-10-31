import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecutor } from './roles.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist-runtime/runtime');
// This directory contains generated deployment files only, never a user's VM or workspace.
await rm(output, { recursive: true, force: true });
await buildExecutor(output);
await mkdir(path.join(output, 'vendor'), { recursive: true });
for (const name of ['engine', 'protocol'])
  await rename(path.join(output, 'node_modules/@daban', name), path.join(output, 'vendor', name));
await rm(path.join(output, 'node_modules'), { recursive: true, force: true });
const engineFile = path.join(output, 'vendor/engine/package.json');
const engine = JSON.parse(await readFile(engineFile, 'utf8'));
engine.dependencies['@daban/protocol'] = 'file:../protocol';
await writeFile(engineFile, JSON.stringify(engine, null, 2));
const manifest = JSON.parse(await readFile(path.join(root, 'apps/runtime/package.json'), 'utf8'));
manifest.dependencies['@daban/engine'] = 'file:./vendor/engine';
manifest.dependencies['@daban/protocol'] = 'file:./vendor/protocol';
delete manifest.scripts;
await writeFile(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2));
const lockFile = path.join(root, 'apps/runtime/standalone-lock.json');
const lock = JSON.parse(await readFile(lockFile, 'utf8'));
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'EXECUTOR_LOCK_MISMATCH');
await copyFile(lockFile, path.join(output, 'package-lock.json'));
