import { randomBytes } from 'node:crypto';

interface Target {
  id: number;
  send: (message: { type: 'prepare'; id: string }) => unknown;
}
export class UpdateSave {
  private pending?: {
    id: string;
    target: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => unknown;
    reject: (error: Error) => unknown;
  };
  constructor(
    private readonly target: () => Target | undefined,
    private readonly timeout = 8000,
  ) {}
  request() {
    return new Promise<undefined>((resolve, reject) => {
      const target = this.target();
      if (!target || this.pending) {
        reject(Error('UPDATE_SAVE_FAILED'));
        return;
      }
      const id = randomBytes(24).toString('hex');
      const timer = setTimeout(() => this.fail(), this.timeout);
      this.pending = { id, target: target.id, timer, resolve: () => resolve(undefined), reject };
      try {
        target.send({ type: 'prepare', id });
      } catch {
        this.fail();
      }
    });
  }
  ack(id: string, success: boolean, target: number) {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.target !== target)
      throw Error('UPDATE_SAVE_FAILED');
    clearTimeout(pending.timer);
    this.pending = undefined;
    if (success) pending.resolve();
    else pending.reject(Error('UPDATE_SAVE_FAILED'));
  }
  private fail() {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error('UPDATE_SAVE_FAILED'));
    }
  }
  close() {
    this.fail();
  }
}
