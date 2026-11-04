import { readFileSync } from 'node:fs';
import { isContextBreakdownValue, isContextPressureValue, validAgentId } from '@daban/protocol';
import { type BridgeConfig, callBridge } from './bridge.js';

export const name = 'daban-context';
export const inject = ['agents', 'sessionProjections'];
interface Context {
  agents: { roots: () => { session: { id: string } }[] };
  sessionProjections: {
    onChanged: (
      listener: (session: { id: string }, key: string, value: unknown, seq: number) => unknown,
    ) => unknown;
  };
  effect: (factory: () => () => Promise<unknown>) => unknown;
}
export function apply(ctx: Context, config: BridgeConfig & { turnFile: string }) {
  type Publication = {
    sessionId: string;
    turnId: string;
    key: string;
    seq: number;
    value: unknown;
  };
  const pending = new Map<string, Publication>();
  const seen = new Map<string, number>();
  let turn: string | undefined;
  let flight: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sentAt = 0;
  let closing = false;
  const flush = () => {
    if (flight || !pending.size) return;
    const samples = [...pending.values()];
    pending.clear();
    sentAt = Date.now();
    flight = (async () => {
      for (const sample of samples)
        await callBridge(config, 'context.update', sample, AbortSignal.timeout(500)).catch(
          () => undefined,
        );
    })().finally(() => {
      flight = undefined;
      if (!closing) schedule();
    });
  };
  const schedule = () => {
    if (closing || flight || timer || !pending.size) return;
    const delay = Math.max(0, 1000 - (Date.now() - sentAt));
    if (!delay) flush();
    else
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, delay);
  };
  ctx.sessionProjections.onChanged((session, key, value, seq) => {
    const roots = ctx.agents.roots();
    if (
      closing ||
      roots.length !== 1 ||
      roots[0].session !== session ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      (key !== 'contextPressure' && key !== 'contextBreakdown') ||
      !(key === 'contextPressure' ? isContextPressureValue(value) : isContextBreakdownValue(value))
    )
      return;
    let turnId: string;
    try {
      const saved: unknown = JSON.parse(readFileSync(config.turnFile, 'utf8'));
      if (!saved || typeof saved !== 'object' || !('id' in saved) || !validAgentId(saved.id))
        return;
      turnId = saved.id;
    } catch {
      return;
    }
    if (turn !== turnId) {
      turn = turnId;
      pending.clear();
      seen.clear();
    }
    if (seq <= (seen.get(key) ?? -1)) return;
    seen.set(key, seq);
    // Ownership is frozen at receipt: a delayed send must not inherit a newer turn.json identity.
    pending.set(key, { sessionId: session.id, turnId, key, seq, value: structuredClone(value) });
    schedule();
  });
  ctx.effect(() => async () => {
    closing = true;
    clearTimeout(timer);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<unknown>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), 1200);
    });
    try {
      await Promise.race([
        (async () => {
          if (flight) await flight;
          flush();
          if (flight) await flight;
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
      pending.clear();
    }
  });
}
