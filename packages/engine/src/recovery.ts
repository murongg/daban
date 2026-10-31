import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  isRecoveryReceipt,
  isRecoveryRequest,
  isRecoveryReview,
  type RecoveryReceipt,
  type RecoveryRequest,
  type RecoveryReview,
  type RecoveryStatus,
  validAgentId,
} from '@daban/protocol';
import { errorCode, Fault } from './control.js';

interface Options {
  file: string;
  boot: string;
  instance: string;
  quiesce: () => Promise<unknown>;
  snapshot: () => Pick<RecoveryReview, 'computersRevision' | 'screens' | 'running' | 'changing'>;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class Recovery {
  readonly ready: Promise<unknown>;
  private loaded = false;
  private failed = false;
  private closed = false;
  private reserving = false;
  private mutations = 0;
  private revision = 0;
  private current?: RecoveryReceipt;
  private canonical = '';
  private fingerprint?: string;
  private writing: Promise<unknown> = Promise.resolve();
  private preparing?: { request: RecoveryRequest; promise: Promise<RecoveryReceipt> };
  constructor(readonly options: Options) {
    this.ready = this.load()
      .then(() => {
        this.loaded = true;
      })
      .catch(() => {
        this.failed = true;
        this.loaded = true;
      });
  }
  private available() {
    if (this.failed || !this.loaded) throw new Fault('RECOVERY_STORE_UNAVAILABLE', 503);
    if (this.closed) throw new Fault('RECOVERY_CLOSED', 503);
  }
  admit() {
    return (
      this.loaded &&
      !this.failed &&
      !this.closed &&
      !this.reserving &&
      !['prepared', 'claimed'].includes(this.current?.phase ?? '')
    );
  }
  status(): RecoveryStatus {
    if (!this.loaded || this.failed || this.closed)
      return { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
    return {
      available: true,
      revision: this.revision,
      ...(this.current ? { operation: structuredClone(this.current) } : {}),
    };
  }
  enter() {
    this.available();
    if (!this.admit()) throw new Fault('RUNTIME_RECOVERY_PENDING');
    this.mutations++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.mutations--;
      }
    };
  }
  private async read() {
    let handle: FileHandle;
    try {
      handle = await open(this.options.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024)
        throw new Fault('RECOVERY_STORE_UNAVAILABLE', 503);
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
  private async load() {
    if (
      !validAgentId(this.options.boot) ||
      !validAgentId(this.options.instance) ||
      !path.isAbsolute(this.options.file)
    )
      throw new Fault('INVALID_RECOVERY_CONFIG');
    await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
    this.canonical = await realpath(path.dirname(this.options.file));
    const text = await this.read();
    if (text === undefined) return;
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['version', 'revision', 'receipt'].includes(key)) ||
      !('version' in value) ||
      value.version !== 1 ||
      !('receipt' in value) ||
      !isRecoveryReceipt(value.receipt) ||
      !('revision' in value) ||
      value.revision !== value.receipt.revision
    )
      throw new Fault('RECOVERY_STORE_UNAVAILABLE', 503);
    const { digest: expected, ...content } = value.receipt.review;
    if (digest(JSON.stringify(content)) !== expected)
      throw new Fault('RECOVERY_STORE_UNAVAILABLE', 503);
    this.current = value.receipt;
    this.revision = value.receipt.revision;
    this.fingerprint = digest(text);
    if (this.current.review.boot !== this.options.boot) {
      if (this.current.phase === 'claimed')
        await this.commit({
          ...this.current,
          phase: 'complete',
          revision: this.current.review.revision + 3,
          boot: this.options.boot,
          instance: this.options.instance,
        });
      else if (this.current.phase === 'prepared')
        await this.commit({
          ...this.current,
          phase: 'cancelled',
          revision: this.current.review.revision + 2,
        });
    }
  }
  private async commit(receipt: RecoveryReceipt) {
    if (!isRecoveryReceipt(receipt)) throw new Fault('INVALID_RECOVERY_STATE');
    const temporary = `${this.options.file}.${randomBytes(8).toString('hex')}.tmp`;
    const text = JSON.stringify({ version: 1, revision: receipt.revision, receipt });
    try {
      if ((await realpath(path.dirname(this.options.file))) !== this.canonical)
        throw new Error('authority moved');
      const previous = await this.read();
      if ((previous === undefined ? undefined : digest(previous)) !== this.fingerprint)
        throw new Error('authority changed');
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.options.file);
      const directory = await open(this.canonical, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      // A successful durable receipt is the only permission for the host to advance toward its effect.
      this.current = structuredClone(receipt);
      this.revision = receipt.revision;
      this.fingerprint = digest(text);
      return structuredClone(receipt);
    } catch {
      this.failed = true;
      throw new Fault('RECOVERY_STORE_UNAVAILABLE', 503);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  private snapshot(revision = this.revision): RecoveryReview {
    const source = this.options.snapshot();
    const value = {
      boot: this.options.boot,
      instance: this.options.instance,
      revision,
      computersRevision: source.computersRevision,
      screens: structuredClone(source.screens).sort((a, b) =>
        a.computer.bot.localeCompare(b.computer.bot),
      ),
      running: [...source.running].sort(),
      changing: source.changing || this.mutations > 0,
    };
    const review = { ...value, digest: digest(JSON.stringify(value)) };
    if (!isRecoveryReview(review)) throw new Fault('INVALID_RECOVERY_STATE');
    return review;
  }
  review() {
    this.available();
    return this.snapshot();
  }
  receipt(id: string) {
    this.available();
    if (!validAgentId(id) || this.current?.id !== id)
      throw new Fault('RECOVERY_RECEIPT_NOT_FOUND', 404);
    return structuredClone(this.current);
  }
  private mutate<T>(action: () => Promise<T>) {
    const pending = this.writing.then(async () => {
      await this.ready;
      this.available();
      return action();
    });
    this.writing = pending.catch(() => {});
    return pending;
  }
  prepare(input: unknown): Promise<RecoveryReceipt> {
    if (!isRecoveryRequest(input))
      return Promise.reject(new Fault('INVALID_RECOVERY_REQUEST', 400));
    const request = structuredClone(input);
    if (this.preparing)
      return this.preparing.request.id === request.id &&
        this.preparing.request.revision === request.revision &&
        this.preparing.request.review === request.review &&
        this.preparing.request.confirmation === request.confirmation
        ? this.preparing.promise
        : Promise.reject(new Fault('RECOVERY_CHANGES_RUNNING'));
    const promise = this.mutate(async () => {
      if (this.current?.id === request.id) {
        if (
          this.current.review.digest !== request.review ||
          this.current.review.revision !== request.revision
        )
          throw new Fault('RECOVERY_REQUEST_ID_REUSED');
        return structuredClone(this.current);
      }
      if (!this.admit()) throw new Fault('RUNTIME_RECOVERY_PENDING');
      const review = this.snapshot();
      // Reject existing work before reservation, preserving the tools of an already-running task.
      if (review.running.length) throw new Fault('RECOVERY_TASKS_RUNNING');
      if (review.changing) throw new Fault('RECOVERY_CHANGES_RUNNING');
      if (review.revision !== request.revision || review.digest !== request.review)
        throw new Fault('RECOVERY_REVIEW_CHANGED');
      this.reserving = true;
      try {
        return await this.commit({
          id: request.id,
          phase: 'prepared',
          revision: review.revision + 1,
          review,
        });
      } finally {
        this.reserving = false;
      }
    }).finally(() => {
      if (this.preparing?.promise === promise) this.preparing = undefined;
    });
    this.preparing = { request, promise };
    return promise;
  }
  claim(id: string, revision: number) {
    return this.mutate(async () => {
      const current = this.receipt(id);
      if (revision !== current.review.revision + 1) throw new Fault('RECOVERY_CONFLICT');
      if (['claimed', 'complete'].includes(current.phase)) return current;
      if (current.phase !== 'prepared') throw new Fault('RECOVERY_CANCELLED');
      if (this.snapshot(current.review.revision).digest !== current.review.digest)
        throw new Fault('RECOVERY_REVIEW_CHANGED');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A drain timeout leaves the prepared fence in place; it never grants permission to stop the VM.
        await Promise.race([
          this.options.quiesce(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Fault('RECOVERY_DRAIN_TIMEOUT')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (this.snapshot(current.review.revision).digest !== current.review.digest)
        throw new Fault('RECOVERY_REVIEW_CHANGED');
      return this.commit({ ...current, phase: 'claimed', revision: current.review.revision + 2 });
    });
  }
  cancel(id: string, revision: number) {
    return this.mutate(async () => {
      const current = this.receipt(id);
      if (current.phase === 'claimed' || current.phase === 'complete')
        throw new Fault('RECOVERY_ALREADY_CLAIMED');
      if (revision !== current.review.revision + 1) throw new Fault('RECOVERY_CONFLICT');
      if (current.phase === 'cancelled') return current;
      if (current.phase !== 'prepared') throw new Fault('RECOVERY_ALREADY_CLAIMED');
      return this.commit({ ...current, phase: 'cancelled', revision: current.review.revision + 2 });
    });
  }
  async close() {
    this.closed = true;
    await this.writing.catch(() => {});
  }
}
