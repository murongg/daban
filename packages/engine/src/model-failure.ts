export type ModelFailure = 'auth' | 'quota' | 'rate-limit' | 'unavailable' | 'timeout' | 'unknown';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function modelFailure(value: unknown): ModelFailure {
  if (value instanceof ModelFailureError) return value.failure;
  if (!object(value)) return 'unknown';
  // An explicit non-provider code (abort, policy, budget or validation) wins over an incidental status.
  if (value.code !== undefined) {
    switch (value.code) {
      case 'AUTH':
        return 'auth';
      case 'QUOTA':
      case 'ACCOUNT_QUOTA':
        return 'quota';
      case 'RATE_LIMIT':
        return 'rate-limit';
      case 'SERVER':
        return 'unavailable';
      case 'TIMEOUT':
        return 'timeout';
      default:
        return 'unknown';
    }
  }
  if (value.status === 401 || value.status === 403) return 'auth';
  if (value.status === 402) return 'quota';
  if (value.status === 429) return 'rate-limit';
  if (
    Number.isSafeInteger(value.status) &&
    Number(value.status) >= 500 &&
    Number(value.status) <= 599
  )
    return 'unavailable';
  return 'unknown';
}
export class ModelFailureError extends Error {
  readonly failure: ModelFailure;
  constructor(value: unknown) {
    const failure = modelFailure(value);
    super(`MODEL_PROVIDER_${failure.replace('-', '_').toUpperCase()}`);
    this.failure = failure;
  }
}
export function turnFailure(value: unknown): unknown {
  if (!object(value) || !Array.isArray(value.events)) return undefined;
  for (const event of [...value.events].reverse()) {
    if (
      !object(event) ||
      event.type !== 'turn/end' ||
      !object(event.data) ||
      !object(event.data.reason)
    )
      continue;
    const reason = event.data.reason;
    if (reason.kind === 'error') return reason.error || { code: 'UNKNOWN' };
    if (reason.kind === 'aborted') return { code: 'ABORTED' };
    if (reason.kind === 'blocked') return { code: 'BLOCKED' };
    return undefined;
  }
  return undefined;
}
