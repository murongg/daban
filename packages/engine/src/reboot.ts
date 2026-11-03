import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  isRebootOperation,
  isRecoveryReceipt,
  isRecoveryRequest,
  isRecoveryReview,
  type RebootOperation,
  type RebootStatus,
  type RecoveryReceipt,
  type RecoveryRequest,
  type RecoveryReview,
  validAgentId,
} from '@daban/protocol';
import { syncDirectory } from './durability.js';
import { privateMetadata, secureDirectory } from './private-files.js';

type Binding = Pick<RecoveryRequest, 'id' | 'revision' | 'review'>;
type Vm = 'running' | 'stopped' | 'unknown';
export interface RebootDriver {
  review(): Promise<RecoveryReview>;
  prepare(request: RecoveryRequest): Promise<RecoveryReceipt>;
  claim(request: Binding): Promise<RecoveryReceipt>;
  receipt(id: string): Promise<RecoveryReceipt>;
  cancel(request: Binding): Promise<RecoveryReceipt>;
  vm(): Promise<Vm>;
  stop(): Promise<unknown>;
  start(): Promise<unknown>;
}
interface Document {
  version: 1;
  revision: number;
  target: string;
  operation: RebootOperation;
}
const terminal = new Set(['complete', 'cancelled', 'rejected']);
const definite = new Set([
  'RECOVERY_TASKS_RUNNING',
  'RECOVERY_CHANGES_RUNNING',
  'RECOVERY_REVIEW_CHANGED',
  'INVALID_RECOVERY_REQUEST',
  'RECOVERY_REQUEST_ID_REUSED',
  'RUNTIME_TOO_OLD',
]);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface RebootOptions {
  file: string;
  target: string;
  driver: RebootDriver;
}
export class Reboot {
  readonly ready: Promise<unknown>;
  private operation?: RebootOperation;
  private revision = 0;
  private fingerprint?: string;
  private canonical?: string;
  private failure?: 'RECOVERY_HOST_STORE_UNAVAILABLE' | 'RECOVERY_TARGET_CHANGED';
  private closed = false;
  private vm: Vm = 'unknown';
  private checkedAt?: string;
  private active?: { key: string; promise: Promise<RebootStatus> };
  constructor(readonly options: RebootOptions) {
    this.ready = this.load().catch((error) => {
      this.failure =
        error instanceof Error && error.message === 'RECOVERY_TARGET_CHANGED'
          ? 'RECOVERY_TARGET_CHANGED'
          : 'RECOVERY_HOST_STORE_UNAVAILABLE';
    });
  }
  private async read() {
    let file: FileHandle;
    let identity: Awaited<ReturnType<typeof lstat>>;
    try {
      identity = await lstat(this.options.file);
      if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1)
        throw new Error('RECOVERY_HOST_STORE_UNAVAILABLE');
      if (process.platform === 'win32') await secureDirectory(dirname(this.options.file));
      file = await open(this.options.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 256 * 1024 ||
        info.dev !== identity.dev ||
        info.ino !== identity.ino ||
        (process.platform === 'win32'
          ? !(await privateMetadata(this.options.file, info, 0o600))
          : (info.mode & 0o077) !== 0)
      )
        throw new Error('RECOVERY_HOST_STORE_UNAVAILABLE');
      return await file.readFile('utf8');
    } finally {
      await file.close();
    }
  }
  private async load() {
    if (!isAbsolute(this.options.file) || !/^[a-f0-9]{64}$/.test(this.options.target))
      throw new Error('RECOVERY_HOST_STORE_UNAVAILABLE');
    const text = await this.read();
    if (text === undefined) return;
    this.canonical = await realpath(dirname(this.options.file));
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['version', 'revision', 'target', 'operation'].includes(key),
      ) ||
      !('version' in value) ||
      value.version !== 1 ||
      !('revision' in value) ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      !('operation' in value) ||
      !isRebootOperation(value.operation) ||
      !('target' in value)
    )
      throw new Error('RECOVERY_HOST_STORE_UNAVAILABLE');
    if (value.target !== this.options.target) throw new Error('RECOVERY_TARGET_CHANGED');
    this.revision = Number(value.revision);
    this.operation = value.operation;
    this.fingerprint = hash(text);
  }
  status(): RebootStatus {
    if (this.failure) return { available: false, error: this.failure };
    return {
      available: true,
      revision: this.revision,
      busy: !!this.active,
      vm: this.vm,
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.operation ? { operation: structuredClone(this.operation) } : {}),
    };
  }
  pending() {
    return (
      !!this.failure || !!this.active || (!!this.operation && !terminal.has(this.operation.stage))
    );
  }
  abort() {
    this.closed = true;
  }
  private check() {
    if (this.failure) throw new Error(this.failure);
    if (this.closed) throw new Error('RUNTIME_CLOSED');
  }
  private current(id: string) {
    if (!validAgentId(id) || this.operation?.id !== id)
      throw new Error('RECOVERY_REQUEST_NOT_OWNED');
    return structuredClone(this.operation);
  }
  private binding(operation: RebootOperation): Binding {
    return {
      id: operation.id,
      revision: operation.review.revision,
      review: operation.review.digest,
    };
  }
  private reply(operation: RebootOperation, value: unknown) {
    if (
      !isRecoveryReceipt(value) ||
      value.id !== operation.id ||
      value.review.digest !== operation.review.digest ||
      value.review.revision !== operation.review.revision
    )
      throw new Error('INVALID_RUNTIME_STATE');
    return value;
  }
  private async save(operation: RebootOperation) {
    if (this.failure) throw new Error(this.failure);
    if (!isRebootOperation(operation) || this.revision >= Number.MAX_SAFE_INTEGER)
      throw new Error('INVALID_RUNTIME_STATE');
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    const document: Document = {
      version: 1,
      revision: this.revision + 1,
      target: this.options.target,
      operation,
    };
    const text = JSON.stringify(document);
    try {
      await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') await secureDirectory(dirname(this.options.file));
      const directory = await realpath(dirname(this.options.file));
      if (this.canonical && this.canonical !== directory) throw new Error('authority moved');
      const old = await this.read();
      if ((old === undefined ? undefined : hash(old)) !== this.fingerprint)
        throw new Error('authority changed');
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.options.file);
      const parent = await open(directory, 'r');
      try {
        await syncDirectory(parent);
      } finally {
        await parent.close();
      }
      this.canonical = directory;
      this.fingerprint = hash(text);
      this.revision = document.revision;
      this.operation = structuredClone(operation);
    } catch {
      this.failure = 'RECOVERY_HOST_STORE_UNAVAILABLE';
      throw new Error(this.failure);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  private async changed(operation: RebootOperation) {
    if (JSON.stringify(this.operation) !== JSON.stringify(operation)) await this.save(operation);
  }
  private run(key: string, action: () => Promise<unknown>): Promise<RebootStatus> {
    try {
      this.check();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.active)
      return this.active.key === key
        ? this.active.promise
        : Promise.reject(new Error('RECOVERY_BUSY'));
    const promise = Promise.resolve()
      .then(async () => {
        await this.ready;
        this.check();
        await action();
      })
      .finally(() => {
        if (this.active?.promise === promise) this.active = undefined;
      })
      .then(() => this.status());
    this.active = { key, promise };
    return promise;
  }
  restart(input: unknown) {
    if (!isRecoveryRequest(input)) return Promise.reject(new Error('INVALID_RECOVERY_REQUEST'));
    const request = structuredClone(input);
    return this.run(`restart:${request.id}:${request.revision}:${request.review}`, async () => {
      if (this.operation?.id === request.id) {
        if (
          this.operation.review.digest !== request.review ||
          this.operation.review.revision !== request.revision
        )
          throw new Error('RECOVERY_REQUEST_ID_REUSED');
        // A saved stop-issued record is evidence to inspect, never permission to repeat a stop.
        if (!['preparing', 'prepared'].includes(this.operation.stage)) return;
      } else {
        if (this.pending() && this.operation && !terminal.has(this.operation.stage))
          throw new Error('RUNTIME_RECOVERY_PENDING');
        const review = await this.options.driver.review();
        this.check();
        if (
          !isRecoveryReview(review) ||
          request.review !== review.digest ||
          request.revision !== review.revision
        )
          throw new Error('RECOVERY_REVIEW_CHANGED');
        if (review.running.length) throw new Error('RECOVERY_TASKS_RUNNING');
        if (review.changing) throw new Error('RECOVERY_CHANGES_RUNNING');
        await this.save({ id: request.id, stage: 'preparing', review });
      }
      await this.advance(request);
    });
  }
  private sameScope(a: RecoveryReview, b: RecoveryReview) {
    return (
      a.boot === b.boot &&
      a.instance === b.instance &&
      a.computersRevision === b.computersRevision &&
      !a.changing &&
      !a.running.length &&
      JSON.stringify(a.screens) === JSON.stringify(b.screens)
    );
  }
  private async observe() {
    this.vm = await this.options.driver.vm();
    this.checkedAt = new Date().toISOString();
    return this.vm;
  }
  private async advance(request: RecoveryRequest) {
    try {
      let operation = this.current(request.id);
      if (operation.stage === 'preparing') {
        const value = this.reply(operation, await this.options.driver.prepare(request));
        this.check();
        if (value.phase === 'complete' || value.phase === 'cancelled') {
          await this.save({ ...operation, stage: value.phase, backend: value });
          return;
        }
        operation = { ...operation, stage: 'prepared', backend: value };
        await this.save(operation);
      }
      const claimed = this.reply(
        operation,
        await this.options.driver.claim(this.binding(operation)),
      );
      this.check();
      if (claimed.phase === 'complete') {
        await this.save({ ...operation, stage: 'complete', backend: claimed, error: undefined });
        return;
      }
      if (claimed.phase !== 'claimed') throw new Error('INVALID_RUNTIME_STATE');
      operation = { ...operation, stage: 'prepared', backend: claimed, error: undefined };
      await this.changed(operation);
      const fresh = await this.options.driver.review();
      this.check();
      if (!this.sameScope(fresh, operation.review)) throw new Error('RECOVERY_SCOPE_CHANGED');
      // This synced record must precede the sole destructive command, including after a lost reply or relaunch.
      await this.save({ ...operation, stage: 'stop-issued' });
      this.check();
      await this.options.driver.stop();
      this.check();
      if ((await this.observe()) !== 'stopped') throw new Error('RECOVERY_STOP_UNCONFIRMED');
      await this.save({ ...operation, stage: 'stopped' });
      await this.startOperation(operation.id);
    } catch (error) {
      if (this.failure) throw error;
      const operation = this.current(request.id);
      const code = error instanceof Error ? error.message : '';
      if (operation.stage === 'preparing' && definite.has(code))
        await this.save({ ...operation, stage: 'rejected', error: code });
      else if (!terminal.has(operation.stage))
        await this.save({
          ...operation,
          error:
            operation.stage === 'stop-issued'
              ? 'RECOVERY_STOP_UNCONFIRMED'
              : operation.stage === 'start-issued'
                ? 'RECOVERY_START_UNCONFIRMED'
                : code === 'RECOVERY_SCOPE_CHANGED'
                  ? code
                  : 'RECOVERY_OUTCOME_UNKNOWN',
        });
    }
  }
  private async startOperation(id: string) {
    const operation = this.current(id);
    if (!['stopped', 'start-issued'].includes(operation.stage))
      throw new Error('RECOVERY_START_NOT_ALLOWED');
    if ((await this.observe()) === 'unknown') throw new Error('RECOVERY_START_UNCONFIRMED');
    await this.save({ ...operation, stage: 'start-issued', error: undefined });
    this.check();
    await this.options.driver.start();
    this.check();
    const receipt = this.reply(operation, await this.options.driver.receipt(id));
    if (receipt.phase !== 'complete' || (await this.observe()) !== 'running')
      throw new Error('RECOVERY_START_UNCONFIRMED');
    await this.save({ ...operation, stage: 'complete', backend: receipt, error: undefined });
  }
  start(id: string) {
    return this.run(`start:${id}`, async () => {
      this.current(id);
      try {
        await this.inspectOperation(id);
        this.check();
        if (this.current(id).stage !== 'complete') await this.startOperation(id);
      } catch (error) {
        if (this.failure) throw error;
        const op = this.current(id);
        if (!terminal.has(op.stage))
          await this.save({ ...op, error: 'RECOVERY_START_UNCONFIRMED' });
      }
    });
  }
  inspect(id: string) {
    return this.run(`inspect:${id}`, () => this.inspectOperation(id));
  }
  private async inspectOperation(id: string) {
    const operation = this.current(id);
    if (terminal.has(operation.stage)) return;
    const vm = await this.observe();
    this.check();
    if (vm === 'stopped' && ['stop-issued', 'start-issued'].includes(operation.stage)) {
      await this.changed({ ...operation, stage: 'stopped', error: undefined });
      return;
    }
    if (vm !== 'running') return;
    try {
      const receipt = this.reply(operation, await this.options.driver.receipt(id));
      this.check();
      if (receipt.phase === 'complete')
        await this.changed({ ...operation, stage: 'complete', backend: receipt, error: undefined });
      else if (['preparing', 'prepared'].includes(operation.stage))
        await this.changed({
          ...operation,
          stage: receipt.phase === 'cancelled' ? 'cancelled' : 'prepared',
          backend: receipt,
          error: undefined,
        });
    } catch {
      if (this.failure) throw new Error(this.failure);
    }
  }
  cancel(id: string) {
    return this.run(`cancel:${id}`, async () => {
      const operation = this.current(id);
      if (!['preparing', 'prepared'].includes(operation.stage))
        throw new Error('RECOVERY_ALREADY_ISSUED');
      const receipt = this.reply(operation, await this.options.driver.receipt(id));
      this.check();
      if (receipt.phase !== 'prepared') throw new Error('RECOVERY_ALREADY_CLAIMED');
      const cancelled = this.reply(
        operation,
        await this.options.driver.cancel(this.binding(operation)),
      );
      if (cancelled.phase !== 'cancelled') throw new Error('INVALID_RUNTIME_STATE');
      await this.save({ ...operation, stage: 'cancelled', backend: cancelled, error: undefined });
    });
  }
  async close() {
    this.abort();
    await this.active?.promise.catch(() => {});
    await this.ready;
  }
}
