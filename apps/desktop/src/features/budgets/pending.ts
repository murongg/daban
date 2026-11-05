import { clientCache } from '../../app/cache';

export function readPending(key: string): unknown {
  try {
    const saved = clientCache().getItem(key);
    return saved ? (JSON.parse(saved) as unknown) : undefined;
  } catch {
    return undefined;
  }
}
export function writePending(key: string, value: unknown) {
  const saved = JSON.stringify(value);
  if (saved === undefined) throw new Error('BUDGET_PENDING_UNAVAILABLE');
  const cache = clientCache();
  cache.setItem(key, saved);
  if (cache.getItem(key) !== saved) throw new Error('BUDGET_PENDING_UNAVAILABLE');
}
export function clearPending(key: string) {
  clientCache().removeItem(key);
}
