import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { packageNotices } from './notices.ts';
import { buildExecutor, moduleGraph } from './roles.ts';

test('compiled Linux executor networking has no host SDK loader or credential-bearing modules', async () => {
  const graph = await moduleGraph(path.resolve('packages/engine/dist'), ['executor.js']);
  for (const host of ['dsh.js', 'web.js', 'model.js', 'settings.js', 'schedule-domain.js'])
    assert.equal(graph.includes(host), false, `guest graph imports host module ${host}`);
});

test('desktop artifacts retain third-party notices and include a separate Daban license', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'daban-desktop-license-'));
  try {
    await writeFile(path.join(target, 'LICENSE'), 'SYNTHETIC EXISTING DEPENDENCY NOTICE');
    await packageNotices(target, path.resolve('apps/desktop/package.json'));
    assert.equal(
      await readFile(path.join(target, 'LICENSE'), 'utf8'),
      'SYNTHETIC EXISTING DEPENDENCY NOTICE',
    );
    assert.deepEqual(await readFile(path.join(target, 'DABAN-LICENSE')), await readFile('LICENSE'));
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('executor artifacts include the project license and standalone database dependencies', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'daban-license-artifact-'));
  try {
    await buildExecutor(target);
    assert.deepEqual(await readFile(path.join(target, 'LICENSE')), await readFile('LICENSE'));
    const database = pathToFileURL(
      path.join(target, 'node_modules/@daban/engine/dist/database.js'),
    ).href;
    // Resolve from the built artifact so workspace dependencies cannot mask a missing package.
    assert.doesNotThrow(() =>
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(database)})`],
        { stdio: 'pipe' },
      ),
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
