import { expect, test } from 'vitest';
import { decimalMicros, micros } from './draft';

test('manual decimal prices become exact integer micro-currency without floating point rounding', () => {
  expect(micros('0.000001')).toBe(1);
  expect(micros('1.234567')).toBe(1234567);
  expect(micros('0')).toBe(0);
  expect(micros(decimalMicros(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  for (const value of ['-1', '1e2', '0.0000001', 'NaN', '9007199254740991'])
    expect(() => micros(value)).toThrow();
});
