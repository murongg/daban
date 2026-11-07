import path from 'node:path';
import type { Executor } from '@daban/engine/agent';
import type {
  ExecutionSnapshot,
  RebootStatus,
  RecoveryReview,
  RuntimeCommand,
} from '@daban/protocol';
import type { MainDependencies } from './main.js';
import {
  assertSetupRunning,
  isWorkspaceRoot,
  readStartupPolicy,
  saveExecutionSnapshot,
} from './startup.js';

type Connection = ReturnType<MainDependencies['connection']>;
type Link = Parameters<MainDependencies['connection']>[0];
type Owner = Awaited<ReturnType<MainDependencies['core']>>;
interface Options {
  dataRoot: string;
  load(): Promise<{ link: Link; target: string }>;
  connection: MainDependencies['connection'];
  power: MainDependencies['power'];
  owner(): Owner | undefined;
}

/** Installed Linux is optional. Only an explicit execution request may cross the wake boundary. */
export class LinuxExecution implements Executor {
  private configured?: Promise<{
    link: Link;
    target: string;
    connection: Connection;
    power: ReturnType<Options['power']>;
  }>;
  private starting?: Promise<ExecutionSnapshot>;
  private closed = false;
  private current?: Connection;
  private attached?: Promise<unknown>;
  private workspaceRoot?: string;
  constructor(private readonly options: Options) {}
  get snapshot() {
    return this.current?.snapshot;
  }
  get ready() {
    return this.ensure();
  }
  async available() {
    try {
      const { power } = await this.configure();
      return power.status().available;
    } catch {
      return false;
    }
  }
  private check() {
    if (this.closed) throw new Error('EXECUTION_CONNECTION_CLOSED');
  }
  private configure() {
    this.check();
    this.configured ??= this.prepare().catch((error) => {
      this.configured = undefined;
      throw error;
    });
    return this.configured;
  }
  private async prepare() {
    const { link, target } = await this.options.load();
    let connection: Connection | undefined;
    let power: ReturnType<Options['power']> | undefined;
    try {
      this.check();
      const policy = await readStartupPolicy({
        target,
        powerFile: path.join(this.options.dataRoot, 'host-recovery.json'),
        cacheFile: path.join(this.options.dataRoot, 'execution-snapshot.json'),
      });
      this.workspaceRoot = policy.workspaceRoot;
      // The cached snapshot permits host startup while Linux is stopped. No constructor may start it.
      connection = this.options.connection(link, {
        attachOnly: true,
        ...(policy.initialSnapshot ? { initialSnapshot: policy.initialSnapshot } : {}),
      });
      // An absent cache can make the initial attach fail; only explicit callers observe that failure.
      connection.ready.catch(() => {});
      this.current = connection;
      // Reattach once to an already running VM, including when startup restored a cached snapshot.
      this.attached = connection.refresh().catch(() => {});
      const recovery = () => {
        const value = this.options.owner()?.recovery;
        if (!value) throw new Error('RECOVERY_UNAVAILABLE');
        return value;
      };
      power = this.options.power({
        file: path.join(this.options.dataRoot, 'host-recovery.json'),
        target,
        driver: {
          review: async () => {
            await this.options.owner()?.refreshExecution();
            return recovery().review();
          },
          prepare: async (request) => {
            await this.options.owner()?.refreshExecution();
            return recovery().prepare(request);
          },
          claim: (binding) => recovery().claim(binding.id, binding.revision + 1),
          cancel: (binding) => recovery().cancel(binding.id, binding.revision + 1),
          receipt: async (id) => recovery().receipt(id),
          vm: () => link.state(),
          stop: () => link.stopVm(),
          start: async () => {
            await connection!.rebind(await link.startVm());
            await this.options.owner()?.refreshExecution();
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
          const owner = this.options.owner();
          if (owner)
            await Promise.all(
              [...owner.models.jobs.values()]
                .filter((job) => owner.models.running(job.bot))
                .map((job) => owner.models.stop(job.bot, 'vm-restart')),
            );
        },
      });
      await power.ready;
      this.check();
      return { link, target, connection, power };
    } catch (error) {
      await power?.close();
      await (connection ?? link).close();
      throw error;
    }
  }
  private ensure() {
    this.check();
    this.starting ??= (async () => {
      await assertSetupRunning(this.options.dataRoot);
      const { link, target, connection, power } = await this.configure();
      await this.attached;
      const status = power.status();
      if (!status.available) throw new Error(status.error);
      if (
        status.operation &&
        !['complete', 'cancelled', 'rejected'].includes(status.operation.stage)
      )
        throw new Error('RUNTIME_RECOVERY_PENDING');
      this.check();
      if (!connection.connected) await connection.rebind(await link.ensure());
      this.check();
      return this.record(connection, target);
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async refresh() {
    const { connection, target } = await this.configure();
    this.check();
    // A failed attach is already an observation. Polling must not keep forking VM probes while it sleeps.
    if (!connection.connected) throw new Error('EXECUTOR_OFFLINE');
    return this.record(connection, target);
  }
  private async record(connection: Connection, target: string) {
    const snapshot = await connection.refresh();
    const workspaceRoot = await connection.call('workspace.base', {});
    this.check();
    if (
      !isWorkspaceRoot(workspaceRoot) ||
      (this.workspaceRoot && this.workspaceRoot !== workspaceRoot)
    )
      throw new Error('AGENT_WORKSPACE_CHANGED');
    if (connection.snapshot?.boot !== snapshot.boot || connection.snapshot.nonce !== snapshot.nonce)
      throw new Error('EXECUTION_GUEST_RESTARTED');
    this.workspaceRoot = workspaceRoot;
    await saveExecutionSnapshot({
      file: path.join(this.options.dataRoot, 'execution-snapshot.json'),
      target,
      snapshot,
      workspaceRoot,
    });
    this.check();
    return snapshot;
  }
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      const connect =
        method === 'computer.request' &&
        params.method === 'POST' &&
        params.path === '/api/computers/action' &&
        !!params.body &&
        typeof params.body === 'object' &&
        'action' in params.body &&
        params.body.action === 'connect';
      const wake =
        connect ||
        method === 'tools.open' ||
        method === 'documents.extract' ||
        [
          'workspace.base',
          'workspace.create',
          'workspace.skill',
          'workspace.read',
          'workspace.download',
          'workspace.list',
        ].includes(method);
      if (wake) await this.ensure();
      else {
        const { connection } = await this.configure();
        if (!connection.connected) throw new Error('EXECUTOR_OFFLINE');
        // The authenticated peer fences every call by boot/nonce. Polls need no extra snapshot or disk sync.
      }
      signal?.throwIfAborted();
      this.check();
      return await this.current!.call<T>(method, params, signal);
    } catch (error) {
      // Host setup/power errors use messages; retain their bounded codes across the engine RPC boundary.
      if (error instanceof Error && !('code' in error) && /^[A-Z_]{1,100}$/.test(error.message))
        Object.assign(error, { code: error.message });
      throw error;
    }
  }
  async recoveryStatus(): Promise<RebootStatus> {
    return (await this.configure()).power.status();
  }
  async recover(command: RuntimeCommand): Promise<RebootStatus | RecoveryReview> {
    return (await this.configure()).power.handle(command);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const configured = await this.configured?.catch(() => undefined);
    await configured?.power.close();
    await configured?.connection.close();
    await this.starting?.catch(() => {});
  }
}
