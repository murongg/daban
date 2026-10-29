import { validAgentId } from '@daban/protocol';
import type { Owner } from './snapshot.js';
export class Fault extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    message = code,
  ) {
    super(message);
  }
}
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
interface LeaseState {
  enabled: boolean;
  owner: Owner;
  epoch: number;
  tail: Promise<unknown>;
  changedAt: number;
  active: number;
}
export class Control {
  #bots: Map<string, LeaseState>;
  constructor(
    ids: string[],
    private readonly clock: () => number = () => performance.now(),
  ) {
    const now = clock();
    this.#bots = new Map(
      ids.map((id) => [
        id,
        {
          enabled: true,
          owner: 'agent',
          epoch: 0,
          tail: Promise.resolve(),
          changedAt: now,
          active: 0,
        },
      ]),
    );
  }
  private change(bot: LeaseState, owner: Owner) {
    const now = this.clock();
    if (bot.enabled && bot.owner === 'agent') bot.active += Math.max(0, now - bot.changedAt);
    bot.changedAt = now;
    bot.owner = owner;
  }
  activeMilliseconds(id: string) {
    const bot = this.#get(id);
    return (
      bot.active +
      (bot.enabled && bot.owner === 'agent' ? Math.max(0, this.clock() - bot.changedAt) : 0)
    );
  }
  #get(id: string) {
    const bot = this.#bots.get(id);
    if (!bot) throw new Fault('UNKNOWN_BOT', 404);
    return bot;
  }
  state(id: string) {
    const { owner, epoch } = this.#get(id);
    return { owner, epoch };
  }
  register(id: string) {
    if (!validAgentId(id)) throw new Fault('UNKNOWN_BOT', 404);
    if (!this.#bots.has(id))
      this.#bots.set(id, {
        enabled: false,
        owner: 'agent',
        epoch: 0,
        tail: Promise.resolve(),
        changedAt: this.clock(),
        active: 0,
      });
    return this.state(id);
  }
  activate(id: string) {
    const bot = this.#get(id);
    if (bot.enabled) throw new Fault('COMPUTER_ALREADY_CONNECTED');
    this.change(bot, 'agent');
    bot.enabled = true;
    bot.epoch++;
    return this.state(id);
  }
  async revoke(id: string) {
    const bot = this.#get(id);
    if (bot.enabled) {
      this.change(bot, 'handoff');
      bot.enabled = false;
      bot.epoch++;
    }
    // Retain the logical lease and its epoch; a later attachment must not resurrect queued old work.
    await bot.tail;
    return this.state(id);
  }
  async execute<T>(
    id: string,
    actor: string,
    epoch: number,
    action: () => T | Promise<T>,
  ): Promise<T> {
    const bot = this.#get(id);
    const allowed = () => {
      if (!bot.enabled) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
      if (bot.owner !== actor || bot.epoch !== epoch || !['human', 'agent'].includes(actor))
        throw new Fault('STALE_CONTROL');
    };
    allowed();
    const pending = bot.tail.then(async () => {
      allowed();
      return action();
    });
    bot.tail = pending.catch(() => {});
    return pending;
  }
  async transfer(
    id: string,
    epoch: number,
    owner: string,
    settle: () => Promise<unknown> = async () => {},
  ) {
    const bot = this.#get(id);
    if (!bot.enabled) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
    if (
      bot.epoch !== epoch ||
      bot.owner === 'handoff' ||
      bot.owner === owner ||
      !['human', 'agent'].includes(owner)
    )
      throw new Fault('STALE_CONTROL');
    // Fence queued inputs before draining in-flight native work; each Bot owns an independent queue.
    const previous = bot.owner;
    this.change(bot, 'handoff');
    bot.epoch++;
    await bot.tail;
    try {
      await settle();
    } catch (error) {
      this.change(bot, previous);
      throw error;
    }
    this.change(bot, owner as Owner);
    return this.state(id);
  }
  async drain(id: string) {
    await this.#get(id).tail;
  }
}
