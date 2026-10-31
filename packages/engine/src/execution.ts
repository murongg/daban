import { randomUUID } from 'node:crypto';
import type { ExecutionMethod, ExecutionSnapshot } from '@daban/protocol';
import {
  isComputerStatus,
  isExecutionParams,
  isExecutionReply,
  isExecutionSnapshot,
} from '@daban/protocol';
import { Fault } from './control.js';

export interface Executor {
  readonly ready: Promise<ExecutionSnapshot>;
  snapshot?: ExecutionSnapshot;
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
  refresh(): Promise<ExecutionSnapshot>;
}
const readers = new Set([
  'computer.snapshot',
  'computer.status',
  'workspace.base',
  'workspace.list',
  'workspace.read',
  'workspace.download',
  'workspace.verify',
  'tools.poll',
  'process.poll',
  'documents.extract',
]);
export class RemoteExecutor implements Executor {
  readonly ready: Promise<ExecutionSnapshot>;
  snapshot?: ExecutionSnapshot;
  constructor(readonly options: { url: string; token: string; fetcher?: typeof fetch }) {
    const url = new URL(options.url);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/exec' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !options.token ||
      options.token.includes('\0')
    )
      throw new Fault('EXECUTION_INVALID_CONFIG');
    this.ready = this.refresh();
  }
  async refresh() {
    const value = await this.request('computer.snapshot', {});
    if (!isExecutionSnapshot(value)) throw new Fault('EXECUTION_INVALID_RESPONSE');
    if (this.snapshot && (this.snapshot.boot !== value.boot || this.snapshot.nonce !== value.nonce))
      throw new Fault('EXECUTION_GUEST_RESTARTED');
    this.snapshot = value;
    return value;
  }
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.ready;
    return (await this.request(method, params, signal)) as T;
  }
  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    if (!isExecutionParams(method as ExecutionMethod, params))
      throw new Fault('EXECUTION_INVALID_REQUEST', 400);
    const id = randomUUID();
    const boot = this.snapshot?.boot;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
    let response: Response;
    try {
      response = await (this.options.fetcher || fetch)(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-daban-execution-token': this.options.token,
        },
        body: JSON.stringify({
          version: 1,
          role: 'executor',
          id,
          ...(boot ? { boot, nonce: this.snapshot?.nonce } : {}),
          method,
          params,
        }),
        signal: bounded,
      });
    } catch {
      // Retrying a failed transport can duplicate a command that the guest already accepted.
      throw new Fault(readers.has(method) ? 'EXECUTION_UNAVAILABLE' : 'EXECUTION_OUTCOME_UNKNOWN');
    }
    if (!response.body) throw new Fault('EXECUTION_INVALID_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new Fault('EXECUTION_INVALID_RESPONSE');
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(readers.has(method) ? 'EXECUTION_UNAVAILABLE' : 'EXECUTION_OUTCOME_UNKNOWN');
    } finally {
      await reader.cancel().catch(() => {});
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Fault('EXECUTION_INVALID_RESPONSE');
    }
    if (!isExecutionReply(value) || value.id !== id) throw new Fault('EXECUTION_INVALID_RESPONSE');
    if (boot && value.boot !== boot) throw new Fault('EXECUTION_GUEST_RESTARTED');
    if (!value.ok) throw new Fault(value.error);
    if (!response.ok) throw new Fault('EXECUTION_INVALID_RESPONSE');
    if (
      (method === 'computer.snapshot' && !isExecutionSnapshot(value.value)) ||
      (method === 'computer.status' && !isComputerStatus(value.value))
    )
      throw new Fault('EXECUTION_INVALID_RESPONSE');
    return value.value;
  }
}
