import assert from 'node:assert/strict';
import child from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { secureDirectory } from './private-files.js';

test('Windows private directories accept the local administrator SID alias but refuse broad ACL grants', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-acl-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let descriptor = 'D:PAI(A;OICI;FA;;;LA)';
  t.mock.method(child, 'execFile', (...input: unknown[]) => {
    const args = input[1] as string[],
      callback = input.at(-1) as (error: Error | null, output: string) => unknown;
    const output = args.includes('/user') ? '"SYNTHETIC","S-1-5-21-101-202-303-500"' : '';
    const operation = args.includes('/save')
      ? writeFile(
          args[args.indexOf('/save') + 1],
          Buffer.from(`mock\r\n${descriptor}\r\n`, 'utf16le'),
        )
      : Promise.resolve();
    operation.then(
      () => callback(null, output),
      (error) => callback(error, ''),
    );
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await secureDirectory(path.join(root, 'trusted'));
    descriptor = 'D:PAI(A;OICI;FA;;;WD)';
    await assert.rejects(secureDirectory(path.join(root, 'untrusted')), /PRIVATE_DIRECTORY_UNSAFE/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
