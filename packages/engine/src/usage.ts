import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { BudgetScope, ModelApi, TokenUsage, UsagePurpose } from '@daban/protocol';
import { type BridgeConfig, BridgeRejected, callBridge, callBudgetBridge } from './bridge.js';
import { inferenceUsage } from './inference.js';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export interface UsageMeter {
  api: ModelApi;
  begin: (request: Request) => Promise<string | undefined>;
  report: (id: string, usage: TokenUsage) => Promise<unknown>;
}
class WireUsage {
  private decoder = new TextDecoder();
  private buffer = '';
  private invalid = false;
  private complete = false;
  private latest: TokenUsage = { state: 'unknown', reason: 'PROVIDER_USAGE_MISSING' };
  private anthropic: Record<string, unknown> = {};
  constructor(
    private api: ModelApi,
    private sse: boolean,
  ) {}
  push(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > 262144) {
      this.invalid = true;
      this.buffer = '';
      return;
    }
    if (!this.sse) return;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.startsWith('data:')) this.event(line.slice(5).trim());
      index = this.buffer.indexOf('\n');
    }
  }
  private event(data: string) {
    if (data === '[DONE]') {
      this.complete = true;
      return;
    }
    if (!data) return;
    try {
      const value: unknown = JSON.parse(data);
      if (!object(value)) return;
      if (value.type === 'message_stop' || value.type === 'response.completed')
        this.complete = true;
      let wire = value;
      if (object(value.response)) wire = value.response;
      if (this.api === 'anthropic-messages') {
        const partial = object(value.message) ? value.message.usage : value.usage;
        if (object(partial)) Object.assign(this.anthropic, partial);
        wire = { usage: this.anthropic };
      }
      if (object(wire.usage)) {
        const next = inferenceUsage(this.api, wire);
        // SSE usage is a cumulative snapshot, not a delta. Repeated snapshots must never be summed.
        if (
          next.state === 'reported' &&
          this.latest.state === 'reported' &&
          (next.inputTokens < this.latest.inputTokens ||
            next.outputTokens < this.latest.outputTokens)
        )
          this.invalid = true;
        this.latest = next;
      }
    } catch {
      this.invalid = true;
    }
  }
  terminal(): TokenUsage | undefined {
    return this.complete && !this.invalid ? this.latest : undefined;
  }
  finish(): TokenUsage {
    this.buffer += this.decoder.decode();
    if (!this.sse) {
      this.event(this.buffer);
      this.complete = true;
    }
    if (this.invalid || !this.complete)
      return { state: 'unknown', reason: 'PROVIDER_STREAM_INCOMPLETE_OR_INVALID' };
    return this.latest;
  }
}
export function usageFetch(
  meter: UsageMeter,
  upstream: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    request.signal.throwIfAborted();
    const id = await meter.begin(request);
    request.signal.throwIfAborted();
    if (id === undefined) return upstream(input, init);
    let reported = false;
    const settle = async (usage: TokenUsage) => {
      if (reported) return;
      reported = true;
      await meter.report(id, usage);
    };
    let response: Response;
    try {
      response = await upstream(input, { ...init, redirect: 'error' });
    } catch (error) {
      await settle({ state: 'unknown', reason: 'PROVIDER_NETWORK_FAILURE' });
      throw error;
    }
    if (!response.body) {
      await settle({ state: 'unknown', reason: 'PROVIDER_BODY_MISSING' });
      return response;
    }
    const collector = new WireUsage(
      meter.api,
      response.headers.get('content-type')?.includes('text/event-stream') === true,
    );
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              await settle(
                response.ok
                  ? collector.finish()
                  : { state: 'unknown', reason: 'PROVIDER_HTTP_ERROR' },
              );
              controller.close();
            } else {
              collector.push(part.value);
              controller.enqueue(part.value);
            }
          } catch (error) {
            await settle(
              response.ok
                ? (collector.terminal() ?? {
                    state: 'unknown',
                    reason: 'PROVIDER_STREAM_INTERRUPTED',
                  })
                : { state: 'unknown', reason: 'PROVIDER_HTTP_ERROR' },
            );
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            // SDK adapters may stop reading after a terminal frame. A fully observed provider receipt remains valid.
            await settle(
              response.ok
                ? (collector.terminal() ?? {
                    state: 'unknown',
                    reason: 'PROVIDER_STREAM_CANCELLED',
                  })
                : { state: 'unknown', reason: 'PROVIDER_HTTP_ERROR' },
            );
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export const name = 'daban-usage';
export const inject = ['agents'];
interface Agent {
  id: string;
  session: { id: string };
}
interface LlmOptions {
  sessionId?: string;
  purpose?: 'compaction' | 'session-title';
  provider: string;
  model: string;
}
interface Context {
  agents: {
    roots(): Agent[];
    get(id: string): Agent | undefined;
    isOwnedBy(id: string, owner: Agent): boolean;
  };
  on(
    event: 'llm/stream',
    listener: (options: LlmOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>,
  ): unknown;
  effect(factory: () => () => Promise<unknown>): unknown;
}
export interface UsageConfig extends BridgeConfig {
  scope: BudgetScope;
  runId: string;
  modelAttemptId: string;
  routeKey: string;
  api: ModelApi;
  baseURL: string;
  model: string;
  provider: string;
  strict: boolean;
}
export function apply(ctx: Context, config: UsageConfig) {
  const lineage = new AsyncLocalStorage<{
    sessionId: string;
    rootSessionId: string;
    purpose: UsagePurpose;
  }>();
  const previous = globalThis.fetch;
  const sends = new Set<Promise<unknown>>();
  let gap = !['openai-completions', 'openai-responses'].includes(config.api);
  const endpoint =
    config.baseURL.replace(/\/+$/, '') +
    (config.api === 'openai-responses'
      ? '/responses'
      : config.api === 'anthropic-messages'
        ? '/v1/messages'
        : '/chat/completions');
  const wrapped = usageFetch(
    {
      api: config.api,
      begin: async (request) => {
        if (request.url === config.url || request.method !== 'POST') return undefined;
        if (request.url !== endpoint) {
          if (lineage.getStore()) {
            gap = true;
            if (config.strict) throw new Error('BUDGET_ROUTE_UNSUPPORTED');
          }
          return undefined;
        }
        const owner = lineage.getStore();
        if (!owner) throw new Error('BUDGET_SESSION_OWNER_UNAVAILABLE');
        const bytes = Buffer.from(await request.clone().arrayBuffer());
        const requestHash = createHash('sha256').update(bytes).digest('hex');
        const payload: unknown = JSON.parse(bytes.toString('utf8'));
        if (!object(payload) || payload.model !== config.model)
          throw new Error('BUDGET_ROUTE_MISMATCH');
        const id = randomUUID();
        try {
          const result = await callBudgetBridge(
            config,
            'budget.reserve',
            {
              scope: config.scope,
              modelAttemptId: config.modelAttemptId,
              attemptId: id,
              requestHash,
              ...owner,
            },
            AbortSignal.timeout(5000),
          );
          if (object(result) && result.statisticsUnavailable === true && !config.strict) {
            gap = true;
            return undefined;
          }
          if (!object(result) || result.accepted !== true) throw new BridgeRejected(200);
          const sent = await callBudgetBridge(
            config,
            'budget.dispatched',
            { scope: config.scope, modelAttemptId: config.modelAttemptId, attemptId: id },
            AbortSignal.timeout(5000),
          );
          if (object(sent) && sent.statisticsUnavailable === true && !config.strict) {
            gap = true;
            return undefined;
          }
          if (!object(sent) || sent.send !== true) throw new BridgeRejected(200);
          return id;
        } catch (error) {
          gap = true;
          if (config.strict || error instanceof BridgeRejected) throw error;
          request.signal.throwIfAborted();
          return undefined;
        }
      },
      report: async (id, usage) => {
        const operation = callBridge(
          config,
          'budget.report',
          { scope: config.scope, runId: config.runId, attemptId: id, usage },
          AbortSignal.timeout(5000),
        );
        sends.add(operation);
        try {
          await operation;
        } catch (error) {
          gap = true;
          if (config.strict) throw error;
        } finally {
          sends.delete(operation);
        }
      },
    },
    previous,
  );
  globalThis.fetch = wrapped;
  ctx.on('llm/stream', async function* (options, next) {
    if (options.model !== config.model || options.provider !== config.provider)
      throw new Error('BUDGET_ROUTE_MISMATCH');
    const roots = ctx.agents.roots();
    const root = roots.length === 1 ? roots[0] : undefined;
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : root;
    if (!root || !agent || (agent !== root && !ctx.agents.isOwnedBy(agent.id, root)))
      throw new Error('BUDGET_SESSION_OWNER_UNAVAILABLE');
    const purpose: UsagePurpose = options.purpose ?? (agent === root ? 'main' : 'subtask');
    const owner = { sessionId: agent.session.id, rootSessionId: root.session.id, purpose };
    const iterator = lineage.run(owner, () => next()[Symbol.asyncIterator]());
    try {
      for (;;) {
        const part = await lineage.run(owner, () => iterator.next());
        if (part.done) return;
        yield part.value;
      }
    } finally {
      if (iterator.return) await lineage.run(owner, () => iterator.return!());
    }
  });
  ctx.effect(() => async () => {
    await Promise.allSettled([...sends]);
    await callBridge(
      config,
      'budget.coverage',
      { scope: config.scope, modelAttemptId: config.modelAttemptId, complete: !gap },
      AbortSignal.timeout(2000),
    ).catch(() => undefined);
    if (globalThis.fetch === wrapped) globalThis.fetch = previous;
  });
}

export function usagePatch(patch: readonly unknown[], config?: UsageConfig) {
  if (!config) return patch;
  return patch.map((item) => {
    if (!object(item) || !Array.isArray(item.insert)) return item;
    const entries: unknown[] = item.insert.map((entry: unknown) =>
      object(entry) && entry.id === 'daban-budget' && object(entry.config)
        ? { ...entry, config: { ...entry.config, budget: config.scope } }
        : entry,
    );
    const index = entries.findIndex((entry) => object(entry) && entry.id === 'daban-prompt-cache');
    const at = index < 0 ? 0 : index;
    // Meter below cacheFetch: its unsupported-parameter downgrade is a second actual provider send.
    return {
      ...item,
      insert: [
        ...entries.slice(0, at),
        { id: 'usage-bridge', name: new URL('./usage.js', import.meta.url).href, config },
        ...entries.slice(at),
      ],
    };
  });
}
