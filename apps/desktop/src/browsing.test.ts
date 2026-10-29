import { afterEach, expect, it } from 'vitest';
import { beginBrowserRequest, browserRequest, clearBrowserRequest } from './browsing';

afterEach(() => localStorage.clear());
it('retains only the owned request identity across remounts, prevents overwrite and clears by exact identity', () => {
  const first = { id: 'mock-request', instance: 'mock-instance', epoch: 3 };
  beginBrowserRequest('a', first);
  expect(browserRequest('a')).toEqual(first);
  expect(browserRequest('b')).toBeUndefined();
  expect(() => beginBrowserRequest('a', { ...first, id: 'mock-second' })).toThrow(
    'BROWSER_OUTCOME_UNKNOWN',
  );
  clearBrowserRequest('a', 'mock-second');
  expect(browserRequest('a')).toEqual(first);
  expect(Object.keys(JSON.parse(localStorage.getItem('daban-browser-pending-v1')!).a)).toEqual([
    'id',
    'instance',
    'epoch',
  ]);
  clearBrowserRequest('a', first.id);
  expect(browserRequest('a')).toBeUndefined();
});
it('refuses corrupt pending state instead of replaying or silently replacing it', () => {
  localStorage.setItem('daban-browser-pending-v1', '{"a":{"url":"https://example.test/private"}}');
  expect(() => browserRequest('a')).toThrow('BROWSER_REQUEST_STORAGE_UNAVAILABLE');
  expect(() =>
    beginBrowserRequest('a', { id: 'mock-request', instance: 'mock-instance', epoch: 3 }),
  ).toThrow('BROWSER_REQUEST_STORAGE_UNAVAILABLE');
  expect(localStorage.getItem('daban-browser-pending-v1')).toContain('private');
});
