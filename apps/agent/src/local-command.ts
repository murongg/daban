import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { HostCommandRequest } from '@daban/engine/agent';

type CommandResult = {
  isError?: boolean;
  content: { type: 'text'; text: string }[];
};
export type LocalSandboxAdapter = Pick<
  typeof import('@anthropic-ai/sandbox-runtime').SandboxManager,
  'initialize' | 'wrapWithSandboxArgv' | 'reset'
>;
interface Options {
  manager?: LocalSandboxAdapter;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  outputLimit?: number;
}
class LocalCommandFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const within = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root + path.sep);
const failure = (code: string): CommandResult => ({
  isError: true,
  content: [{ type: 'text', text: code }],
});
let sandboxTail: Promise<unknown> = Promise.resolve();
// The sandbox manager is process-global, so commands from separate runners must not overlap.
function serialize<T>(work: () => Promise<T>) {
  const operation = sandboxTail.then(work, work);
  sandboxTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
async function platformManager(): Promise<LocalSandboxAdapter> {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  return SandboxManager;
}
async function existingDirectories(values: string[]) {
  const directories: string[] = [];
  for (const value of values) {
    const resolved = await realpath(value).catch(() => undefined);
    if (!resolved) continue;
    const info = await lstat(resolved).catch(() => undefined);
    if (info?.isDirectory() && !info.isSymbolicLink()) directories.push(resolved);
  }
  return directories;
}
function systemPaths(platform: NodeJS.Platform) {
  return platform === 'darwin'
    ? ['/System', '/usr', '/bin', '/sbin', '/opt/homebrew']
    : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
}
function environment(platform: NodeJS.Platform, temporary: string): NodeJS.ProcessEnv {
  return {
    PATH:
      platform === 'darwin'
        ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
        : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: temporary,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}
async function validatePaths(request: HostCommandRequest) {
  if (
    !path.isAbsolute(request.root) ||
    !path.isAbsolute(request.cwd) ||
    request.root === path.parse(request.root).root ||
    !within(request.root, request.cwd)
  )
    throw new LocalCommandFailure('LOCAL_PATH_DENIED');
  let root: string;
  let cwd: string;
  let rootInfo: Awaited<ReturnType<typeof lstat>>;
  let cwdInfo: Awaited<ReturnType<typeof lstat>>;
  let home: string;
  try {
    [root, cwd, rootInfo, cwdInfo, home] = await Promise.all([
      realpath(request.root),
      realpath(request.cwd),
      lstat(request.root),
      lstat(request.cwd),
      realpath(homedir()),
    ]);
  } catch {
    throw new LocalCommandFailure('LOCAL_PATH_DENIED');
  }
  if (
    root !== request.root ||
    cwd !== request.cwd ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !cwdInfo.isDirectory() ||
    cwdInfo.isSymbolicLink() ||
    root === home ||
    !within(root, cwd)
  )
    throw new LocalCommandFailure('LOCAL_PATH_DENIED');
  return { root, cwd };
}

export class LocalCommandRunner {
  constructor(private readonly options: Options = {}) {}

  run(request: HostCommandRequest, signal: AbortSignal): Promise<CommandResult> {
    return serialize(async () => {
      try {
        return await this.execute(request, signal);
      } catch (error) {
        if (signal.aborted) throw new LocalCommandFailure('LOCAL_COMMAND_CANCELLED');
        return failure(
          error instanceof LocalCommandFailure ? error.code : 'LOCAL_COMMAND_SANDBOX_UNAVAILABLE',
        );
      }
    });
  }

  private async execute(request: HostCommandRequest, signal: AbortSignal) {
    const platform = this.options.platform ?? process.platform;
    if (!['darwin', 'linux'].includes(platform))
      throw new LocalCommandFailure('LOCAL_COMMAND_SANDBOX_UNAVAILABLE');
    if (
      typeof request.command !== 'string' ||
      !request.command.trim() ||
      request.command.length > 12000 ||
      request.command.includes('\0')
    )
      throw new LocalCommandFailure('COMMAND_INVALID_REQUEST');
    signal.throwIfAborted();
    const { root, cwd } = await validatePaths(request);
    const temporary = await mkdtemp(path.join(tmpdir(), 'daban-command-'));
    let manager: LocalSandboxAdapter | undefined;
    let initializationAttempted = false;
    try {
      const privateTemporary = await realpath(temporary);
      const safeSystemPaths = await existingDirectories(systemPaths(platform));
      const config: SandboxRuntimeConfig = {
        network: {
          allowedDomains: [],
          deniedDomains: ['*'],
          strictAllowlist: true,
          allowUnixSockets: [],
          allowLocalBinding: false,
        },
        filesystem: {
          denyRead: ['/'],
          allowRead: [...safeSystemPaths, root, privateTemporary],
          allowWrite: [root, privateTemporary],
          denyWrite: [],
        },
      };
      manager = this.options.manager ?? (await platformManager());
      // Initialization may start shared proxy state before it rejects; reset every attempted init.
      initializationAttempted = true;
      await manager.initialize(config);
      const wrapped = await manager.wrapWithSandboxArgv(
        request.command,
        '/bin/bash',
        undefined,
        signal,
        cwd,
        { commandId: randomUUID() },
      );
      signal.throwIfAborted();
      if (!wrapped.argv.length || !path.isAbsolute(wrapped.argv[0]))
        throw new LocalCommandFailure('LOCAL_COMMAND_SANDBOX_UNAVAILABLE');
      return await this.process(wrapped.argv, cwd, environment(platform, privateTemporary), signal);
    } finally {
      try {
        if (initializationAttempted) await manager?.reset();
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }

  private process(
    argv: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const timeoutMs = this.options.timeoutMs ?? 120000;
    const outputLimit = this.options.outputLimit ?? 65536;
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd,
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        reject(new LocalCommandFailure('LOCAL_COMMAND_SANDBOX_UNAVAILABLE'));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let outputLimited = false;
      let stopping = false;
      let spawnError: Error | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const stop = () => {
        // Timeout, cancellation, and output overflow may race into this same cleanup path.
        if (stopping) return;
        stopping = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          escalation = setTimeout(() => {
            if (child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            }
          }, 2000);
        } else child.kill('SIGTERM');
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const cancelled = () => stop();
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) stop();
      const capture = (target: Buffer[], chunk: Buffer) => {
        if (bytes + chunk.length > outputLimit) {
          outputLimited = true;
          stop();
          return;
        }
        bytes += chunk.length;
        target.push(chunk);
      };
      child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (escalation) clearTimeout(escalation);
        signal.removeEventListener('abort', cancelled);
        if (signal.aborted) reject(new LocalCommandFailure('LOCAL_COMMAND_CANCELLED'));
        else if (timedOut) resolve(failure('LOCAL_COMMAND_TIMEOUT'));
        else if (outputLimited) resolve(failure('LOCAL_COMMAND_OUTPUT_LIMIT'));
        else if (spawnError) reject(new LocalCommandFailure('LOCAL_COMMAND_SANDBOX_UNAVAILABLE'));
        else
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  exitCode: code,
                  stdout: Buffer.concat(stdout).toString('utf8'),
                  stderr: Buffer.concat(stderr).toString('utf8'),
                }),
              },
            ],
          });
      });
    });
  }
}
