import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { documentCommand } from './documents.js';

test('the isolated document reader preserves the Debian amd64 loader alias', () => {
  const command = documentCommand(
    {
      source: '/mock/source',
      dependencies: '/mock/deps',
      parserDependencies: '/mock/deps',
      engine: '/mock/node',
    },
    'pdf',
  );
  expect(command.args).toContain('/lib64');
  expect(command.args[command.args.indexOf('/lib64') - 1]).toBe('usr/lib64');
});

test('the document worker arguments start a real Node ES module without a package manifest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-document-entry-'));
  try {
    const { args } = documentCommand(
      {
        source: '/mock/source',
        dependencies: '/mock/deps',
        parserDependencies: '/mock/deps',
        engine: '/mock/node',
      },
      'pdf',
    );
    const command = args.slice(args.indexOf('/engine/bin/node') + 1);
    const index = command.findIndex((value) => value.startsWith('/app/runtime/extract.'));
    expect.assert(index >= 0);
    const entry = path.join(directory, path.posix.basename(command[index]));
    await writeFile(
      entry,
      "import { argv } from 'node:process'; process.stdout.write(JSON.stringify({ format: argv[2], esm: import.meta.url.startsWith('file:') }));",
    );
    command[index] = entry;
    const result = await promisify(execFile)(process.execPath, command, {
      cwd: directory,
      timeout: 5000,
    });
    expect(JSON.parse(result.stdout)).toStrictEqual({ format: 'pdf', esm: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('relocated document readers bind their own code and protocol plus only Linux parser dependencies', () => {
  const sourceEntry = path.join('/mock/engine/dist', 'extract.js');
  const command = documentCommand(
    {
      source: '/mock/engine/dist',
      dependencies: '/mock/new/node_modules',
      parserDependencies: '/mock/seed/runtime/node_modules',
      engine: '/mock/node',
    },
    'pdf',
  );
  expect(command.program).toBe('bwrap');
  expect.assert(command.args.includes('--unshare-all'));
  expect.assert(command.args.includes('--clearenv'));
  expect(
    command.args.slice(command.args.indexOf(sourceEntry), command.args.indexOf(sourceEntry) + 2),
  ).toStrictEqual([sourceEntry, '/app/runtime/extract.mjs']);
  expect(
    command.args.slice(
      command.args.indexOf('/mock/new/node_modules'),
      command.args.indexOf('/mock/new/node_modules') + 2,
    ),
  ).toStrictEqual(['/mock/new/node_modules', '/app/runtime/node_modules']);
  expect.assert(command.args.includes('/mock/seed/runtime/node_modules'));
  expect.assert(command.args.includes('/app/runtime/extract.mjs'));
  expect(command.args.includes('--experimental-default-type=module')).toBe(false);
  expect.assert(command.args.includes('--cpu=20'));
  expect.assert(command.args.includes('--max-old-space-size=256'));
  expect(command.args.at(-1)).toBe('pdf');
});
