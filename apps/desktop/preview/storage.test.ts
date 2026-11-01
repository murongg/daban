import { afterEach, expect, it } from 'vitest';
import { clientCache, setCache } from '../src/cache';
import { previewStorage, startPreview } from './storage';

afterEach(() => {
  setCache();
  sessionStorage.clear();
});
it('persists a scene in session storage while keeping other scenes and unrelated keys isolated', () => {
  sessionStorage.setItem('mock-unrelated', 'SYNTHETIC KEEP');
  const tasks = previewStorage(sessionStorage, 'tasks');
  tasks.setItem('draft', 'SYNTHETIC TASK DRAFT');
  expect(previewStorage(sessionStorage, 'tasks').getItem('draft')).toBe('SYNTHETIC TASK DRAFT');
  expect(previewStorage(sessionStorage, 'notes').getItem('draft')).toBeNull();
  tasks.removeItem('draft');
  expect(sessionStorage.getItem('mock-unrelated')).toBe('SYNTHETIC KEEP');
});
it('sets the storage boundary before loading a specimen and preserves storage failures', async () => {
  await startPreview(sessionStorage, 'mock-scene', async () => {
    clientCache().setItem('mock', 'SYNTHETIC VALUE');
  });
  expect(localStorage.getItem('mock')).toBeNull();
  expect(previewStorage(sessionStorage, 'mock-scene').getItem('mock')).toBe('SYNTHETIC VALUE');
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error('MOCK QUOTA');
    },
    removeItem: () => {},
  };
  setCache(previewStorage(broken, 'mock-scene'));
  expect(() => clientCache().setItem('mock', 'value')).toThrow('MOCK QUOTA');
});

it('applies a validated preview language before loading without changing the main preference', async () => {
  localStorage.setItem('daban.language.v1', 'zh-CN');
  await startPreview(
    sessionStorage,
    'mock-language',
    async () => {
      expect(clientCache().getItem('daban.language.v1')).toBe('en');
      expect(document.documentElement.lang).toBe('en');
    },
    'en',
  );
  expect(localStorage.getItem('daban.language.v1')).toBe('zh-CN');
});
