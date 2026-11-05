import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { previewStorage } from '../../preview/storage';
import { beginComputer, clearComputer, pendingComputer } from '../features/computer/connections';
import { getLocale, localeStorageKey, setLocale } from '../i18n/locale';
import { App } from './App';
import { cacheForHost, clientCache, setCache } from './cache';
import { initialState, reduce } from './state';
import { serialize, storageKey } from './storage';

afterEach(() => {
  setCache();
  sessionStorage.clear();
});
const workspace = (id: string, name: string) =>
  reduce(initialState(), { type: 'create', id, name, role: '', color: 'mint' });

it('keeps a captured host store isolated when a later operation switches to another computer', () => {
  const first = cacheForHost('a'.repeat(64));
  const second = cacheForHost('b'.repeat(64));
  localStorage.setItem(storageKey, 'synthetic-local');
  first.setItem(storageKey, 'synthetic-first');
  second.setItem(storageKey, 'synthetic-second');
  first.setItem(storageKey, 'synthetic-late-first');
  expect(second.getItem(storageKey)).toBe('synthetic-second');
  expect(first.getItem(storageKey)).toBe('synthetic-late-first');
  expect(localStorage.getItem(storageKey)).toBe('synthetic-local');
  first.removeItem(storageKey);
  expect(second.getItem(storageKey)).toBe('synthetic-second');
});

it('keeps uncertain computer operations separate for equal Bot IDs on different hosts', () => {
  const first = cacheForHost('a'.repeat(64));
  const second = cacheForHost('b'.repeat(64));
  const request = {
    id: 'synthetic-first',
    bot: 'synthetic-bot',
    action: 'connect' as const,
    revision: 0,
  };
  beginComputer(request, first);
  beginComputer({ ...request, id: 'synthetic-second' }, second);
  clearComputer(request.bot, request.id, first);
  expect(pendingComputer(request.bot, first)).toBeUndefined();
  expect(pendingComputer(request.bot, second)?.id).toBe('synthetic-second');
});

it('defaults to the existing browser store and keeps preview workspace edits out of it', async () => {
  expect(clientCache()).toBe(localStorage);
  const original = serialize(workspace('mock-main', 'SYNTHETIC MAIN'));
  localStorage.setItem(storageKey, original);
  const isolated = previewStorage(sessionStorage, 'mock-preview');
  isolated.setItem(storageKey, serialize(workspace('mock-preview', 'SYNTHETIC PREVIEW')));
  setCache(isolated);
  render(<App />);
  expect(screen.getByRole('heading', { name: 'SYNTHETIC PREVIEW' })).toBeVisible();
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'SYNTHETIC DRAFT');
  expect(localStorage.getItem(storageKey)).toBe(original);
  expect(isolated.getItem(storageKey)).toContain('SYNTHETIC DRAFT');
});

it('isolates locale and uncertain computer records between real and preview stores', async () => {
  localStorage.setItem(localeStorageKey, 'zh-CN');
  const main = { id: 'mock-main-op', bot: 'a', action: 'connect' as const, revision: 0 };
  beginComputer(main);
  const isolated = previewStorage(sessionStorage, 'mock-preview');
  setCache(isolated);
  expect(pendingComputer('a')).toBeUndefined();
  await setLocale('en');
  const preview = { ...main, id: 'mock-preview-op' };
  beginComputer(preview);
  expect(pendingComputer('a')).toEqual(preview);
  expect(getLocale()).toBe('en');
  expect(localStorage.getItem(localeStorageKey)).toBe('zh-CN');
  setCache();
  expect(pendingComputer('a')).toEqual(main);
  expect(getLocale()).toBe('zh-CN');
});
