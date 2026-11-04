import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { remoteServer } from '@daban/protocol';

export function cloudConfiguration(env: NodeJS.ProcessEnv) {
  const server = remoteServer(env.DABAN_CONNECT_SERVER ?? '');
  const directory = env.DABAN_CLOUD_DATA ?? '/data/daban';
  if (!path.isAbsolute(directory) || directory.includes('\0'))
    throw Error('REMOTE_CLOUD_DIRECTORY');
  return { server, directory };
}
async function run() {
  if (process.platform !== 'linux' || process.getuid?.() === 0)
    throw Error('REMOTE_CLOUD_REQUIRES_UNPRIVILEGED_LINUX');
  const config = cloudConfiguration(process.env);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temporary = await mkdtemp(path.join(tmpdir(), 'daban-cloud-'));
  const authority = path.join(temporary, 'authority');
  const display = ':99';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: display,
    XAUTHORITY: authority,
    XDG_SESSION_TYPE: 'x11',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const children: ChildProcess[] = [];
  let stopping = false;
  let exit: () => unknown = () => {};
  const stopped = new Promise<undefined>((resolve) => {
    exit = () => resolve(undefined);
  });
  const stop = () => {
    stopping = true;
    exit();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  function start(command: string, args: string[]) {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    children.push(child);
    child.once('error', () => {
      process.exitCode = 1;
      stop();
    });
    child.once('exit', (status) => {
      if (!stopping) {
        process.exitCode = status || 1;
        stop();
      }
    });
    return child;
  }
  try {
    execFileSync(
      'xauth',
      ['-f', authority, 'add', display, 'MIT-MAGIC-COOKIE-1', randomBytes(16).toString('hex')],
      { env },
    );
    start('Xvfb', [display, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-auth', authority]);
    let ready = false;
    for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
      try {
        execFileSync('xdpyinfo', [], { env, stdio: 'ignore' });
        ready = true;
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw Error('REMOTE_CLOUD_DISPLAY_UNAVAILABLE');
    start('openbox', []);
    start('tint2', []);
    const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
    const electron: unknown = requireDesktop('electron');
    if (typeof electron !== 'string') throw Error('REMOTE_CLOUD_ELECTRON_UNAVAILABLE');
    start(electron, [
      path.join(root, 'dist-electron/main.cjs'),
      '--host-only',
      `--user-data-dir=${config.directory}`,
      `--connect-server=${config.server}`,
    ]);
    await stopped;
  } finally {
    stopping = true;
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, 'close').catch(() => {});
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await closed;
      clearTimeout(timer);
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await run();
