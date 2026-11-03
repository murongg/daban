import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { assembleComponent } from './components.ts';
import { sealHostPackage } from './roles.ts';

test('the Mac component layout supports a sealed shared executable without duplicating it', {
  skip: process.platform !== 'darwin',
  timeout: 20000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-component-signature-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await assembleComponent(
    {
      output: path.join(root, 'output'),
      nodeDirectory: root,
      environmentDirectory: root,
      platform: 'darwin',
      arch: 'arm64',
      version: '0.1.0-synthetic',
      id: 'e'.repeat(64),
    },
    {
      host: async (target) => {
        await mkdir(path.join(target, 'node/bin'), { recursive: true });
        await copyFile('/usr/bin/true', path.join(target, 'node/bin/node'));
        await writeFile(path.join(target, 'main.js'), 'export const synthetic = true;');
      },
      tools: async (_source, target) => {
        await mkdir(target);
      },
      executor: async (target) => {
        await writeFile(target, 'SYNTHETIC EXECUTOR');
      },
    },
  );
  const run = promisify(execFile);
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', result.directory]);
  await sealHostPackage(result.agent);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', result.directory]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', result.directory]);
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    '=identifier "dev.daban.runtime"',
    result.directory,
  ]);
  const detail = await run('/usr/bin/codesign', ['-d', '--verbose=2', result.directory]);
  assert.match(detail.stderr, /Identifier=dev\.daban\.runtime/);
});
