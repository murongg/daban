import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentToolRun, AgentTools } from './agent-tools.js';
import { Fault } from './control.js';
import { codexVersion, runCodexTurn } from './model-cli.js';

interface LocalTurn {
  prompt: string;
  instructions?: string;
  run: AgentToolRun;
  tools: AgentTools;
  onDelta: (delta: string) => unknown;
}
export interface LocalCodexDriver {
  check(): Promise<unknown>;
  run(turn: LocalTurn): Promise<string>;
}

const sandbox = '/usr/bin/sandbox-exec';
const authSetting = 'cli_auth_credentials_store="file"';
const literal = (file: string) => `(literal ${JSON.stringify(file)})`;
const subpath = (file: string) => `(subpath ${JSON.stringify(file)})`;

export class LocalCodex implements LocalCodexDriver {
  private async launch<T>(
    action: (start: (args: string[]) => ChildProcessWithoutNullStreams) => Promise<T>,
  ) {
    const home = await realpath(homedir());
    const binary = await this.binary(home);
    const helper = path.join(path.dirname(binary), 'codex-code-mode-host');
    if (!(await lstat(helper).catch(() => undefined))?.isFile())
      throw new Fault('CODEX_UNAVAILABLE', 503);
    const executables = [binary, helper].map(literal).join(' ');
    const auth = path.join(home, '.codex', 'auth.json');
    const info = await lstat(auth).catch(() => undefined);
    if (!info?.isFile() || (info.mode & 0o077) !== 0) throw new Fault('CODEX_LOGIN_REQUIRED', 400);
    const credential = await realpath(auth);
    // Only the standard login file is shared. Keep the real config, plugins, and history out of the child.
    if (credential !== auth) throw new Fault('CODEX_LOGIN_REQUIRED', 400);
    const root = await mkdtemp('/private/tmp/daban-codex-');
    const children: { child: ChildProcessWithoutNullStreams; closed: Promise<number | null> }[] =
      [];
    try {
      const codexHome = path.join(root, 'codex');
      const work = path.join(root, 'work');
      await mkdir(codexHome, { mode: 0o700 });
      await mkdir(work, { mode: 0o700 });
      await symlink(credential, path.join(codexHome, 'auth.json'));
      const privatePaths = ['/Users', '/Volumes', '/private/tmp', '/private/var/folders', home]
        .map(subpath)
        .join(' ');
      const policy = [
        '(version 1) (allow default)',
        `(deny file-read-data (require-all (require-any ${privatePaths}) (require-not (require-any ${subpath(root)} ${executables} ${literal(credential)}))))`,
        `(deny file-write* (require-not (require-any ${subpath(root)} (literal "/dev/null"))))`,
        // Dynamic tools run through the CLI's own helper. Native commands and other programs stay blocked.
        `(deny process-exec (require-not (require-any ${executables})))`,
      ].join(' ');
      return await action((args) => {
        const child = spawn(sandbox, ['-p', policy, binary, ...args], {
          cwd: work,
          detached: true,
          env: { HOME: root, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', TMPDIR: root },
        });
        const closed = new Promise<number | null>((resolve) => {
          child.once('close', resolve);
          child.on('error', () => resolve(null));
        });
        child.stdin.on('error', () => {});
        children.push({ child, closed });
        return child;
      });
    } finally {
      for (const { child, closed } of children) {
        child.stdin.destroy();
        this.stop(child);
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  }

  private stop(child: ChildProcessWithoutNullStreams) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      // The Code Mode helper inherits this private process group and must stop with the turn.
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private async binary(home: string) {
    await access(sandbox, constants.X_OK).catch(() => {
      throw new Fault('CODEX_UNAVAILABLE', 503);
    });
    for (const candidate of [
      path.join(home, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ]) {
      try {
        const binary = await realpath(candidate);
        await access(binary, constants.X_OK);
        if ((await lstat(binary)).isFile()) return binary;
      } catch {
        // Continue with the next standard CLI install location.
      }
    }
    throw new Fault('CODEX_UNAVAILABLE', 503);
  }

  async check() {
    await this.launch(async (start) => {
      const version = await this.inspect(start(['--version']));
      if (!version?.split(/\r?\n/).includes(`codex-cli ${codexVersion}`))
        throw new Fault('CODEX_UNVERIFIED_VERSION', 400);
      const login = await this.inspect(start(['-c', authSetting, 'login', 'status']));
      if (!login?.split(/\r?\n/).includes('Logged in using ChatGPT'))
        throw new Fault('CODEX_LOGIN_REQUIRED', 400);
    });
  }

  private async inspect(child: ChildProcessWithoutNullStreams) {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    const output: Buffer[] = [];
    let size = 0;
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16_384) output.push(chunk);
      else child.kill('SIGKILL');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    try {
      const status = await new Promise<number | null>((resolve) => {
        child.once('close', resolve);
        child.once('error', () => resolve(null));
      });
      if (status === 0) return Buffer.concat(output).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
  }

  async run(turn: LocalTurn) {
    return this.launch(async (start) => {
      turn.run.abort.signal.throwIfAborted();
      const child = start(['app-server', '--listen', 'stdio://', '-c', authSetting]);
      child.stderr.resume();
      // A lost CLI stream must never expose child logs or private paths to the renderer.
      try {
        return await runCodexTurn({
          ...turn,
          input: child.stdout,
          output: child.stdin,
        });
      } catch (error) {
        if (error instanceof Error && /^CODEX_[A-Z_]+$/.test(error.message))
          throw new Fault(error.message);
        throw new Fault('CODEX_TURN_FAILED');
      }
    });
  }
}
