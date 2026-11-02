import { beforeEach, expect, it, vi } from 'vitest';
import { beginBrowserRequest, browserRequest, clearBrowserRequest } from '../browser/browsing';
import { beginComputer, clearComputer, pendingComputer, watchComputers } from './connections';

beforeEach(() => localStorage.clear());
it('keeps only computer operation binding metadata and compares the ID before clearing it', () => {
  const pending = {
    id: 'mock-stop-op',
    bot: 'mock-custom',
    action: 'stop' as const,
    revision: 4,
    instance: 'mock-instance',
  };
  beginComputer(pending);
  expect(pendingComputer(pending.bot)).toEqual(pending);
  expect(() => beginComputer({ ...pending, id: 'mock-another' })).toThrow(
    'COMPUTER_OUTCOME_UNKNOWN',
  );
  clearComputer(pending.bot, 'mock-wrong');
  expect(pendingComputer(pending.bot)?.id).toBe(pending.id);
  clearComputer(pending.bot, pending.id);
  expect(pendingComputer(pending.bot)).toBeUndefined();
  expect(JSON.stringify(localStorage)).not.toContain('confirmation');
});
it('browser request recovery accepts a registered-style arbitrary Bot ID while retaining exact-ID clearing', () => {
  beginBrowserRequest('mock-custom-bot', {
    id: 'mock-browser-op',
    instance: 'mock-browser-instance',
    epoch: 3,
  });
  expect(browserRequest('mock-custom-bot')?.id).toBe('mock-browser-op');
  clearBrowserRequest('mock-custom-bot', 'mock-old-op');
  expect(browserRequest('mock-custom-bot')?.id).toBe('mock-browser-op');
  clearBrowserRequest('mock-custom-bot', 'mock-browser-op');
  expect(browserRequest('mock-custom-bot')).toBeUndefined();
});
it('valid Bot names cannot mistake inherited object fields for pending browser or computer requests', () => {
  expect(pendingComputer('constructor')).toBeUndefined();
  expect(browserRequest('constructor')).toBeUndefined();
  beginBrowserRequest('constructor', {
    id: 'mock-constructor-op',
    instance: 'mock-instance',
    epoch: 0,
  });
  expect(browserRequest('constructor')?.id).toBe('mock-constructor-op');
});
it('notifies a replacement pane when the old pane settles its exact operation', () => {
  const changed = vi.fn(),
    unwatch = watchComputers(changed);
  beginComputer({
    id: 'mock-pane-operation',
    bot: 'mock-pane-bot',
    action: 'connect',
    revision: 0,
  });
  clearComputer('mock-pane-bot', 'mock-wrong');
  expect(changed).toHaveBeenCalledTimes(1);
  clearComputer('mock-pane-bot', 'mock-pane-operation');
  expect(changed).toHaveBeenCalledTimes(2);
  unwatch();
  beginComputer({ id: 'mock-after-unwatch', bot: 'mock-pane-bot', action: 'connect', revision: 0 });
  expect(changed).toHaveBeenCalledTimes(2);
});
