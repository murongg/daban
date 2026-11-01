import { spawn } from 'node:child_process';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import { type DaemonConfig, daemonScope } from './daemon';
import { RuntimeClient } from './runtime';
import { readAgentToken, unixFetch } from './unix';

export class NativeDaemon {
  private readonly abort = new AbortController();
  private starting?: Promise<RuntimeClient>;
  constructor(readonly config: DaemonConfig) {}
  private client() {
    return new RuntimeClient({
      origin: 'http://127.0.0.1:8766',
      agent: true,
      tokenProvider: () => readAgentToken(this.config.dataRoot),
      fetcher: unixFetch(this.config.socketPath, {
        certificateFile: path.join(this.config.dataRoot, 'model/control-certificate.pem'),
      }),
    });
  }
  private async inspect() {
    const fetcher = unixFetch(this.config.socketPath, {
      certificateFile: path.join(this.config.dataRoot, 'model/control-certificate.pem'),
      maxBytes: 65536,
    });
    const response = await fetcher('http://127.0.0.1:8766/agent/identity', {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(1500)]),
    });
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== 'object' ||
      !('scope' in value) ||
      value.scope !== daemonScope(this.config.dataRoot, this.config.vmConfig) ||
      !('dataRoot' in value) ||
      value.dataRoot !== this.config.dataRoot ||
      !('socketPath' in value) ||
      value.socketPath !== this.config.socketPath
    )
      throw new Error('AGENT_DAEMON_SCOPE_MISMATCH');
    const client = this.client();
    if ((await client.status()).phase !== 'ready') throw new Error('AGENT_NOT_READY');
    return client;
  }
  ensure(): Promise<RuntimeClient> {
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async start() {
    await secureDirectory(this.config.dataRoot);
    this.abort.signal.throwIfAborted();
    try {
      return await this.inspect();
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_DAEMON_SCOPE_MISMATCH') throw error;
    }
    for (const file of [this.config.entry, this.config.executable]) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('AGENT_PAYLOAD_UNAVAILABLE');
    }
    await mkdir(this.config.dataRoot, { recursive: true });
    const output = await open(path.join(this.config.dataRoot, 'agent.log'), 'a', 0o600);
    try {
      const names = [
        'PATH',
        'Path',
        'SystemRoot',
        'WINDIR',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA',
        'TEMP',
        'TMP',
        'HOMEDRIVE',
        'HOMEPATH',
        'LANG',
      ];
      const env = Object.fromEntries(
        names.flatMap((name) =>
          typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : [],
        ),
      );
      const child = spawn(
        this.config.executable,
        [
          this.config.entry,
          '--data',
          this.config.dataRoot,
          '--socket',
          this.config.socketPath,
          '--vm-config',
          this.config.vmConfig,
          '--mode',
          'native',
        ],
        {
          cwd: path.dirname(this.config.entry),
          env,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', output.fd, output.fd],
        },
      );
      await new Promise<unknown>((resolve, reject) => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', reject);
      });
      child.unref();
    } finally {
      await output.close();
    }
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      this.abort.signal.throwIfAborted();
      try {
        return await this.inspect();
      } catch (error) {
        if (error instanceof Error && error.message === 'AGENT_DAEMON_SCOPE_MISMATCH') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('AGENT_NATIVE_UNAVAILABLE');
  }
  async close() {
    this.abort.abort();
  }
}
