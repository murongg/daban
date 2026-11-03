import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SetupStatus } from '@daban/protocol';

export async function restartWindows(options: {
  status: () => Promise<SetupStatus>;
  idle: () => Promise<unknown>;
  platform?: NodeJS.Platform;
  run?: (program: string, args: string[]) => Promise<unknown>;
}) {
  const status = await options.status();
  if (
    (options.platform ?? process.platform) !== 'win32' ||
    !status.required ||
    status.target !== 'linux' ||
    status.phase !== 'waiting' ||
    status.windows?.acceleration !== 'restart' ||
    status.windows.mode !== 'whpx'
  )
    throw Error('QEMU_RESTART_UNAVAILABLE');
  // The host update gate fences new admissions and refuses jobs, schedules, recovery and active installers.
  await options.idle();
  const program = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/shutdown.exe');
  const run =
    options.run ??
    ((binary: string, args: string[]) =>
      promisify(execFile)(binary, args, {
        windowsHide: true,
        timeout: 15000,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      }));
  try {
    await run(program, ['/r', '/t', '0']);
  } catch {
    throw Error('QEMU_RESTART_FAILED');
  }
}
