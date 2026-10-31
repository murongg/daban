import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isExecutionParams, validAgentId } from '@daban/protocol';
import { Fault } from './control.js';

export interface ProcessSnapshot {
  id: string;
  boot: string;
  phase: 'starting' | 'running' | 'exited' | 'failed' | 'cancelled' | 'unknown';
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  error?: string;
}
interface Mutation {
  id: string;
  digest: string;
  reply?: ProcessSnapshot;
}
interface Receipt {
  version: 1;
  digest: string;
  snapshot: ProcessSnapshot;
  mutations: Mutation[];
}
interface Active {
  child: ChildProcessWithoutNullStreams;
  done: Promise<ProcessSnapshot>;
  bytes: number;
  decoders: { stdout: TextDecoder; stderr: TextDecoder };
  stopping?: 'cancelled' | 'failed';
}
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
export function guestEnvironment(home = '/home/bot-prototype'): NodeJS.ProcessEnv {
  return {
    PATH: '/opt/bot-prototype/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
  };
}
export class ProcessManager {
  readonly ready: Promise<unknown>;
  private readonly receipts = new Map<string, Receipt>();
  private readonly active = new Map<string, Active>();
  private readonly starts = new Map<
    string,
    { digest: string; promise: Promise<ProcessSnapshot> }
  >();
  private writes = Promise.resolve();
  private closed = false;
  private storageFailed = false;
  constructor(readonly options: { directory: string; boot: string; home?: string }) {
    this.ready = this.load();
  }
  private async load() {
    if (!validAgentId(this.options.boot)) throw new Fault('PROCESS_STORE_INVALID');
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(this.options.directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Fault('PROCESS_STORE_INVALID');
  }
  private async lookup(id: string): Promise<Receipt | undefined> {
    const cached = this.receipts.get(id);
    if (cached) return cached;
    try {
      const handle = await open(
        path.join(this.options.directory, `${id}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 12 * 1024 * 1024 ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600
        )
          throw new Fault('PROCESS_STORE_INVALID');
        const value = JSON.parse(await handle.readFile('utf8')) as Receipt;
        if (
          value.version !== 1 ||
          value.snapshot?.id !== id ||
          !/^[a-f0-9]{64}$/.test(value.digest) ||
          !Array.isArray(value.mutations) ||
          value.mutations.length > 64 ||
          !['starting', 'running', 'exited', 'failed', 'cancelled', 'unknown'].includes(
            value.snapshot.phase,
          ) ||
          typeof value.snapshot.stdout !== 'string' ||
          typeof value.snapshot.stderr !== 'string'
        )
          throw new Fault('PROCESS_STORE_INVALID');
        // History stays on disk. Earlier running claims remain uncertain and never authorize replay.
        if (value.snapshot.phase === 'starting' || value.snapshot.phase === 'running') {
          value.snapshot.phase = 'unknown';
          value.snapshot.error = 'PROCESS_OUTCOME_UNKNOWN';
        }
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw new Fault('PROCESS_STORE_INVALID');
    }
  }
  private persist(receipt: Receipt) {
    const data = `${JSON.stringify(receipt)}\n`;
    const target = path.join(this.options.directory, `${receipt.snapshot.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    this.writes = this.writes
      .then(async () => {
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, target);
          const parent = await open(
            this.options.directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            // The claim must survive a reboot before any command may be dispatched.
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
      })
      .catch(() => {
        this.storageFailed = true;
        throw new Fault('PROCESS_STORE_FAILED');
      });
    return this.writes;
  }
  private copy(receipt: Receipt) {
    return { ...receipt.snapshot };
  }
  async start(request: { id: string; command: string; cwd: string }) {
    await this.ready;
    if (!isExecutionParams('process.start', request))
      throw new Fault('PROCESS_INVALID_REQUEST', 400);
    if (this.closed) throw new Fault('PROCESS_CLOSED');
    const digest = fingerprint(request);
    const pending = this.starts.get(request.id);
    if (pending) {
      if (pending.digest !== digest) throw new Fault('PROCESS_REQUEST_CONFLICT');
      return pending.promise;
    }
    if (this.starts.size >= 16) throw new Fault('PROCESS_CAPACITY');
    const promise = this.startOnce(request, digest);
    this.starts.set(request.id, { digest, promise });
    try {
      return await promise;
    } finally {
      this.starts.delete(request.id);
    }
  }
  private async startOnce(request: { id: string; command: string; cwd: string }, digest: string) {
    const previous = await this.lookup(request.id);
    if (previous) {
      if (previous.digest !== digest) throw new Fault('PROCESS_REQUEST_CONFLICT');
      return this.copy(previous);
    }
    if (this.storageFailed) throw new Fault('PROCESS_STORE_FAILED');
    if (new Set([...this.active.keys(), ...this.starts.keys()]).size > 16)
      throw new Fault('PROCESS_CAPACITY');
    const receipt: Receipt = {
      version: 1,
      digest,
      snapshot: {
        id: request.id,
        boot: this.options.boot,
        phase: 'starting',
        stdout: '',
        stderr: '',
      },
      mutations: [],
    };
    this.receipts.set(request.id, receipt);
    return this.launch(receipt, request);
  }
  private async launch(receipt: Receipt, request: { id: string; command: string; cwd: string }) {
    // Commit the claim before spawn: an acknowledgement lost after spawn must never execute twice.
    try {
      await this.persist(receipt);
    } catch {
      this.storageFailed = true;
      receipt.snapshot.phase = 'unknown';
      receipt.snapshot.error = 'PROCESS_OUTCOME_UNKNOWN';
      throw new Fault('PROCESS_STORE_FAILED');
    }
    if (this.closed) {
      receipt.snapshot.phase = 'unknown';
      receipt.snapshot.error = 'PROCESS_OUTCOME_UNKNOWN';
      await this.persist(receipt);
      return this.copy(receipt);
    }
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', request.command], {
      cwd: request.cwd,
      env: guestEnvironment(this.options.home),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finish!: (value: ProcessSnapshot) => unknown;
    const done = new Promise<ProcessSnapshot>((resolve) => {
      finish = resolve;
    });
    const active: Active = {
      child,
      done,
      bytes: 0,
      decoders: { stdout: new TextDecoder(), stderr: new TextDecoder() },
    };
    this.active.set(request.id, active);
    receipt.snapshot.phase = 'running';
    child.stdin.on('error', () => {});
    const capture = (target: 'stdout' | 'stderr', chunk: Buffer, final = false) => {
      const remaining = 65536 - active.bytes;
      // Invalid output bytes expand to UTF-8 replacement characters; bound the returned text too.
      const decoded = Buffer.from(active.decoders[target].decode(chunk, { stream: !final }));
      const output = new TextDecoder().decode(decoded.subarray(0, remaining), {
        stream: decoded.length > remaining,
      });
      receipt.snapshot[target] += output;
      active.bytes += Buffer.byteLength(output);
      if (decoded.length > remaining && !active.stopping) {
        active.stopping = 'failed';
        receipt.snapshot.error = 'PROCESS_OUTPUT_LIMIT';
        if (!final) this.signal(active, 'SIGKILL');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.once('error', () => {
      receipt.snapshot.error = 'PROCESS_START_FAILED';
    });
    child.once('close', (code, signal) => {
      capture('stdout', Buffer.alloc(0), true);
      capture('stderr', Buffer.alloc(0), true);
      receipt.snapshot.exitCode = code;
      receipt.snapshot.phase =
        active.stopping || (receipt.snapshot.error || signal ? 'failed' : 'exited');
      if (signal && !receipt.snapshot.error && active.stopping !== 'cancelled')
        receipt.snapshot.error = 'PROCESS_SIGNALLED';
      this.active.delete(request.id);
      this.persist(receipt)
        .then(() => {
          const result = this.copy(receipt);
          this.receipts.delete(request.id);
          finish(result);
        })
        .catch(() => {
          this.storageFailed = true;
          receipt.snapshot.phase = 'unknown';
          receipt.snapshot.error = 'PROCESS_OUTCOME_UNKNOWN';
          finish(this.copy(receipt));
        });
    });
    try {
      await this.persist(receipt);
    } catch {
      // Spawn has already happened: a failed save cannot turn its effects into a safe retry.
      this.storageFailed = true;
      // Keep the owned child observable; do not turn an uncertain external command into a forced retry.
      receipt.snapshot.phase = 'unknown';
      receipt.snapshot.error = 'PROCESS_OUTCOME_UNKNOWN';
      this.receipts.set(request.id, receipt);
    }
    return this.copy(receipt);
  }
  private signal(active: Active, signal: NodeJS.Signals) {
    if (!active.child.pid) return;
    try {
      process.kill(-active.child.pid, signal);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
        throw error;
    }
  }
  private async terminate(active: Active, phase: 'cancelled' | 'failed') {
    active.stopping = phase;
    if (active.child.exitCode === null && active.child.signalCode === null)
      this.signal(active, 'SIGTERM');
    const timer = setTimeout(() => this.signal(active, 'SIGKILL'), 1000);
    try {
      await active.done;
    } finally {
      clearTimeout(timer);
    }
  }
  async poll(id: string) {
    await this.ready;
    if (!validAgentId(id)) throw new Fault('PROCESS_INVALID_REQUEST', 400);
    const receipt = await this.lookup(id);
    return receipt
      ? this.copy(receipt)
      : { id, boot: this.options.boot, phase: 'unknown' as const, stdout: '', stderr: '' };
  }
  private async mutate(
    request: { id: string; requestId: string },
    payload: unknown,
    action: (active: Active) => Promise<unknown>,
  ) {
    await this.ready;
    const receipt = await this.lookup(request.id);
    if (!receipt) throw new Fault('PROCESS_UNKNOWN');
    const digest = fingerprint(payload);
    const previous = receipt.mutations.find((value) => value.id === request.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Fault('PROCESS_REQUEST_CONFLICT');
      if (!previous.reply) throw new Fault('PROCESS_OUTCOME_UNKNOWN');
      return { ...previous.reply };
    }
    if (receipt.mutations.length >= 64) throw new Fault('PROCESS_RECEIPT_LIMIT');
    if (this.storageFailed) throw new Fault('PROCESS_OUTCOME_UNKNOWN');
    const active = this.active.get(request.id);
    if (!active) {
      if (receipt.snapshot.phase === 'unknown') throw new Fault('PROCESS_OUTCOME_UNKNOWN');
      return this.copy(receipt);
    }
    const mutation: Mutation = { id: request.requestId, digest };
    receipt.mutations.push(mutation);
    await this.persist(receipt);
    if (this.active.get(request.id) !== active) return this.copy(receipt);
    await action(active);
    mutation.reply = this.copy(receipt);
    await this.persist(receipt);
    return { ...mutation.reply };
  }
  async input(request: { id: string; requestId: string; data: string; eof?: boolean }) {
    if (!isExecutionParams('process.input', request))
      throw new Fault('PROCESS_INVALID_REQUEST', 400);
    return this.mutate(request, request, async (active) => {
      if (active.child.stdin.destroyed || active.child.stdin.writableEnded)
        throw new Fault('PROCESS_INPUT_CLOSED');
      await new Promise<unknown>((resolve, reject) => {
        active.child.stdin.write(request.data, (error) =>
          error ? reject(new Fault('PROCESS_INPUT_CLOSED')) : resolve(undefined),
        );
      });
      if (request.eof) active.child.stdin.end();
    });
  }
  async cancel(request: { id: string; requestId: string }) {
    if (!isExecutionParams('process.cancel', request))
      throw new Fault('PROCESS_INVALID_REQUEST', 400);
    await this.ready;
    const active = this.active.get(request.id);
    if (this.storageFailed && active) {
      await this.terminate(active, 'cancelled');
      return this.poll(request.id);
    }
    return this.mutate(request, request, (owned) => this.terminate(owned, 'cancelled'));
  }
  async wait(id: string, signal?: AbortSignal) {
    await this.ready;
    const active = this.active.get(id);
    if (!active) return this.poll(id);
    const cancel = () => {
      this.cancel({ id, requestId: fingerprint(['stop', id]) }).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await active.done;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  async close() {
    this.closed = true;
    await this.ready;
    await Promise.allSettled([...this.starts.values()].map((value) => value.promise));
    await Promise.allSettled(
      [...this.active.keys()].map((id) =>
        this.cancel({ id, requestId: fingerprint(['close', id]) }),
      ),
    );
    await this.writes.catch(() => {});
  }
}
