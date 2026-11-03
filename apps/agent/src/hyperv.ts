import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateVmConnection } from '@daban/engine/host';
import type { VmConnection } from '@daban/protocol';
import { type ExecutorTunnel, openExecutorTunnel, sshEnvironment } from './ssh.js';

interface RunOptions {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
}
interface Dependencies {
  run?: (program: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>;
  tunnel?: typeof openExecutorTunnel;
  port?: () => Promise<number>;
  wait?: (signal: AbortSignal) => Promise<unknown>;
}
const execute = promisify(execFile);
function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error || !address || typeof address === 'string')
          reject(new Error('EXECUTOR_PORT_UNAVAILABLE'));
        else resolve(address.port);
      });
    });
  });
}
function pause(signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('EXECUTOR_LINK_CLOSED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(undefined);
    }, 1500);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class HypervLink {
  private readonly cancellation = new AbortController();
  private tunnel?: ExecutorTunnel;
  private starting?: Promise<ExecutorTunnel['connection']>;
  private stopping?: Promise<unknown>;
  private closing?: Promise<unknown>;
  private closed = false;
  constructor(
    readonly config: VmConnection,
    private readonly directory: string,
    private readonly dependencies: Dependencies = {},
  ) {
    validateVmConnection(config);
    this.config = Object.freeze(structuredClone(config));
    if (!path.isAbsolute(directory)) throw new Error('VM_CONFIG_INVALID');
  }
  private checkOpen() {
    if (this.closed) throw new Error('EXECUTOR_LINK_CLOSED');
  }
  private async command(action: 'state' | 'start' | 'stop') {
    this.checkOpen();
    const program = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    // VM IDs are validated GUIDs. No VM names, user commands or wildcard selections reach PowerShell.
    const script = [
      "$ErrorActionPreference='Stop'",
      'Import-Module Hyper-V -ErrorAction Stop',
      `$vm = Get-VM -Id '${this.config.vmId}' -ErrorAction Stop`,
      action === 'state'
        ? "$vm | Select-Object @{Name='Id';Expression={$_.Id.ToString()}}, @{Name='State';Expression={$_.State.ToString()}} | ConvertTo-Json -Compress"
        : action === 'start'
          ? 'Start-VM -VM $vm -ErrorAction Stop | Out-Null'
          : 'Stop-VM -VM $vm -Confirm:$false -ErrorAction Stop',
    ].join('; ');
    try {
      const result = await (
        this.dependencies.run ??
        ((binary, args, options) => execute(binary, args, { ...options, encoding: 'utf8' }))
      )(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        env: sshEnvironment(),
        signal: this.cancellation.signal,
        timeout: 120000,
        windowsHide: true,
        maxBuffer: 8192,
      });
      this.checkOpen();
      return result.stdout;
    } catch {
      this.checkOpen();
      throw new Error('EXECUTOR_HYPERV_UNAVAILABLE');
    }
  }
  async state(): Promise<'running' | 'stopped' | 'unknown'> {
    this.checkOpen();
    try {
      const value: unknown = JSON.parse(await this.command('state'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('Id' in value) ||
        typeof value.Id !== 'string' ||
        value.Id.toLowerCase() !== this.config.vmId.toLowerCase() ||
        !('State' in value)
      )
        return 'unknown';
      return value.State === 'Running' ? 'running' : value.State === 'Off' ? 'stopped' : 'unknown';
    } catch {
      this.checkOpen();
      return 'unknown';
    }
  }
  private async detach() {
    const current = this.tunnel;
    this.tunnel = undefined;
    await current?.close();
  }
  private async attach(start: boolean) {
    await this.detach();
    this.checkOpen();
    const state = await this.state();
    if (!start && state !== 'running') throw new Error('EXECUTOR_OFFLINE');
    if (state === 'unknown') throw new Error('EXECUTOR_HYPERV_UNAVAILABLE');
    if (start && state === 'stopped') await this.command('start');
    const until = Date.now() + (start ? 120000 : 0);
    for (;;) {
      this.checkOpen();
      try {
        const port = await (this.dependencies.port ?? availablePort)();
        this.tunnel = await (this.dependencies.tunnel ?? openExecutorTunnel)(
          this.config,
          this.directory,
          port,
          start,
          this.cancellation.signal,
        );
        this.checkOpen();
        return this.tunnel.connection;
      } catch (error) {
        if (this.closed) {
          await this.detach();
          throw new Error('EXECUTOR_LINK_CLOSED');
        }
        if (
          !(error instanceof Error) ||
          error.message !== 'EXECUTOR_LINK_UNAVAILABLE' ||
          Date.now() >= until
        )
          throw error;
        await (this.dependencies.wait ?? pause)(this.cancellation.signal);
      }
    }
  }
  ensure(): Promise<ExecutorTunnel['connection']> {
    if (this.closed) return Promise.reject(new Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(new Error('EXECUTOR_POWER_BUSY'));
    if (this.tunnel?.alive) return Promise.resolve(this.tunnel.connection);
    this.starting ??= this.attach(true).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  reconnect(): Promise<ExecutorTunnel['connection']> {
    if (this.closed) return Promise.reject(new Error('EXECUTOR_LINK_CLOSED'));
    if (this.stopping) return Promise.reject(new Error('EXECUTOR_POWER_BUSY'));
    this.starting ??= this.attach(false).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async startVm() {
    this.checkOpen();
    await this.detach();
    return this.ensure();
  }
  stopVm() {
    this.checkOpen();
    this.stopping ??= (async () => {
      await this.starting?.catch(() => {});
      this.checkOpen();
      await this.detach();
      await this.command('stop');
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  close() {
    this.closed = true;
    this.cancellation.abort();
    // VM and Linux task lifetimes belong to the host service/recovery flow, never the UI connection.
    this.closing ??= (async () => {
      await this.starting?.catch(() => {});
      await this.detach();
    })();
    return this.closing;
  }
}
