import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type AgentOptions,
  type Executor,
  LocalComputerClient,
  mcpStdioEntry,
  startAgent,
  startNativeAgent,
} from '@daban/engine/agent';
import { readVmConnection, vmConnectionTarget } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import type {
  ExecutionSnapshot,
  RebootStatus,
  RecoveryReview,
  RuntimeCommand,
  VmConnection,
} from '@daban/protocol';
import { type BootstrapOptions, bootstrapAgent, writeSetupRecord } from './bootstrap.js';
import { ExecutionConnection } from './connection.js';
import { Environment } from './environment.js';
import { startupErrorCode, writeStartupFailure } from './failure.js';
import { HypervLink } from './hyperv.js';
import { linuxAssets } from './linux.js';
import { HostPower, type PowerOptions } from './power.js';
import { QemuLink } from './qemu.js';
import { QemuSetup } from './qemu-setup.js';
import { resolveSdk } from './sdk.js';
import {
  assertSetupRunning,
  isWorkspaceRoot,
  readStartupPolicy,
  saveExecutionSnapshot,
} from './startup.js';
import { ensureLima } from './tools.js';
import { type VmConfig, VmLink } from './vm.js';

export interface AgentArguments {
  dataRoot: string;
  socketPath: string;
  vmConfigFile: string;
  mode?: 'native';
  qemuBundle?: string;
}
interface Assets {
  packDirectory: string;
  executorArchive: string;
  sourceHelper: string;
  restoreHelper: string;
  limaArchive?: string;
  limaDigest?: string;
}
type Link = Pick<VmLink, 'ensure' | 'reconnect' | 'state' | 'startVm' | 'stopVm' | 'close'>;
interface Connection extends Executor {
  readonly connected: boolean;
  rebind(connection?: { origin: string; token: string }): Promise<ExecutionSnapshot>;
  close(): Promise<unknown>;
}
type Recovery = NonNullable<Awaited<ReturnType<typeof startAgent>>['recovery']>;
interface Core {
  recovery?: Pick<Recovery, 'review' | 'prepare' | 'claim' | 'cancel' | 'receipt'>;
  models: {
    jobs: { values(): IterableIterator<{ bot: string; running: boolean }> };
    stop(bot: string, reason?: string): Promise<unknown>;
  };
  refreshExecution(): Promise<ExecutionSnapshot>;
  close(): Promise<unknown>;
}
interface Power {
  ready: Promise<unknown>;
  status(): RebootStatus;
  handle(command: RuntimeCommand): Promise<RebootStatus | RecoveryReview>;
  close(): Promise<unknown>;
}
export interface MainDependencies {
  platform?: NodeJS.Platform;
  hyperv?: (config: VmConnection, directory: string) => Link;
  qemu?: (config: VmConnection, directory: string) => Link;
  native?: (
    options: Parameters<typeof startNativeAgent>[0],
  ) => Promise<{ close(): Promise<unknown> }>;
  tools(options: {
    dataRoot: string;
    vmConfigFile: string;
    packDirectory: string;
    archive?: string;
    digest?: string;
  }): Promise<string>;
  bootstrap(options: BootstrapOptions): Promise<VmConfig>;
  link(config: VmConfig, socketPath: string): Link;
  connection(
    link: Link,
    options: { attachOnly: boolean; initialSnapshot?: ExecutionSnapshot },
  ): Connection;
  power(options: PowerOptions): Power;
  core(options: AgentOptions): Promise<Core>;
  sdk(): string;
  assets?: Assets;
}
const dependencies: MainDependencies = {
  tools: ensureLima,
  bootstrap: bootstrapAgent,
  link: (config, socketPath) => new VmLink(config, socketPath),
  connection: (link, options) => new ExecutionConnection(link, options),
  power: (options) => new HostPower(options),
  core: startAgent,
  sdk: () => resolveSdk(import.meta.url),
};
export function parseAgentArguments(args: string[]): AgentArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (
      !['--data', '--socket', '--vm-config', '--mode', '--qemu-bundle'].includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith('--') ||
      /[\r\n]/.test(value) ||
      value.includes('\0')
    )
      throw new Error('AGENT_ARGUMENTS_INVALID');
    if (flag === '--mode' && value !== 'native') throw new Error('AGENT_ARGUMENTS_INVALID');
    values.set(flag, flag === '--mode' ? value : path.resolve(value));
  }
  if (
    ![3, 4, 5].includes(values.size) ||
    !values.has('--data') ||
    !values.has('--socket') ||
    !values.has('--vm-config')
  )
    throw new Error('AGENT_ARGUMENTS_INVALID');
  return {
    dataRoot: values.get('--data')!,
    socketPath: values.get('--socket')!,
    vmConfigFile: values.get('--vm-config')!,
    ...(values.has('--mode') ? { mode: 'native' as const } : {}),
    ...(values.has('--qemu-bundle') ? { qemuBundle: values.get('--qemu-bundle')! } : {}),
  };
}
export function agentScope(dataRoot: string, configFile: string) {
  return createHash('sha256')
    .update(JSON.stringify([path.resolve(dataRoot), path.resolve(configFile)]))
    .digest('hex');
}
export function agentVmTarget(config: VmConfig) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        path.resolve(config.limactl),
        path.resolve(config.limaHome),
        config.vm,
        config.port,
      ]),
    )
    .digest('hex');
}
async function assets(dataRoot: string, signal?: AbortSignal): Promise<Assets> {
  // Drain queued progress writes before bootstrap or pause can publish a newer phase.
  let progressWrites: Promise<unknown> = Promise.resolve();
  let payload: Awaited<ReturnType<typeof linuxAssets>>;
  try {
    payload = await linuxAssets({
      dataRoot,
      entryDirectory: fileURLToPath(new URL('.', import.meta.url)),
      signal,
      progress: ({ received, total }) => {
        progressWrites = progressWrites
          .then(() =>
            writeSetupRecord(path.join(dataRoot, 'progress.json'), {
              required: true,
              target: 'linux',
              phase: 'downloading',
              downloaded: received,
              total,
              progress: Math.floor((received / total) * 100),
            }),
          )
          .catch(() => console.error('Linux download progress could not be saved'));
      },
    });
  } finally {
    await progressWrites;
  }
  return {
    ...payload,
    sourceHelper: fileURLToPath(new URL('./source-reader.mjs', import.meta.url)),
    restoreHelper: fileURLToPath(new URL('./restore-worker.mjs', import.meta.url)),
  };
}
async function executionTarget(
  options: AgentArguments,
  factory: MainDependencies,
  signal?: AbortSignal,
) {
  if ((factory.platform ?? process.platform) === 'win32') {
    await secureDirectory(options.dataRoot);
    const config = await readVmConnection(options.vmConfigFile);
    if (!config?.enabled) throw new Error('EXECUTOR_VM_NOT_CONFIGURED');
    signal?.throwIfAborted();
    return {
      target: vmConnectionTarget(config),
      link:
        config.provider === 'qemu'
          ? (factory.qemu?.(config, options.dataRoot) ?? new QemuLink(config, options.dataRoot))
          : (factory.hyperv?.(config, options.dataRoot) ??
            new HypervLink(config, options.dataRoot)),
    };
  }
  const payload = factory.assets ?? (await assets(options.dataRoot, signal));
  const limactl = await factory.tools({
    dataRoot: options.dataRoot,
    vmConfigFile: options.vmConfigFile,
    packDirectory: payload.packDirectory,
    archive: payload.limaArchive,
    digest: payload.limaDigest,
  });
  signal?.throwIfAborted();
  const config = await factory.bootstrap({
    ...payload,
    dataRoot: options.dataRoot,
    vmConfigFile: options.vmConfigFile,
    limactl,
    signal,
  });
  signal?.throwIfAborted();
  return {
    target: agentVmTarget(config),
    link: factory.link(config, path.join(options.dataRoot, 'executor-tunnel.sock')),
  };
}
export async function startAgentProcess(
  options: AgentArguments,
  factory: MainDependencies = dependencies,
  signal?: AbortSignal,
  onUpdate?: () => unknown,
) {
  if (options.mode === 'native') {
    const scope = agentScope(options.dataRoot, options.vmConfigFile);
    const environment =
      (factory.platform ?? process.platform) === 'darwin'
        ? new Environment({
            dataRoot: options.dataRoot,
            vmConfigFile: options.vmConfigFile,
            prepare: async (installSignal) => {
              const payload = factory.assets ?? (await assets(options.dataRoot, installSignal));
              const limactl = await factory.tools({
                dataRoot: options.dataRoot,
                vmConfigFile: options.vmConfigFile,
                packDirectory: payload.packDirectory,
                archive: payload.limaArchive,
                digest: payload.limaDigest,
              });
              installSignal.throwIfAborted();
              return factory.bootstrap({ ...payload, ...options, limactl, signal: installSignal });
            },
          })
        : (factory.platform ?? process.platform) === 'win32'
          ? new QemuSetup({
              dataRoot: options.dataRoot,
              vmConfigFile: options.vmConfigFile,
              // Windows startup must remain independent of the Mac-only download manifest.
              bundleDirectory:
                options.qemuBundle ??
                path.join(
                  factory.assets?.packDirectory ??
                    fileURLToPath(new URL('../environment', import.meta.url)),
                  'qemu',
                ),
            })
          : undefined;
    const native = await (factory.native ?? startNativeAgent)({
      environment,
      identity: {
        dataRoot: options.dataRoot,
        socketPath: options.socketPath,
        entry: fileURLToPath(import.meta.url),
        executable: process.execPath,
      },
      onUpdate,
      dataRoot: options.dataRoot,
      socketPath: options.socketPath,
      scope,
      sdkFile: factory.sdk(),
      stdioEntry: mcpStdioEntry,
      nativeWorkspace: path.join(options.dataRoot, 'workspace'),
      localComputer: new LocalComputerClient(options.dataRoot),
    });
    // Only the process that acquired the private server may resume an interrupted installer.
    await environment?.resumePending();
    return {
      scope,
      close: async () => {
        await environment?.close();
        await native.close();
      },
    };
  }
  let link: Link | undefined,
    connection: Connection | undefined,
    power: Power | undefined,
    core: Core | undefined;
  let closing: Promise<unknown> | undefined;
  const close = () => {
    closing ??= (async () => {
      let failure: unknown;
      for (const owner of [power, core, connection ?? link]) {
        try {
          await owner?.close();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    })();
    return closing;
  };
  const currentRecovery = () => {
    if (!core?.recovery) throw new Error('AGENT_NOT_READY');
    return core.recovery;
  };
  const stopModels = async (reason: string) => {
    if (core)
      await Promise.all(
        [...core.models.jobs.values()]
          .filter((job) => job.running)
          .map((job) => core!.models.stop(job.bot, reason)),
      );
  };
  try {
    signal?.throwIfAborted();
    if ((factory.platform ?? process.platform) === 'win32') await secureDirectory(options.dataRoot);
    await assertSetupRunning(options.dataRoot);
    const prepared = await executionTarget(options, factory, signal);
    link = prepared.link;
    const target = prepared.target,
      scope = agentScope(options.dataRoot, options.vmConfigFile);
    const powerFile = path.join(options.dataRoot, 'host-recovery.json'),
      cacheFile = path.join(options.dataRoot, 'execution-snapshot.json');
    const policy = await readStartupPolicy({ target, powerFile, cacheFile });
    connection = factory.connection(link, {
      attachOnly: policy.attachOnly,
      ...(policy.attachOnly && policy.initialSnapshot
        ? { initialSnapshot: policy.initialSnapshot }
        : {}),
    });
    power = factory.power({
      file: powerFile,
      target,
      driver: {
        review: async () => {
          await core?.refreshExecution();
          return currentRecovery().review();
        },
        prepare: async (request) => {
          await core?.refreshExecution();
          return currentRecovery().prepare(request);
        },
        claim: async (binding) => {
          await core?.refreshExecution();
          return currentRecovery().claim(binding.id, binding.revision + 1);
        },
        cancel: async (binding) => currentRecovery().cancel(binding.id, binding.revision + 1),
        receipt: async (id) => {
          await core?.refreshExecution();
          return currentRecovery().receipt(id);
        },
        vm: () => link!.state(),
        stop: () => link!.stopVm(),
        start: async () => {
          const next = await link!.startVm();
          await connection!.rebind(next);
          if (!core) throw new Error('AGENT_NOT_READY');
          await core.refreshExecution();
        },
      },
      beforeStop: async () => {
        const status = power!.status();
        if (
          !status.available ||
          status.operation?.stage !== 'stop-issued' ||
          status.operation.backend?.phase !== 'claimed'
        )
          throw new Error('RECOVERY_STOP_NOT_CLAIMED');
        await stopModels('vm-restart');
      },
    });
    await power.ready;
    const powerState = power.status();
    if (!powerState.available) throw new Error(powerState.error);
    let snapshot: ExecutionSnapshot;
    try {
      snapshot = await connection.ready;
    } catch (error) {
      if (policy.attachOnly && !policy.initialSnapshot)
        throw new Error('AGENT_RECOVERY_CACHE_REQUIRED');
      throw error;
    }
    signal?.throwIfAborted();
    let workspaceRoot = policy.workspaceRoot;
    if (connection.connected) {
      const actual = await connection.call('workspace.base', {});
      if (!isWorkspaceRoot(actual) || (workspaceRoot && actual !== workspaceRoot))
        throw new Error('AGENT_WORKSPACE_CHANGED');
      workspaceRoot = actual;
    }
    if (!workspaceRoot) throw new Error('AGENT_RECOVERY_CACHE_REQUIRED');
    const root = workspaceRoot;
    await saveExecutionSnapshot({ file: cacheFile, target, snapshot, workspaceRoot: root });
    const execution: Executor = {
      ready: Promise.resolve(snapshot),
      get snapshot() {
        return connection!.snapshot;
      },
      call: (method, params, callSignal) => connection!.call(method, params, callSignal),
      refresh: async () => {
        const next = await connection!.refresh();
        const actual = await connection!.call('workspace.base', {});
        if (actual !== root) {
          await stopModels('workspace-changed');
          throw new Error('AGENT_WORKSPACE_CHANGED');
        }
        await saveExecutionSnapshot({
          file: cacheFile,
          target,
          snapshot: next,
          workspaceRoot: root,
        });
        return next;
      },
    };
    core = await factory.core({
      identity: {
        dataRoot: options.dataRoot,
        socketPath: options.socketPath,
        entry: fileURLToPath(import.meta.url),
        executable: process.execPath,
      },
      onUpdate,
      dataRoot: options.dataRoot,
      socketPath: options.socketPath,
      scope,
      execution,
      ...(factory === dependencies
        ? { localComputer: new LocalComputerClient(options.dataRoot) }
        : {}),
      sdkFile: factory.sdk(),
      stdioEntry: mcpStdioEntry,
      ...(!connection.connected ? { offlineWorkspaceRoot: root } : {}),
      reboot: { status: () => power!.status(), invoke: (command) => power!.handle(command) },
    });
    signal?.throwIfAborted();
    return { scope, close };
  } catch (error) {
    await close().catch(() => {});
    if (!signal?.aborted && startupErrorCode(error) !== 'AGENT_SETUP_PAUSED')
      await writeStartupFailure(options.dataRoot, error);
    throw error;
  }
}
interface Signals {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => unknown): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: () => unknown): unknown;
}
interface Runtime {
  signals: Signals;
  umask(mask: number): unknown;
  report(code: string): unknown;
}
export async function runAgentCli(
  args: string[],
  factory: MainDependencies = dependencies,
  runtime: Runtime = {
    signals: process,
    umask: (mask) => process.umask(mask),
    report: (code) => process.stderr.write(`${code}\n`),
  },
) {
  runtime.umask(0o077);
  const cancellation = new AbortController();
  let stopped: () => unknown = () => undefined;
  const signal = () => {
    cancellation.abort();
    stopped();
  };
  const pending = new Promise<unknown>((resolve) => {
    stopped = () => resolve(undefined);
  });
  runtime.signals.on('SIGTERM', signal);
  runtime.signals.on('SIGINT', signal);
  let app: Awaited<ReturnType<typeof startAgentProcess>> | undefined;
  try {
    app = await startAgentProcess(parseAgentArguments(args), factory, cancellation.signal, () =>
      stopped(),
    );
    if (!cancellation.signal.aborted) await pending;
    await app.close();
    return 0;
  } catch (error) {
    if (startupErrorCode(error) === 'AGENT_SETUP_PAUSED' || (cancellation.signal.aborted && !app))
      return 0;
    runtime.report(startupErrorCode(error));
    return 1;
  } finally {
    runtime.signals.off('SIGTERM', signal);
    runtime.signals.off('SIGINT', signal);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runAgentCli(process.argv.slice(2));
