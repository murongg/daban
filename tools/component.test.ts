import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { componentSourceId } from './components.ts';

test('Windows component validation reaches integrity checks from a shared temporary directory', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-component-validation-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const stage = path.join(temporary, 'source');
  const runtime = path.join(stage, 'DabanRuntime');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'component.json'), JSON.stringify({ version: 0 }));
  const archive = path.join(temporary, 'runtime.zip');
  const run = promisify(execFile);
  await run('tar.exe', ['-a', '-cf', archive, '-C', stage, 'DabanRuntime'], {
    windowsHide: true,
  });
  const shared = path.join(temporary, 'shared temp');
  await mkdir(shared);
  await run(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/icacls.exe'),
    [shared, '/grant', '*S-1-1-0:(OI)(CI)RX'],
    { windowsHide: true },
  );
  const bytes = await readFile(archive);
  const reference = path.join(temporary, 'reference.json');
  await writeFile(
    reference,
    JSON.stringify({
      version: 1,
      id: await componentSourceId(root),
      assets: [
        {
          platform: 'win32',
          arch: 'x64',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  );
  await expect(
    run(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(root, 'tools/component.ts'),
        'validate',
        path.join(temporary, 'SyntheticClient.exe'),
        archive,
        reference,
      ],
      {
        cwd: root,
        timeout: 20000,
        windowsHide: true,
        env: { ...process.env, TEMP: shared, TMP: shared },
      },
    ),
  ).rejects.toMatchObject({ stderr: expect.stringMatching(/^Error: COMPONENT_INTEGRITY\r?$/m) });
});
