import { type Executor, RemoteExecutor } from '@daban/engine/agent';
import { type ExecutionSnapshot, isExecutionSnapshot } from '@daban/protocol';

interface Link {
  ensure(): Promise<{ origin: string; token: string }>;
  reconnect?(): Promise<{ origin: string; token: string }>;
  close(): Promise<unknown>;
}
interface Peer {
  ready: Promise<ExecutionSnapshot>;
  snapshot?: ExecutionSnapshot;
  refresh(): Promise<ExecutionSnapshot>;
  call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
const restartCodes = new Set([
  'EXECUTION_GUEST_RESTARTED',
  'EXECUTION_BOOT_CHANGED',
  'EXECUTION_UNAVAILABLE',
  'EXECUTION_OUTCOME_UNKNOWN',
  'EXECUTION_UNAUTHORIZED',
]);
function code(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : '';
}
export class ExecutionConnection implements Executor {
  readonly ready: Promise<ExecutionSnapshot>;
  snapshot?: ExecutionSnapshot;
  private peer?: Peer;
  private connecting?: Promise<ExecutionSnapshot>;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(
    private readonly link: Link,
    private readonly options: {
      create?: (connection: { origin: string; token: string }) => Peer;
      initialSnapshot?: ExecutionSnapshot;
      attachOnly?: boolean;
    } = {},
  ) {
    if (options.initialSnapshot) {
      if (!isExecutionSnapshot(options.initialSnapshot)) {
        this.ready = Promise.reject(new Error('EXECUTION_INVALID_SNAPSHOT'));
        return;
      }
      this.snapshot = structuredClone(options.initialSnapshot);
    }
    this.ready =
      options.attachOnly && this.snapshot
        ? Promise.resolve(structuredClone(this.snapshot))
        : this.bind(undefined, !options.attachOnly);
  }
  get connected() {
    return !this.closed && !!this.peer;
  }
  private open() {
    if (this.closed) throw new Error('EXECUTION_CONNECTION_CLOSED');
  }
  rebind(connection?: { origin: string; token: string }): Promise<ExecutionSnapshot> {
    this.open();
    if (connection) return this.explicit({ ...connection });
    if (this.connecting) return this.connecting;
    return this.bind();
  }
  private async explicit(connection: { origin: string; token: string }) {
    // Power supplies a newly proved endpoint; an older automatic attempt may settle, but cannot consume it.
    while (this.connecting) {
      await this.connecting.catch(() => {});
      this.open();
    }
    return this.bind(connection);
  }
  private bind(connection?: { origin: string; token: string }, startup = false) {
    this.open();
    this.peer = undefined;
    const pending = (async () => {
      let value = connection;
      if (!value) {
        if (startup) value = await this.link.ensure();
        else if (this.link.reconnect) value = await this.link.reconnect();
        else if (this.options.attachOnly) throw new Error('EXECUTION_UNAVAILABLE');
        else value = await this.link.ensure();
      }
      this.open();
      const next =
        this.options.create?.(value) ??
        new RemoteExecutor({ url: `${value.origin}/exec`, token: value.token });
      const snapshot = await next.ready;
      this.open();
      if (!isExecutionSnapshot(snapshot)) throw new Error('EXECUTION_INVALID_SNAPSHOT');
      this.peer = next;
      this.snapshot = structuredClone(snapshot);
      return this.snapshot;
    })();
    const tracked: Promise<ExecutionSnapshot> = pending.finally(() => {
      if (this.connecting === tracked) this.connecting = undefined;
    });
    this.connecting = tracked;
    return tracked;
  }
  async refresh() {
    this.open();
    if (this.connecting) await this.connecting;
    if (!this.peer) return this.rebind();
    const current = this.peer;
    try {
      const snapshot = await current.refresh();
      this.open();
      if (!isExecutionSnapshot(snapshot)) throw new Error('EXECUTION_INVALID_SNAPSHOT');
      if (this.peer !== current) {
        if (this.connecting) await this.connecting;
        this.open();
        if (!this.peer || !this.snapshot) throw new Error('EXECUTION_UNAVAILABLE');
        return this.snapshot;
      }
      this.snapshot = structuredClone(snapshot);
      return this.snapshot!;
    } catch (error) {
      this.open();
      if (this.peer !== current) {
        if (this.connecting) return this.connecting;
        if (this.peer && this.snapshot) return this.snapshot;
        throw new Error('EXECUTION_UNAVAILABLE');
      }
      if (!restartCodes.has(code(error))) throw error;
      return this.rebind();
    }
  }
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.open();
    while (this.connecting) await this.connecting;
    this.open();
    if (!this.peer)
      throw Object.assign(new Error('EXECUTION_UNAVAILABLE'), { code: 'EXECUTION_UNAVAILABLE' });
    const current = this.peer;
    try {
      return (await current.call(
        method,
        params,
        AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]),
      )) as T;
    } catch (error) {
      // Reconnect for future work, but an accepted mutation is never replayed after transport loss.
      if (!this.closed && this.peer === current && restartCodes.has(code(error)))
        await this.rebind().catch(() => {});
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await this.link.close();
  }
}
