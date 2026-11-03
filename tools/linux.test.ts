import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { bundleLinuxExecutor, executorUnit, guestSudoers } from './linux.ts';

test('the manual Linux bundle includes standalone executor dependencies and installer but excludes unrelated host files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-linux-bundle-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'vendor/engine/dist'), { recursive: true });
  await mkdir(path.join(source, 'vendor/protocol/dist'), { recursive: true });
  await writeFile(path.join(source, 'main.js'), 'export const synthetic = true;');
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: '@daban/runtime',
      dependencies: {
        '@daban/engine': 'file:./vendor/engine',
        '@daban/protocol': 'file:./vendor/protocol',
      },
    }),
  );
  await writeFile(path.join(source, 'package-lock.json'), '{}');
  await writeFile(path.join(source, 'LICENSE'), 'SYNTHETIC LICENSE');
  await writeFile(path.join(source, 'control-token'), 'SYNTHETIC DO NOT PACKAGE');
  const output = path.join(root, 'output');
  const archive = await bundleLinuxExecutor(source, output);
  const run = promisify(execFile);
  const files = (await run('tar', ['-tzf', archive], { windowsHide: true })).stdout;
  expect.assert(files.includes('runtime/install.ts'));
  expect.assert(files.includes('runtime/vendor/engine/'));
  expect.assert(!files.includes('control-token'));
  expect(
    (await run('tar', ['-xOf', archive, 'runtime/LICENSE'], { windowsHide: true })).stdout,
  ).toBe('SYNTHETIC LICENSE');
  await expect(bundleLinuxExecutor(source, output)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(source, 'control-token'), 'utf8')).toBe(
    'SYNTHETIC DO NOT PACKAGE',
  );
});

test('the Linux service runs as a dedicated account and installer rejects injected login names and executable paths', () => {
  const unit = executorUnit('/opt/mock-node/bin/node');
  expect(unit).toMatch(/User=bot-prototype/);
  expect(unit).toMatch(/UMask=0077/);
  expect(unit).toMatch(/Restart=on-failure/);
  expect(guestSudoers('mock-bot')).toMatch(/mock-bot ALL=\(root\) NOPASSWD: \/bin\/sh/);
  expect(() => guestSudoers('root')).toThrow(/LINUX_LOGIN_INVALID/);
  expect(() => guestSudoers('mock\nALL=ALL')).toThrow(/LINUX_LOGIN_INVALID/);
  expect(() => executorUnit('/mock/node\nExecStart=mock')).toThrow(/LINUX_NODE_PATH/);
});
