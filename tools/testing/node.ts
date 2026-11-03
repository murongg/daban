import { afterEach, vi } from 'vitest';

afterEach(() => {
  // restoreMocks does not restore fake timers between tests.
  vi.useRealTimers();
});
