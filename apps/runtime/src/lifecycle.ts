import {
  type BotLifecycleAck,
  type BotLifecycleRequest,
  type BotProfile,
  isBotLifecycleRequest,
  validAgentId,
} from '@daban/protocol';
import { Fault } from './control.js';
import type { BotProfiles } from './profiles.js';

interface Options {
  profiles: BotProfiles;
  running: (bot: string) => boolean;
  assertIdle: (bot: string) => Promise<unknown>;
  suspendSchedules: (bot: string) => Promise<unknown>;
}
function same(left: BotLifecycleRequest, right: BotLifecycleRequest) {
  return (
    left.id === right.id &&
    left.bot === right.bot &&
    left.action === right.action &&
    left.revision === right.revision
  );
}
export class BotLifecycle {
  private readonly active = new Map<
    string,
    { request: BotLifecycleRequest; promise: Promise<BotLifecycleAck> }
  >();
  private readonly incomplete = new Map<string, string>();
  private closed = false;
  constructor(readonly options: Options) {}
  private ack(profile: BotProfile, id: string): BotLifecycleAck {
    const lifecycle = profile.lifecycle;
    if (!lifecycle || lifecycle.id !== id) throw new Fault('BOT_LIFECYCLE_NOT_FOUND', 404);
    return {
      profile,
      receipt: {
        ...lifecycle,
        bot: profile.id,
        ...(lifecycle.phase === 'pending' && this.incomplete.get(profile.id) === id
          ? { error: 'BOT_ARCHIVE_INCOMPLETE' as const }
          : {}),
      },
    };
  }
  async receipt(bot: string, id: string) {
    if (!validAgentId(bot) || !validAgentId(id)) throw new Fault('INVALID_BOT_LIFECYCLE', 400);
    const profile = await this.options.profiles.get(bot);
    if (!profile) throw new Fault('BOT_LIFECYCLE_NOT_FOUND', 404);
    return this.ack(profile, id);
  }
  operate(input: unknown): Promise<BotLifecycleAck> {
    if (!isBotLifecycleRequest(input))
      return Promise.reject(new Fault('INVALID_BOT_LIFECYCLE', 400));
    if (this.closed) return Promise.reject(new Fault('BOT_LIFECYCLE_CLOSED', 503));
    const request = structuredClone(input);
    const active = this.active.get(request.bot);
    if (active)
      return same(request, active.request)
        ? active.promise
        : Promise.reject(new Fault('BOT_CHANGING'));
    const promise = this.perform(request).finally(() => {
      if (this.active.get(request.bot)?.promise === promise) this.active.delete(request.bot);
    });
    this.active.set(request.bot, { request, promise });
    return promise;
  }
  private async perform(request: BotLifecycleRequest) {
    const profiles = this.options.profiles;
    await profiles.ready;
    if (this.closed) throw new Fault('BOT_LIFECYCLE_CLOSED', 503);
    const profile = await profiles.get(request.bot);
    if (!profile) throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
    const previous = profile.lifecycle;
    if (previous?.id === request.id) {
      if (previous.action !== request.action || previous.baseRevision !== request.revision)
        throw new Fault('BOT_REQUEST_ID_REUSED');
      if (previous.phase === 'complete') return this.ack(profile, request.id);
    }
    // Reject existing work before reserving: an invalid archive must not interrupt that task's memory tools.
    if (this.options.running(request.bot)) throw new Fault('BOT_TASK_RUNNING');
    if (this.closed) throw new Fault('BOT_LIFECYCLE_CLOSED', 503);
    const release = profiles.reserveLifecycle(request.bot);
    let accepted = previous?.id === request.id && previous.phase === 'pending';
    try {
      await this.options.assertIdle(request.bot);
      if (this.closed && !accepted) throw new Fault('BOT_LIFECYCLE_CLOSED', 503);
      let current = await profiles.beginLifecycle(request);
      if (current.lifecycle?.phase === 'pending') {
        // The persisted unavailable state fences new work before touching automatic execution.
        accepted = true;
        await this.options.suspendSchedules(request.bot);
        current = await profiles.finishLifecycle(request.bot, request.id);
      }
      this.incomplete.delete(request.bot);
      return this.ack(current, request.id);
    } catch (error) {
      if (accepted) {
        this.incomplete.set(request.bot, request.id);
        throw new Fault('BOT_ARCHIVE_INCOMPLETE');
      }
      throw error instanceof Fault ? error : new Fault('BOT_LIFECYCLE_FAILED');
    } finally {
      release();
    }
  }
  async recover() {
    if (this.closed) throw new Fault('BOT_LIFECYCLE_CLOSED', 503);
    const pending = (await this.options.profiles.list()).filter(
      (profile) => profile.lifecycle?.phase === 'pending',
    );
    return Promise.allSettled(
      pending.map((profile) =>
        this.operate({
          id: profile.lifecycle!.id,
          bot: profile.id,
          action: 'archive',
          revision: profile.lifecycle!.baseRevision,
        }),
      ),
    );
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
  }
}
