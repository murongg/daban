import { expect, test } from 'vitest';
import { costMicros } from './pricing.js';

function cost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  price = { input: 2000000, output: 4000000, cacheRead: 500000, cacheWrite: 3000000 },
) {
  return costMicros(usage, price);
}
test('integer pricing charges each disjoint bucket once', () => {
  expect(
    cost({ inputTokens: 55, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 }),
  ).toBe(180);
  expect(
    cost(
      { inputTokens: 3, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
      { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    ),
  ).toBe(4);
});
test('pricing rejects invalid, overlapping and overflowing arithmetic', () => {
  expect(() =>
    cost({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0 }),
  ).toThrow();
  expect(() =>
    cost({ inputTokens: -1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ).toThrow();
  expect(() =>
    cost(
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
    ),
  ).toThrow();
});
