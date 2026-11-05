import { afterEach, vi } from 'vitest';
import './temporary';

afterEach(() => {
  // restoreMocks does not restore fake timers between tests.
  vi.useRealTimers();
});
