import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assembleComponent, componentSourceId } from './components.ts';

test('component identity follows runtime sources and dependencies, independently of renderer edits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name: string, text: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  for (const name of [
    'apps/agent/src/main.ts',
    'apps/runtime/src/main.ts',
    'tools/engine.ts',
    'packages/engine/src/model.ts',
    'packages/protocol/src/index.ts',
    'tools/entitlements/app.plist',
    'tools/components.ts',
    'tools/roles.ts',
    'tools/sign.ts',
    'tools/environment.ts',
    'LICENSE',
  ])
    await put(name, 'SYNTHETIC RUNTIME SOURCE');
  for (const name of [
    'apps/agent/package.json',
    'apps/runtime/package.json',
    'apps/runtime/standalone-lock.json',
    'tsconfig.json',
    'apps/agent/tsconfig.json',
    'apps/runtime/tsconfig.json',
    'packages/engine/tsconfig.json',
    'packages/protocol/tsconfig.json',
    'packages/engine/package.json',
    'packages/protocol/package.json',
  ])
    await put(
      name,
      JSON.stringify({
        name: '@daban/synthetic',
        version: '1.0.0',
        dependencies: { 'synthetic-module': '1.0.0', '@daban/protocol': '1.0.0' },
      }),
    );
  await put(
    'package.json',
    JSON.stringify({ version: '1.0.0', devDependencies: { typescript: '1.0.0', vite: '1.0.0' } }),
  );
  await put(
    'apps/agent/standalone-lock.json',
    JSON.stringify({
      version: '1.0.0',
      packages: {
        '': { version: '1.0.0' },
        'node_modules/synthetic-module': { version: '1.0.0', integrity: 'synthetic-a' },
      },
    }),
  );
  const first = await componentSourceId(root);
  assert.match(first, /^[a-f0-9]{64}$/);
  await put('apps/desktop/src/App.tsx', 'SYNTHETIC RENDERER EDIT');
  await put('packages/engine/src/model.test.ts', 'SYNTHETIC TEST EDIT');
  assert.equal(await componentSourceId(root), first);
  await put(
    'apps/agent/package.json',
    JSON.stringify({
      name: '@daban/synthetic',
      version: '2.0.0',
      dependencies: { 'synthetic-module': '1.0.0', '@daban/protocol': '2.0.0' },
    }),
  );
  await put(
    'apps/agent/standalone-lock.json',
    JSON.stringify({
      version: '2.0.0',
      packages: {
        '': { version: '2.0.0' },
        'node_modules/synthetic-module': { version: '1.0.0', integrity: 'synthetic-a' },
      },
    }),
  );
  assert.equal(await componentSourceId(root), first);
  await put('packages/engine/src/model.ts', 'SYNTHETIC RUNTIME CHANGED');
  const second = await componentSourceId(root);
  assert.notEqual(second, first);
  await put(
    'apps/agent/standalone-lock.json',
    JSON.stringify({
      version: '2.0.0',
      packages: {
        '': { version: '2.0.0' },
        'node_modules/synthetic-module': { version: '1.1.0', integrity: 'synthetic-b' },
      },
    }),
  );
  assert.notEqual(await componentSourceId(root), second);
  const third = await componentSourceId(root);
  await put('apps/runtime/src/main.ts', 'SYNTHETIC EXECUTOR ENTRY CHANGED');
  const fourth = await componentSourceId(root);
  assert.notEqual(fourth, third);
  await put('apps/agent/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2023' } }));
  assert.notEqual(await componentSourceId(root), fourth);
});

test('assembles a host component without Electron, renderer assets or a Linux disk image', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platforms =
    process.platform === 'win32' ? (['win32'] as const) : (['darwin', 'win32'] as const);
  for (const platform of platforms) {
    const id = 'd'.repeat(64);
    let tools = 0;
    const result = await assembleComponent(
      {
        output: path.join(root, platform),
        nodeDirectory: path.join(root, 'synthetic-node'),
        environmentDirectory: path.join(root, 'synthetic-environment'),
        platform,
        arch: platform === 'darwin' ? 'arm64' : 'x64',
        version: '0.1.0-synthetic',
        id,
      },
      {
        host: async (target) => {
          await mkdir(path.join(target, 'node', platform === 'darwin' ? 'bin' : ''), {
            recursive: true,
          });
          await writeFile(path.join(target, 'main.js'), 'export const synthetic = true;');
          await writeFile(
            path.join(target, platform === 'darwin' ? 'node/bin/node' : 'node/node.exe'),
            'SYNTHETIC NODE',
            { mode: 0o700 },
          );
        },
        tools: async (_source, target) => {
          tools++;
          await mkdir(target);
          await writeFile(path.join(target, 'lima.tar.gz'), 'SYNTHETIC VERIFIED VM TOOLS');
        },
        executor: async (target) => {
          await writeFile(target, 'SYNTHETIC EXECUTOR');
        },
      },
    );
    assert.equal(
      JSON.parse(await readFile(path.join(result.resources, 'component.json'), 'utf8')).id,
      id,
    );
    await assert.rejects(lstat(path.join(result.resources, 'environment/system.raw.gz')), {
      code: 'ENOENT',
    });
    await assert.rejects(lstat(path.join(result.resources, 'app/dist')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(result.directory, 'Contents/Frameworks')), {
      code: 'ENOENT',
    });
    if (platform === 'darwin') {
      assert.equal(tools, 1);
      const entry = path.join(result.directory, 'Contents/MacOS/agent');
      assert.equal((await lstat(entry)).isFile(), true);
      await assert.rejects(lstat(path.join(result.agent, 'node/bin/node')), { code: 'ENOENT' });
      assert.ok(
        (await readFile(path.join(result.directory, 'Contents/Info.plist'), 'utf8')).includes(
          'dev.daban.runtime',
        ),
      );
    } else assert.equal(tools, 0);
  }
});
