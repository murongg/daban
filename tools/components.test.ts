import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { linuxFilename } from '@daban/engine/component';
import { expect, test } from 'vitest';
import { assembleComponent, assembleLinux, componentSourceId, verifyLinux } from './components.ts';
import { hashAsset } from './environment.ts';

test('component identity follows runtime sources and dependencies, independently of renderer edits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-source-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
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
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  await put('apps/desktop/src/App.tsx', 'SYNTHETIC RENDERER EDIT');
  await put('packages/engine/src/model.test.ts', 'SYNTHETIC TEST EDIT');
  expect(await componentSourceId(root)).toBe(first);
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
  expect(await componentSourceId(root)).toBe(first);
  await put('packages/engine/src/model.ts', 'SYNTHETIC RUNTIME CHANGED');
  const second = await componentSourceId(root);
  expect(second).not.toBe(first);
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
  expect(await componentSourceId(root)).not.toBe(second);
  const third = await componentSourceId(root);
  await put('apps/runtime/src/main.ts', 'SYNTHETIC EXECUTOR ENTRY CHANGED');
  const fourth = await componentSourceId(root);
  expect(fourth).not.toBe(third);
  await put('apps/agent/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2023' } }));
  expect(await componentSourceId(root)).not.toBe(fourth);
});

test('pins optional payloads after Lima signing and keeps their metadata separate from executable bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-linux-layout-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const events: string[] = [];
  const reference = await assembleLinux(
    { output: root, environmentDirectory: '/synthetic/environment', id: 'a'.repeat(64) },
    async (resources) => {
      events.push('signed');
      await writeFile(path.join(resources, 'environment/lima.tar.gz'), 'SYNTHETIC SIGNED LIMA');
    },
    {
      tools: async (_source, target) => {
        await mkdir(target);
        await writeFile(path.join(target, 'lima.tar.gz'), 'SYNTHETIC UNSIGNED LIMA');
        await writeFile(path.join(target, 'manifest.json'), '{}');
        await writeFile(path.join(target, 'COMPONENTS.md'), 'SYNTHETIC NOTICES');
      },
      executor: async (target) => {
        events.push('executor');
        await writeFile(target, 'SYNTHETIC EXECUTOR');
      },
    },
  );
  expect(events).toStrictEqual(['executor', 'signed']);
  for (const kind of ['lima', 'executor'] as const) {
    const hash = await hashAsset(path.join(root, linuxFilename(kind)), 'sha256');
    expect(reference[kind]).toStrictEqual({ bytes: hash.bytes, sha256: hash.digest });
  }
  expect(JSON.parse(await readFile(path.join(root, 'linux.json'), 'utf8'))).toStrictEqual(
    reference,
  );
  expect(await verifyLinux(root, reference.id)).toStrictEqual(reference);
  await writeFile(path.join(root, linuxFilename('executor')), 'SYNTHETIC CORRUPT EXECUTOR');
  await expect(verifyLinux(root, reference.id)).rejects.toThrowError(/COMPONENT_RELEASE_INTEGRITY/);
  await expect(lstat(path.join(root, 'environment/lima.tar.gz'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('assembles a host component that pins optional Linux resources without bundling them', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-component-layout-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const platforms =
    process.platform === 'win32' ? (['win32'] as const) : (['darwin', 'win32'] as const);
  const environmentDirectory = path.join(root, 'synthetic-environment');
  await mkdir(environmentDirectory);
  await writeFile(path.join(environmentDirectory, 'manifest.json'), '{}');
  await writeFile(path.join(environmentDirectory, 'COMPONENTS.md'), 'SYNTHETIC NOTICES');
  for (const platform of platforms) {
    const id = 'd'.repeat(64);
    const linux = {
      version: 1 as const,
      id,
      lima: { bytes: 512, sha256: 'a'.repeat(64) },
      executor: { bytes: 128, sha256: 'b'.repeat(64) },
    };
    const result = await assembleComponent(
      {
        output: path.join(root, platform),
        nodeDirectory: path.join(root, 'synthetic-node'),
        linuxReference: platform === 'darwin' ? linux : undefined,
        environmentDirectory,
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
      },
    );
    expect(
      JSON.parse(await readFile(path.join(result.resources, 'component.json'), 'utf8')).id,
    ).toBe(id);
    await expect(
      lstat(path.join(result.resources, 'environment/system.raw.gz')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(lstat(path.join(result.resources, 'app/dist'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(lstat(path.join(result.directory, 'Contents/Frameworks'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    if (platform === 'darwin') {
      expect(
        JSON.parse(await readFile(path.join(result.agent, 'linux.json'), 'utf8')),
      ).toStrictEqual(linux);
      await expect(
        lstat(path.join(result.resources, 'environment/lima.tar.gz')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(path.join(result.agent, 'executor.tar.gz'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const entry = path.join(result.directory, 'Contents/MacOS/agent');
      expect((await lstat(entry)).isFile()).toBe(true);
      await expect(lstat(path.join(result.agent, 'node/bin/node'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect.assert(
        (await readFile(path.join(result.directory, 'Contents/Info.plist'), 'utf8')).includes(
          'dev.daban.runtime',
        ),
      );
    }
  }
});
