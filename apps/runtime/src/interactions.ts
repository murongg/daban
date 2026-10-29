import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Interaction,
  isInteraction,
  isInteractionInput,
  isUserReply,
  matchesReply,
  validAgentId,
} from '@daban/protocol';
import { Fault } from './control.js';

export class Interactions {
  readonly ready: Promise<unknown>;
  private records = new Map<string, Interaction>();
  private corrupt = new Set<string>();
  private closed = new Set<string>();
  private listeners = new Map<string, Set<(value: Interaction) => unknown>>();
  private writing: Promise<unknown> = Promise.resolve();
  private canonical = '';
  constructor(
    readonly directory: string,
    private readonly onChange?: (value: Interaction) => unknown,
  ) {
    this.ready = this.load();
  }
  async status() {
    await this.ready;
    return { available: true, corrupt: this.corrupt.size };
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.canonical = await realpath(this.directory);
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json') || !validAgentId(name.slice(0, -5))) continue;
      const id = name.slice(0, -5);
      try {
        const file = path.join(this.directory, name),
          info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
          throw new Error('invalid record');
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (value.version !== 1 || !isInteraction(value.request) || value.request.id !== id)
          throw new Error('invalid record');
        const item: Interaction = value.request;
        this.closed.add(`${item.bot}/${item.runId}`);
        if (item.status === 'pending') {
          item.status = 'interrupted';
          item.updatedAt = new Date().toISOString();
          this.closed.add(`${item.bot}/${item.runId}`);
          await this.commit(item);
        } else this.records.set(id, item);
      } catch {
        this.corrupt.add(id);
      }
    }
  }
  private async commit(value: Interaction) {
    if ((await realpath(this.directory)) !== this.canonical)
      throw new Fault('INTERACTION_DIRECTORY_MOVED');
    const file = path.join(this.directory, `${value.id}.json`),
      temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, request: value }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
    if (value.status === 'resolved' && this.closed.has(`${value.bot}/${value.runId}`)) {
      // Stop may arrive while the decision is being written. Withdraw it before any waiter can receive a grant.
      await this.commit({
        ...value,
        reply: undefined,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      });
      throw new Fault('INTERACTION_CLOSED');
    }
    // Publish and release the model only after the decision has committed to disk.
    this.records.set(value.id, structuredClone(value));
    this.onChange?.(structuredClone(value));
    if (value.status !== 'pending')
      for (const listener of this.listeners.get(value.id) || []) listener(structuredClone(value));
    return structuredClone(value);
  }
  private mutate<T>(action: () => Promise<T>) {
    const pending = this.writing.then(async () => {
      await this.ready;
      return action();
    });
    this.writing = pending.catch(() => {});
    return pending;
  }
  private find(bot: string, runId: string, id: string) {
    const item = this.records.get(id);
    if (!item || item.bot !== bot || item.runId !== runId)
      throw new Fault('INTERACTION_NOT_FOUND', 404);
    return item;
  }
  open(bot: string, runId: string, input: unknown, conversationId?: string) {
    if (
      !validAgentId(bot) ||
      !validAgentId(runId) ||
      !isInteractionInput(input) ||
      (conversationId !== undefined && !validAgentId(conversationId))
    )
      return Promise.reject(new Fault('INVALID_INTERACTION', 400));
    const value = structuredClone(input);
    return this.mutate(async () => {
      if (this.corrupt.has(value.id)) throw new Fault('INTERACTION_CORRUPT');
      if (this.closed.has(`${bot}/${runId}`)) throw new Fault('INTERACTION_CLOSED');
      const existing = this.records.get(value.id);
      if (existing) {
        const {
          createdAt: _created,
          updatedAt: _updated,
          status: _status,
          reply: _reply,
          ...original
        } = existing;
        if (
          JSON.stringify(original) !==
          JSON.stringify({ ...value, bot, runId, ...(conversationId ? { conversationId } : {}) })
        )
          throw new Fault('INTERACTION_CONFLICT');
        return structuredClone(existing);
      }
      const now = new Date().toISOString();
      return this.commit({
        ...value,
        bot,
        runId,
        ...(conversationId ? { conversationId } : {}),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    });
  }
  reply(bot: string, runId: string, id: string, reply: unknown) {
    if (!isUserReply(reply)) return Promise.reject(new Fault('INVALID_INTERACTION_REPLY', 400));
    const submitted = structuredClone(reply);
    return this.mutate(async () => {
      const item = this.find(bot, runId, id);
      if (!matchesReply(item, submitted)) throw new Fault('INVALID_INTERACTION_REPLY', 400);
      if (item.status === 'resolved') {
        if (JSON.stringify(item.reply) !== JSON.stringify(submitted))
          throw new Fault('INTERACTION_CONFLICT');
        return structuredClone(item);
      }
      if (item.status !== 'pending' || this.closed.has(`${bot}/${runId}`))
        throw new Fault('INTERACTION_CLOSED');
      return this.commit({
        ...item,
        reply: submitted,
        status: 'resolved',
        updatedAt: new Date().toISOString(),
      });
    });
  }
  async list() {
    await this.ready;
    await this.writing;
    return [...this.records.values()]
      .map((value) => structuredClone(value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  pending(bot: string, runId: string) {
    return [...this.records.values()].some(
      (item) => item.bot === bot && item.runId === runId && item.status === 'pending',
    );
  }
  async wait(bot: string, runId: string, id: string, signal?: AbortSignal) {
    await this.ready;
    await this.writing;
    signal?.throwIfAborted();
    const current = this.find(bot, runId, id);
    if (current.status !== 'pending') return structuredClone(current);
    return new Promise<Interaction>((resolve, reject) => {
      const listeners = this.listeners.get(id) || new Set();
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        if (!listeners.size) this.listeners.delete(id);
        signal?.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new Fault('MODEL_CANCELLED'));
      };
      const finish = (item: Interaction) => {
        cleanup();
        resolve(structuredClone(item));
      };
      listeners.add(finish);
      this.listeners.set(id, listeners);
      timer = setTimeout(() => finish(this.find(bot, runId, id)), 15000);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  cancel(bot: string, runId: string, id: string) {
    return this.mutate(async () => {
      const item = this.find(bot, runId, id);
      return item.status === 'pending'
        ? this.commit({ ...item, status: 'cancelled', updatedAt: new Date().toISOString() })
        : structuredClone(item);
    });
  }
  endRun(bot: string, runId: string) {
    this.closed.add(`${bot}/${runId}`);
    return this.mutate(async () => {
      for (const item of this.records.values())
        if (item.bot === bot && item.runId === runId && item.status === 'pending')
          await this.commit({ ...item, status: 'cancelled', updatedAt: new Date().toISOString() });
    });
  }
}
