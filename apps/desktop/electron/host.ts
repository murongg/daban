import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  type DiagnosticCheck,
  type DiagnosticReport,
  diagnosticIds,
  isDiagnosticReport,
  type RecoveryRequest,
} from '@daban/protocol';
import { availablePort } from './ports';
import { Reboot } from './reboot';
import { RuntimeClient } from './runtime';
import { controlSocket, prepareSocket, socketReady } from './socket';

export interface HostConfig {
  limactl: string;
  limaHome: string;
  vm: string;
  port: number;
}
type Execute = (
  program: string,
  args: string[],
  options?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr?: string }>;
type Probe = (
  program: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal: AbortSignal; timeout: number; maxBuffer: number },
) => Promise<{ code: number; stdout: string }>;
const probe: Probe = (program, args, options) =>
  new Promise((resolve, reject) => {
    execFile(program, args, { ...options, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(new Error('RUNTIME_PROBE_FAILED'));
      else resolve({ code: error ? Number(error.code) : 0, stdout });
    });
  });
export async function readControlToken(
  config: HostConfig,
  socket: string,
  run: Probe,
  signal: AbortSignal,
) {
  const file = '/var/lib/bot-prototype/model/control-token';
  const command = `if [ ! -e ${file} ] && [ ! -L ${file} ]; then exit 44; fi; if [ ! -f ${file} ] || [ -L ${file} ]; then exit 43; fi; exec /bin/cat ${file}`;
  const result = await run(
    'ssh',
    [
      '-F',
      join(config.limaHome, config.vm, 'ssh.config'),
      '-S',
      socket,
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ConnectTimeout=5',
      `lima-${config.vm}`,
      'sudo',
      '-n',
      '-u',
      'bot-prototype',
      '--',
      '/bin/sh',
      '-c',
      `'${command}'`,
    ],
    { env: { ...process.env, LIMA_HOME: config.limaHome }, signal, timeout: 8000, maxBuffer: 1024 },
  );
  signal.throwIfAborted();
  if (result.code === 44) return undefined;
  if (result.code !== 0 || !/^[a-f0-9]{64}\n?$/.test(result.stdout))
    throw new Error('RUNTIME_AUTH_UNAVAILABLE');
  return result.stdout.trim();
}
export const execute: Execute = (program, args, options = {}) =>
  new Promise((resolve, reject) => {
    // A daemonized SSH master must not retain execFile's output pipes and keep startup pending.
    const child = spawn(program, args, { ...options, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve({ stdout: '' }) : reject(new Error('RUNTIME_HOST_COMMAND_FAILED')),
    );
  });
export function validateHost(value: unknown): HostConfig {
  if (!value || typeof value !== 'object') throw new Error('RUNTIME_NOT_CONFIGURED');
  const v = value as HostConfig;
  if (
    typeof v.limactl !== 'string' ||
    !isAbsolute(v.limactl) ||
    basename(v.limactl) !== 'limactl' ||
    typeof v.limaHome !== 'string' ||
    !isAbsolute(v.limaHome) ||
    !v.vm ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(v.vm) ||
    !Number.isInteger(v.port) ||
    v.port < 1024 ||
    v.port > 65535
  )
    throw new Error('INVALID_HOST_CONFIG');
  return v;
}
export async function loadHost(file: string, socket: string) {
  return new ManagedHost(validateHost(JSON.parse(await readFile(file, 'utf8'))), socket);
}
function hostTarget(config: HostConfig) {
  return createHash('sha256')
    .update(JSON.stringify([config.limactl, config.limaHome, config.vm, config.port]))
    .digest('hex');
}
export class ManagedHost {
  private readonly execute: Execute;
  private readonly probe: Probe;
  private readonly factory: (origin: string) => RuntimeClient;
  private readonly reboot: Reboot;
  private readonly controlPath: string;
  private client?: RuntimeClient;
  private starting?: Promise<RuntimeClient>;
  private attaching?: Promise<RuntimeClient>;
  private checking?: Promise<DiagnosticReport>;
  private tunnelOwned = false;
  private readonly cancellation = new AbortController();
  private closed = false;
  constructor(
    readonly config: HostConfig,
    readonly socket: string,
    dependencies: {
      exec?: Execute;
      probe?: Probe;
      client?: (origin: string) => RuntimeClient;
    } = {},
  ) {
    validateHost(config);
    const target = hostTarget(config);
    this.controlPath = controlSocket(socket, target);
    this.execute = dependencies.exec || execute;
    this.probe = dependencies.probe || probe;
    this.factory =
      dependencies.client ||
      ((origin) =>
        new RuntimeClient({
          origin,
          serverOrigin: 'http://127.0.0.1:8766',
          tokenProvider: async () => {
            await this.checkControl();
            this.cancellation.signal.throwIfAborted();
            return readControlToken(config, this.controlPath, this.probe, this.cancellation.signal);
          },
        }));
    this.reboot = new Reboot({
      // Recovery is durable app data; shortening the transport must not move or forget its journal.
      file: join(dirname(socket), 'runtime-recovery.json'),
      target,
      driver: {
        review: async () => (await this.recoveryClient()).recoveryReview(),
        prepare: async (request) => (await this.recoveryClient()).prepareRecovery(request),
        claim: async (request) => (await this.recoveryClient()).claimRecovery(request),
        receipt: async (id) => (await this.recoveryClient()).receiptRecovery(id),
        cancel: async (request) => (await this.recoveryClient()).cancelRecovery(request),
        vm: () => this.vmState(),
        stop: () =>
          this.execute(config.limactl, ['stop', '--tty=false', config.vm], {
            env: { ...process.env, LIMA_HOME: config.limaHome },
            timeout: 120000,
            maxBuffer: 512 * 1024,
            signal: this.cancellation.signal,
          }),
        start: () => this.launch(),
      },
    });
  }
  get connection() {
    return this.client;
  }
  async recoveryStatus() {
    await this.reboot.ready;
    return this.reboot.status();
  }
  async recoveryReview() {
    await this.reboot.ready;
    return (await this.recoveryClient()).recoveryReview();
  }
  async recover(request: RecoveryRequest) {
    await this.reboot.ready;
    if (this.starting || this.attaching) throw new Error('RECOVERY_BUSY');
    return this.reboot.restart(request);
  }
  async inspectRecovery(id: string) {
    await this.reboot.ready;
    if (this.starting) throw new Error('RECOVERY_BUSY');
    return this.reboot.inspect(id);
  }
  async cancelRecovery(id: string) {
    await this.reboot.ready;
    return this.reboot.cancel(id);
  }
  async startRecovery(id: string) {
    await this.reboot.ready;
    if (this.starting) throw new Error('RECOVERY_BUSY');
    return this.reboot.start(id);
  }
  async connectExisting() {
    return this.recoveryClient();
  }
  async portConflict() {
    if (this.closed) throw new Error('RUNTIME_CLOSED');
    await this.checkControl();
    const result = await this.probe(
      'ssh',
      [
        '-F',
        join(this.config.limaHome, this.config.vm, 'ssh.config'),
        '-S',
        this.controlPath,
        '-O',
        'check',
        `lima-${this.config.vm}`,
      ],
      {
        env: { ...process.env, LIMA_HOME: this.config.limaHome },
        signal: this.cancellation.signal,
        timeout: 8000,
        maxBuffer: 1024,
      },
    );
    this.cancellation.signal.throwIfAborted();
    // A reachable private master may still own the forwarding port; retain it on uncertainty.
    if (result.code !== 255 || !(await this.controlAbsent())) return false;
    const candidate = await availablePort(this.config.port);
    this.cancellation.signal.throwIfAborted();
    return candidate !== this.config.port;
  }
  private async controlAbsent() {
    return new Promise<boolean>((resolve) => {
      const channel = net.createConnection(this.controlPath);
      const finish = (absent: boolean) => {
        channel.destroy();
        this.cancellation.signal.removeEventListener('abort', aborted);
        resolve(absent);
      };
      const aborted = () => finish(false);
      // Failed ssh output alone cannot distinguish a missing endpoint from denied access.
      channel.once('connect', () => finish(false));
      channel.once('error', (error: NodeJS.ErrnoException) =>
        finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'),
      );
      channel.setTimeout(1000, () => finish(false));
      this.cancellation.signal.addEventListener('abort', aborted, { once: true });
      if (this.cancellation.signal.aborted) aborted();
    });
  }
  private async recoveryClient() {
    if (this.closed) throw new Error('RUNTIME_CLOSED');
    let client = this.client;
    let state = client ? await client.status() : undefined;
    if (state?.phase !== 'ready') {
      if ((await this.vmState()) !== 'running') throw new Error('RUNTIME_OFFLINE');
      client = await this.attach();
      state = await client.status();
    }
    if (!client || state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
    if (state.protocolVersion < 24) throw new Error('RUNTIME_TOO_OLD');
    return client;
  }
  private async vmState(): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const result = await this.probe(
        this.config.limactl,
        ['list', '--format=json', this.config.vm],
        {
          env: { ...process.env, LIMA_HOME: this.config.limaHome },
          signal: this.cancellation.signal,
          timeout: 8000,
          maxBuffer: 64 * 1024,
        },
      );
      this.cancellation.signal.throwIfAborted();
      const values = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
      const value = values[0];
      if (
        result.code !== 0 ||
        values.length !== 1 ||
        !value ||
        typeof value !== 'object' ||
        !('name' in value) ||
        value.name !== this.config.vm ||
        !('status' in value)
      )
        return 'unknown';
      return value.status === 'Running'
        ? 'running'
        : value.status === 'Stopped'
          ? 'stopped'
          : 'unknown';
    } catch {
      this.cancellation.signal.throwIfAborted();
      return 'unknown';
    }
  }
  inspect(): Promise<DiagnosticReport> {
    if (this.closed) return Promise.reject(new Error('RUNTIME_CLOSED'));
    this.checking ??= this.inspectHost().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }
  private async inspectHost(): Promise<DiagnosticReport> {
    const checks: DiagnosticCheck[] = [...diagnosticIds.host, ...diagnosticIds.runtime].map(
      (id) => ({ id, state: 'unchecked' }),
    );
    const set = (id: DiagnosticCheck['id'], state: DiagnosticCheck['state']) => {
      checks.find((row) => row.id === id)!.state = state;
    };
    const report = (): DiagnosticReport => ({
      scope: 'host',
      checkedAt: new Date().toISOString(),
      checks,
    });
    const c = this.config;
    set('configuration', 'ready');
    const options = {
      env: { ...process.env, LIMA_HOME: c.limaHome },
      signal: this.cancellation.signal,
      timeout: 8000,
      maxBuffer: 64 * 1024,
    };
    if ((await this.vmState()) !== 'running') {
      set('vm', 'unavailable');
      return report();
    }
    set('vm', 'ready');
    let owned = true;
    if (this.controlPath !== this.socket) {
      try {
        owned = await socketReady(this.controlPath);
      } catch {
        owned = false;
      }
    }
    const ssh = [
      '-F',
      join(c.limaHome, c.vm, 'ssh.config'),
      '-S',
      owned ? this.controlPath : 'none',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
    ];
    try {
      const tunnel = owned
        ? await this.probe('ssh', [...ssh, '-O', 'check', `lima-${c.vm}`], options)
        : undefined;
      set('tunnel', tunnel?.code === 0 ? 'ready' : 'unavailable');
    } catch {
      set('tunnel', 'unavailable');
    }
    this.cancellation.signal.throwIfAborted();
    try {
      const service = await this.probe(
        'ssh',
        [
          ...ssh,
          '-o',
          'ControlMaster=no',
          `lima-${c.vm}`,
          'systemctl',
          'is-active',
          'bot-browser.service',
        ],
        options,
      );
      set(
        'service',
        service.code === 0 && service.stdout.trim() === 'active'
          ? 'ready'
          : [3, 4].includes(service.code)
            ? 'unavailable'
            : 'unchecked',
      );
    } catch {
      set('service', 'unchecked');
    }
    this.cancellation.signal.throwIfAborted();
    // A local port alone is not evidence that it belongs to this configured VM's tunnel.
    if (checks.find((row) => row.id === 'tunnel')!.state !== 'ready') return report();
    this.client ??= this.factory(`http://127.0.0.1:${c.port}`);
    const client = this.client;
    const status = await client.status();
    this.cancellation.signal.throwIfAborted();
    if (status.phase !== 'ready') {
      set('agent', 'unavailable');
      return report();
    }
    set('agent', 'ready');
    if (status.protocolVersion < 23) {
      for (const id of diagnosticIds.runtime) if (id !== 'agent') set(id, 'unsupported');
      return report();
    }
    try {
      const backend = await client.invoke({ type: 'runtime.inspect' });
      if (!isDiagnosticReport(backend) || backend.scope !== 'runtime')
        throw new Error('INVALID_RUNTIME_STATE');
      checks.splice(diagnosticIds.host.length, diagnosticIds.runtime.length, ...backend.checks);
    } catch {
      for (const id of diagnosticIds.runtime) if (id !== 'agent') set(id, 'unchecked');
    }
    this.cancellation.signal.throwIfAborted();
    return report();
  }
  private async checkControl() {
    if (this.controlPath !== this.socket && !(await socketReady(this.controlPath)))
      throw new Error('RUNTIME_CONTROL_PATH_UNAVAILABLE');
  }
  private async prepareControl() {
    if (this.controlPath !== this.socket) await prepareSocket(this.controlPath);
  }
  private async ssh(args: string[], cleanup = false) {
    await this.checkControl();
    if (!cleanup) this.cancellation.signal.throwIfAborted();
    return this.execute(
      'ssh',
      [
        '-F',
        join(this.config.limaHome, this.config.vm, 'ssh.config'),
        '-S',
        this.controlPath,
        ...args,
        `lima-${this.config.vm}`,
      ],
      {
        timeout: 20000,
        maxBuffer: 256 * 1024,
        signal: cleanup ? undefined : this.cancellation.signal,
      },
    );
  }
  async connect(): Promise<RuntimeClient> {
    if (this.closed) throw new Error('RUNTIME_CLOSED');
    await this.reboot.ready;
    if (this.reboot.pending()) {
      const status = this.reboot.status();
      if (status.available && status.busy) throw new Error('RECOVERY_BUSY');
      const vm = await this.vmState();
      if (vm === 'stopped') throw new Error('RECOVERY_NEEDS_START');
      if (vm !== 'running') throw new Error('RUNTIME_OFFLINE');
      return this.attach();
    }
    return this.launch();
  }
  private launch(): Promise<RuntimeClient> {
    if (this.closed) return Promise.reject(new Error('RUNTIME_CLOSED'));
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async start() {
    await this.prepareControl();
    // Directory IO may finish after the owner closes; never start late work with an already-aborted signal.
    this.cancellation.signal.throwIfAborted();
    const c = this.config;
    const options = {
      env: { ...process.env, LIMA_HOME: c.limaHome },
      timeout: 120000,
      maxBuffer: 512 * 1024,
      signal: this.cancellation.signal,
    };
    await this.execute(c.limactl, ['start', '--tty=false', c.vm], options);
    await this.execute(
      c.limactl,
      ['shell', c.vm, 'sudo', 'systemctl', 'start', 'bot-browser.service'],
      options,
    );
    return this.attach();
  }
  private attach(): Promise<RuntimeClient> {
    if (this.closed) return Promise.reject(new Error('RUNTIME_CLOSED'));
    this.attaching ??= this.openTunnel().finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }
  private async openTunnel() {
    await this.prepareControl();
    const c = this.config;
    let existing = false;
    try {
      await this.ssh(['-O', 'check']);
      existing = true;
    } catch {
      /* A prior client crash may leave no master; only this private socket may be adopted. */
    }
    this.client = this.factory(`http://127.0.0.1:${c.port}`);
    if (existing && (await this.client.status()).phase !== 'ready') {
      await this.ssh(['-O', 'exit']).catch(() => {});
      existing = false;
    }
    this.cancellation.signal.throwIfAborted();
    if (!existing)
      await this.ssh([
        '-M',
        '-o',
        'ControlMaster=yes',
        '-o',
        'ControlPersist=no',
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-fNT',
        '-L',
        `127.0.0.1:${c.port}:127.0.0.1:8766`,
      ]);
    this.tunnelOwned = true;
    const deadline = Date.now() + 20000;
    do {
      this.cancellation.signal.throwIfAborted();
      if ((await this.client.status()).phase === 'ready') return this.client;
      await new Promise((resolve) => setTimeout(resolve, 350));
    } while (Date.now() < deadline);
    throw new Error('RUNTIME_NOT_READY');
  }
  abort() {
    this.closed = true;
    this.cancellation.abort();
    this.reboot.abort();
  }
  async close() {
    // The guest worker owns the task. Closing Electron releases only its tunnel, never the VM or model job.
    const starting = this.starting;
    this.abort();
    await this.reboot.close();
    await starting?.catch(() => {});
    await this.attaching?.catch(() => {});
    await this.checking?.catch(() => {});
    if (this.tunnelOwned || starting) {
      await this.ssh(['-O', 'exit'], true).catch(() => {});
      this.tunnelOwned = false;
    }
  }
}
