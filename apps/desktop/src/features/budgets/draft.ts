import { type BudgetPolicy, isBudgetPolicy } from '@daban/protocol';

export function micros(value: string) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error('INVALID_BUDGET_AMOUNT');
  const result = BigInt(match[1]) * 1000000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_BUDGET_AMOUNT');
  return Number(result);
}
export function decimalMicros(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_BUDGET_AMOUNT');
  const integer = BigInt(value);
  const fraction = String(integer % 1000000n)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return String(integer / 1000000n) + (fraction ? `.${fraction}` : '');
}
export interface BudgetDraft {
  mode: BudgetPolicy['mode'];
  tools: string;
  seconds: string;
  rounds: string;
  requests: string;
  tokens: string;
  currency: string;
  amount: string;
}
export const draft = (policy: BudgetPolicy): BudgetDraft => ({
  mode: policy.mode,
  tools: String(policy.toolLimit),
  seconds: String(policy.activeMs / 1000),
  rounds: String(policy.goalRounds),
  requests: policy.maxRequests === undefined ? '' : String(policy.maxRequests),
  tokens: policy.maxTokens === undefined ? '' : String(policy.maxTokens),
  currency: policy.money?.currency ?? 'USD',
  amount: policy.money === undefined ? '' : decimalMicros(policy.money.limitMicros),
});
export function policy(value: BudgetDraft): BudgetPolicy {
  const result: BudgetPolicy = {
    mode: value.mode,
    toolLimit: Number(value.tools),
    activeMs: Number(value.seconds) * 1000,
    goalRounds: Number(value.rounds),
    ...(value.requests.trim() ? { maxRequests: Number(value.requests) } : {}),
    ...(value.tokens.trim() ? { maxTokens: Number(value.tokens) } : {}),
    ...(value.amount.trim()
      ? { money: { currency: value.currency, limitMicros: micros(value.amount) } }
      : {}),
  };
  if (!isBudgetPolicy(result)) throw new Error('INVALID_BUDGET_POLICY');
  return result;
}
export function routeLabel(key: string) {
  try {
    const value: unknown = JSON.parse(key);
    if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[2] === 'string')
      return `${value[0]} · ${value[2]}`;
  } catch {
    /* Old snapshots keep their own identity even when the connection was removed. */
  }
  return key;
}
