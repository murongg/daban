import child, { ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { privateMetadata, secureDirectory } from './private-files.js';

const owner = 'S-1-5-21-101-202-303-500';

async function windowsAcl(
  descriptor: string | ((target: string) => string | undefined),
  check: (root: string, calls: string[][]) => Promise<unknown>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-acl-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const calls: string[][] = [];
  const created = new Set<string>();
  vi.spyOn(child, 'execFile').mockImplementation((...input: unknown[]) => {
    const args = input[1] as string[],
      callback = input.at(-1) as (error: Error | null, output: string) => unknown;
    calls.push(args);
    if (args.includes('/grant:r')) created.add(args[0]);
    const output = args.includes('/user') ? `"SYNTHETIC","${owner}"` : '';
    const acl = created.has(args[0])
      ? `D:P(A;OICI;FA;;;${owner})`
      : typeof descriptor === 'string'
        ? descriptor
        : descriptor(args[0]);
    const operation = args.includes('/save')
      ? acl === undefined
        ? Promise.reject(new Error('SYNTHETIC_ACL_UNAVAILABLE'))
        : writeFile(args[args.indexOf('/save') + 1], Buffer.from(`mock\r\n${acl}\r\n`, 'utf16le'))
      : Promise.resolve();
    operation.then(
      () => callback(null, output),
      (error) => callback(error, ''),
    );
    return new ChildProcess();
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await check(root, calls);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
}

test.each([
  `D:PAI(A;OICI;FA;;;${owner})`,
  'D:PAI(A;OICI;FA;;;LA)',
  `D:AI(A;OICIID;0x1f01ff;;;${owner})`,
  `D:P(A;OI;FA;;;${owner})`,
  `D:P(A;;FA;;;${owner})(A;OIIO;FA;;;CO)`,
  `D:P(A;;FA;;;${owner})(A;OICIIO;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
  `D:P(OA;OICI;FA;;;${owner})`,
  `D:P(D;OICI;FR;;;WD)(A;OICI;FA;;;${owner})`,
  `D:P(A;;FA;;;${owner})`,
  `D:P(A;CI;FA;;;${owner})`,
  `D:P(A;OICINP;FA;;;${owner})`,
  `D:P(A;IO;FA;;;${owner})`,
  `D:P(D;OI;FA;;;WD)(A;;FA;;;${owner})`,
])(
  'synthetic Windows ACL preserves existing private directory compatibility: %s',
  async (descriptor) => {
    await windowsAcl(descriptor, async (root, calls) => {
      const directory = path.join(root, 'existing');
      await mkdir(directory);
      await expect(secureDirectory(directory)).resolves.toBeTruthy();
      expect(calls.some((args) => args.includes('/grant:r'))).toBe(false);
    });
  },
);

test.each([
  `D:P(OA;OICI;FA;;11111111-2222-3333-4444-555555555555;${owner})`,
  `D:P(A;OICIZZ;FA;;;${owner})`,
  `D:P(A;OICI;FA;;;${owner})UNPARSED`,
  `D:P(A;OICI;FA;;;${owner}`,
  `D:P(A;OICI;FA;;;${owner})(XA;OICI;FA;;;WD;(1==1))`,
  'D:PAI(A;OICI;FA;;;WD)',
  'D:PAI(A;OICI;FA;;;S-1-5-21-404-505-606-1001)',
  'D:NO_ACCESS_CONTROL',
  'D:P',
  '',
])(
  'synthetic Windows ACL refuses unsafe or unparseable directories without changing existing ACLs: %s',
  async (descriptor) => {
    await windowsAcl(descriptor, async (root, calls) => {
      const directory = path.join(root, 'existing');
      await mkdir(directory);
      await expect(secureDirectory(directory)).rejects.toThrow('PRIVATE_DIRECTORY_UNSAFE');
      expect(calls.some((args) => args.includes('/grant:r'))).toBe(false);
    });
  },
);

test('synthetic Windows ACL creates new private roots with the existing inheritable owner grant', async () => {
  await windowsAcl(`D:P(A;OICI;FA;;;${owner})`, async (root, calls) => {
    const directory = path.join(root, 'new');
    await secureDirectory(directory);
    expect(calls).toContainEqual([directory, '/inheritance:r', '/grant:r', `*${owner}:(OI)(CI)F`]);
  });
});

test('compatibility: an existing private parent and explicitly private legacy file remain readable', async () => {
  await windowsAcl(`D:P(A;;FA;;;${owner})`, async (root) => {
    const directory = path.join(root, 'legacy');
    await mkdir(directory);
    const file = path.join(directory, 'legacy-key');
    await writeFile(file, 'SYNTHETIC PRIVATE BYTES', { mode: 0o600 });
    // Read-only consumers secure the parent too; new-file inheritance is not required to read this private file.
    await expect(secureDirectory(directory)).resolves.toBeTruthy();
    expect(await privateMetadata(file, await lstat(file), 0o600)).toBe(true);
  });
});

test.each([
  `D:P(A;;FA;;;${owner})`,
  'D:P(A;;FA;;;LA)',
  `D:AI(A;ID;0x1f01ff;;;${owner})`,
  `D:P(A;;FA;;;${owner})(A;OIIO;FA;;;CO)(A;OICIIO;FA;;;OW)`,
])('synthetic Windows metadata validates the actual private object ACL: %s', async (objectAcl) => {
  await windowsAcl(
    (target) => (path.basename(target) === 'legacy-key' ? objectAcl : `D:P(A;;FA;;;${owner})`),
    async (root, calls) => {
      const directory = path.join(root, 'existing');
      await mkdir(directory);
      await secureDirectory(directory);
      const file = path.join(directory, 'legacy-key');
      await writeFile(file, 'SYNTHETIC PRIVATE BYTES', { mode: 0o600 });
      expect(await privateMetadata(file, await lstat(file), 0o600)).toBe(true);
      const query = calls.find((args) => args.includes('/save') && args[0].endsWith('legacy-key'));
      expect(query).toBeDefined();
      const output = query![query!.indexOf('/save') + 1];
      expect(path.dirname(output)).not.toBe(path.dirname(file));
      await expect(lstat(path.dirname(output))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        calls.some((args) => args[0].endsWith('legacy-key') && args.includes('/grant:r')),
      ).toBe(false);
      expect(await readFile(file, 'utf8')).toBe('SYNTHETIC PRIVATE BYTES');
    },
  );
});

test.each([
  'D:P(A;;FA;;;WD)',
  'D:P(A;;FA;;;OW)',
  'D:P(A;;FA;;;CO)',
  'D:P(A;;FA;;;S-1-3-0)',
  `D:P(A;;FA;;;${owner})(XA;;FA;;;WD;(1==1))`,
  'D:P(ZZ;;FA;;;LA)',
  `D:P(A;;FA;;;${owner})UNPARSED`,
  `D:P(A;;FA;;;${owner})\r\n(A;;FA;;;WD)`,
  `D:P(A;;FA;;;${owner}`,
  'D:NO_ACCESS_CONTROL',
  '',
  undefined,
])(
  'synthetic Windows metadata rejects an unsafe or unavailable child ACL despite root registration: %s',
  async (objectAcl) => {
    await windowsAcl(
      (target) => (path.basename(target) === 'child' ? objectAcl : `D:P(A;OICI;FA;;;${owner})`),
      async (root, calls) => {
        const directory = await secureDirectory(path.join(root, 'private'));
        const file = path.join(directory, 'child');
        await writeFile(file, 'SYNTHETIC PRIVATE BYTES', { mode: 0o600 });
        expect(await privateMetadata(file, await lstat(file), 0o600)).toBe(false);
        const query = calls.find((args) => args.includes('/save') && args[0] === file);
        expect(query).toBeDefined();
        await expect(
          lstat(path.dirname(query![query!.indexOf('/save') + 1])),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(calls.some((args) => args[0] === file && args.includes('/grant:r'))).toBe(false);
        expect(await readFile(file, 'utf8')).toBe('SYNTHETIC PRIVATE BYTES');
      },
    );
  },
);

test('synthetic Windows metadata never queries an object outside the registered canonical root', async () => {
  await windowsAcl(`D:P(A;OICI;FA;;;${owner})`, async (root, calls) => {
    const directory = await secureDirectory(path.join(root, 'private'));
    const outside = `${directory}-sibling`;
    await writeFile(outside, 'SYNTHETIC OUTSIDE');
    const count = calls.length;
    expect(await privateMetadata(outside, await lstat(outside), 0o600)).toBe(false);
    expect(calls).toHaveLength(count);
  });
});
