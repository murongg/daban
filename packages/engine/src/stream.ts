import { readFileSync } from 'node:fs';
import { type ReplyStream, replyLimit, validAgentId } from '@daban/protocol';
import { type BridgeConfig, callBridge } from './bridge.js';

type StreamSnapshot = Omit<ReplyStream, 'revision'>;
type Publication = ReplyStream & { sessionId: string };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export class StreamCollector {
  private revision = 0;
  private attempt = '';
  private cursor = 0;
  private active = false;
  private emitted = false;
  private types = new Map<number, 'text' | 'reasoning'>();
  private blocks = new Map<number, string>();
  private thinkingId = '';
  private text(type: 'text' | 'reasoning' = 'text') {
    return [...this.blocks.entries()]
      .filter(([index]) => this.types.get(index) === type)
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join('\n')
      .slice(0, replyLimit);
  }
  private snapshot(state: ReplyStream['state']): StreamSnapshot {
    const thinking = this.text('reasoning');
    return {
      text: this.text(),
      state,
      ...(thinking && this.thinkingId ? { thinking: { id: this.thinkingId, text: thinking } } : {}),
    };
  }
  push(value: unknown): StreamSnapshot | undefined {
    if (
      !record(value) ||
      !integer(value.revision) ||
      value.revision <= this.revision ||
      typeof value.attemptId !== 'string' ||
      !value.attemptId ||
      value.attemptId.length > 200
    )
      return;
    if (value.type === 'start') {
      const discard = this.active && this.emitted;
      this.revision = value.revision;
      this.attempt = value.attemptId;
      this.cursor = 0;
      this.active = true;
      this.emitted = false;
      this.types.clear();
      this.blocks.clear();
      // Native turn/step stays stable when this transient prefix becomes a durable assistant event.
      this.thinkingId =
        integer(value.turn) && integer(value.step) ? `${value.turn}:${value.step}` : '';
      return discard ? { text: '', state: 'streaming' } : undefined;
    }
    if (!this.active || value.attemptId !== this.attempt) return;
    this.revision = value.revision;
    if (!integer(value.index) || value.index !== this.cursor) {
      this.active = false;
      return this.emitted ? { text: '', state: 'streaming' } : undefined;
    }
    if (value.type === 'end') {
      this.active = false;
      if (!this.emitted) return;
      return record(value.outcome) &&
        value.outcome.kind === 'committed' &&
        value.outcome.eventType === 'assistant/message'
        ? this.snapshot('settled')
        : { text: '', state: 'streaming' };
    }
    if (value.type !== 'chunk' || !record(value.chunk)) return;
    this.cursor++;
    const chunk = value.chunk;
    if (!integer(chunk.index) || chunk.index > 100000) return;
    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'text' || chunk.blockType === 'reasoning')
        this.types.set(chunk.index, chunk.blockType);
      return;
    }
    const type = this.types.get(chunk.index);
    if (!type) return;
    if (chunk.type === `${type}-delta` && typeof chunk.text === 'string')
      this.blocks.set(
        chunk.index,
        ((this.blocks.get(chunk.index) || '') + chunk.text.slice(0, replyLimit)).slice(
          0,
          replyLimit,
        ),
      );
    else if (
      chunk.type === 'block-end' &&
      record(chunk.block) &&
      chunk.block.type === type &&
      typeof chunk.block.text === 'string'
    )
      this.blocks.set(chunk.index, chunk.block.text.slice(0, replyLimit));
    else return;
    this.emitted = true;
    return this.snapshot('streaming');
  }
}
export class StreamPublisher {
  private revision = 0;
  private pending?: Publication;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<unknown>;
  private closing = false;
  constructor(private readonly send: (snapshot: Publication) => Promise<unknown>) {}
  push(sessionId: string, snapshot: StreamSnapshot) {
    if (this.closing) return;
    this.pending = { sessionId, revision: ++this.revision, ...snapshot };
    this.schedule();
  }
  private schedule() {
    if (!this.timer && !this.flight && !this.closing)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump().catch(() => {});
      }, 100);
  }
  private async pump() {
    if (this.flight || !this.pending) return;
    const snapshot = this.pending;
    this.pending = undefined;
    this.flight = this.send(snapshot)
      .catch(() => {
        if (!this.pending || this.pending.revision < snapshot.revision) this.pending = snapshot;
      })
      .finally(() => {
        this.flight = undefined;
        if (this.pending) this.schedule();
      });
    await this.flight;
  }
  async close() {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.flight;
    await this.pump();
    this.pending = undefined;
  }
}
export const name = 'daban-stream';
export const inject = ['agents'];
interface Context {
  agents: { roots: () => unknown[] };
  on: (event: string, listener: (payload: unknown) => unknown) => unknown;
  effect: (factory: () => () => Promise<unknown>) => unknown;
}
export function apply(
  ctx: Context,
  config: BridgeConfig & { turnFile?: string; attemptId?: string },
) {
  let produced = false;
  let lastOutput: { sessionId: string; snapshot: StreamSnapshot } | undefined;
  const publisher = new StreamPublisher((snapshot) =>
    callBridge(config, 'response.update', snapshot, new AbortController().signal),
  );
  let owner: unknown,
    collector = new StreamCollector(),
    turnId: string | undefined;
  ctx.on('agent/assistant-stream', (value) => {
    if (
      !record(value) ||
      !record(value.agent) ||
      !record(value.agent.session) ||
      typeof value.agent.session.id !== 'string'
    )
      return;
    const roots = ctx.agents.roots();
    // One SDK process serves one accepted task. Only its exact live root can publish user-visible output.
    if (roots.length !== 1 || roots[0] !== value.agent) return;
    if (owner !== value.agent) {
      owner = value.agent;
      collector = new StreamCollector();
    }
    if (record(value.frame) && value.frame.type === 'start' && config.turnFile) {
      // Capture once at production, before coalescing/network retries can outlive this turn.
      turnId = undefined;
      try {
        const current: unknown = JSON.parse(readFileSync(config.turnFile, 'utf8'));
        if (record(current) && validAgentId(current.id)) turnId = current.id;
      } catch {
        // Without proven ownership no visible text may be attributed to another turn.
      }
    }
    const snapshot = collector.push(value.frame);
    if (snapshot && (!config.turnFile || turnId)) {
      if (snapshot.text || snapshot.thinking?.text) {
        produced = true;
        lastOutput = {
          sessionId: value.agent.session.id,
          snapshot: { ...snapshot, ...(turnId ? { turnId } : {}) },
        };
      }
      publisher.push(value.agent.session.id, { ...snapshot, ...(turnId ? { turnId } : {}) });
    }
  });
  ctx.effect(() => async () => {
    // A coalesced discard must not erase evidence that text/reasoning was produced in this attempt.
    if (config.attemptId && lastOutput) publisher.push(lastOutput.sessionId, lastOutput.snapshot);
    await publisher.close();
    if (config.attemptId) {
      const roots = ctx.agents.roots();
      const root = record(owner)
        ? owner
        : roots.length === 1 && record(roots[0])
          ? roots[0]
          : undefined;
      if (!root || !record(root.session) || typeof root.session.id !== 'string')
        throw new Error('MODEL_ATTEMPT_DRAIN_UNCONFIRMED');
      const result = await callBridge(
        config,
        'attempt.closed',
        {
          sessionId: root.session.id,
          attemptId: config.attemptId,
          fence: produced ? 'output' : 'clean',
        },
        AbortSignal.timeout(2000),
      );
      if (!record(result) || result.accepted !== true)
        throw new Error('MODEL_ATTEMPT_DRAIN_UNCONFIRMED');
    }
  });
}
