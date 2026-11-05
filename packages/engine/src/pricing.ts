import type { BudgetPrice, ReportedUsage } from '@daban/protocol';

export function costMicros(
  usage: Omit<ReportedUsage, 'state'>,
  price: Pick<BudgetPrice, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
) {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    price.input,
    price.output,
    price.cacheRead,
    price.cacheWrite,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error('INVALID_PRICING');
  const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  if (uncached < 0) throw new Error('OVERLAPPING_USAGE');
  const buckets = [
    [uncached, price.input],
    [usage.outputTokens, price.output],
    [usage.cacheReadTokens, price.cacheRead],
    [usage.cacheWriteTokens, price.cacheWrite],
  ];
  // Round each bucket upward before adding: fractional micro-currency must never disappear.
  const total = buckets.reduce(
    (sum, [tokens, rate]) => sum + (BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n,
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('PRICING_OVERFLOW');
  return Number(total);
}
