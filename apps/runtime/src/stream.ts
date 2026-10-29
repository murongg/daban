import { type ReplyStream, replyLimit } from '@daban/protocol';
import { type BridgeConfig, callBridge } from './bridge.js';

type TextSnapshot = Omit<ReplyStream, 'revision'>;
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
  private types = new Map<number, boolean>();
  private blocks = new Map<number, string>();
  private text() {
    return [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .join('\n')
      .slice(0, replyLimit);
  }
  push(value: unknown): TextSnapshot | undefined {
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
        ? { text: this.text(), state: 'settled' }
        : { text: '', state: 'streaming' };
    }
    if (value.type !== 'chunk' || !record(value.chunk)) return;
    this.cursor++;
    const chunk = value.chunk;
    if (!integer(chunk.index) || chunk.index > 100000) return;
    if (chunk.type === 'block-start') {
      this.types.set(chunk.index, chunk.blockType === 'text');
      return;
    }
    if (this.types.get(chunk.index) !== true) return;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
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
      chunk.block.type === 'text' &&
      typeof chunk.block.text === 'string'
    )
      this.blocks.set(chunk.index, chunk.block.text.slice(0, replyLimit));
    else return;
    this.emitted = true;
    return { text: this.text(), state: 'streaming' };
  }
}
export class StreamPublisher {
  private revision = 0;
  private pending?: Publication;
  private timer?: ReturnType<typeof setTimeout>;
  private flight?: Promise<unknown>;
  private closing = false;
  constructor(private readonly send: (snapshot: Publication) => Promise<unknown>) {}
  push(sessionId: string, snapshot: TextSnapshot) {
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
export function apply(ctx: Context, config: BridgeConfig) {
  const publisher = new StreamPublisher((snapshot) =>
    callBridge(config, 'response.update', snapshot, new AbortController().signal),
  );
  let owner: unknown,
    collector = new StreamCollector();
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
    const snapshot = collector.push(value.frame);
    if (snapshot) publisher.push(value.agent.session.id, snapshot);
  });
  ctx.effect(() => () => publisher.close());
}
