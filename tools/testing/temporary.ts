import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';

if (process.platform === 'win32') {
  const original = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'daban-vitest-'));
  const relative = path.relative(parent, directory);
  if (
    !relative.startsWith('daban-vitest-') ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('TEST_TEMP_DIRECTORY_UNSAFE');
  const run = promisify(execFile);
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const { stdout } = await run(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
  });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('TEST_TEMP_OWNER_UNAVAILABLE');
  // Store fixtures must inherit the same private ACL boundary as real app data, not the public system temp ACL.
  await run(
    path.join(system, 'icacls.exe'),
    [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
    { windowsHide: true },
  );
  process.env.TEMP = directory;
  process.env.TMP = directory;
  afterAll(async () => {
    for (const key of ['TEMP', 'TMP'] as const) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await rm(directory, { recursive: true, force: true });
  });
}
