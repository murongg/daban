import { isSessionStats, type SessionStats } from '@daban/protocol';
import { type BridgeConfig, callBridge } from './bridge.js';

export const name = 'daban-statistics';
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

export function apply(ctx: Context, config: BridgeConfig) {
  let latest: { sessionId: string; seq: number; stats: SessionStats } | undefined;
  let flight: Promise<unknown> | undefined;
  const pump = () => {
    if (flight || !latest) return;
    const snapshot = latest;
    latest = undefined;
    flight = callBridge(config, 'statistics.update', snapshot, AbortSignal.timeout(1000))
      .catch(() => undefined)
      .finally(() => {
        flight = undefined;
        pump();
      });
  };
  ctx.sessionProjections.onChanged((session, key, value, seq) => {
    const roots = ctx.agents.roots();
    // Only the exact live root may publish metrics; matching a restored or child session id is insufficient.
    if (
      key !== 'sessionStats' ||
      roots.length !== 1 ||
      roots[0].session !== session ||
      !isSessionStats(value)
    )
      return;
    latest = { sessionId: session.id, seq, stats: structuredClone(value) };
    pump();
  });
  // Flush accepted snapshots before the SDK process exits, without making optional metrics a task failure.
  ctx.effect(() => async () => {
    while (flight) await flight;
  });
}
