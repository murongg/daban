import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalePreferences } from './locale';
import { localeIpc } from './locale-ipc';

const mock = vi.hoisted(() => ({
  handler: undefined as ((event: unknown, value: unknown) => Promise<unknown>) | undefined,
  contents: undefined as unknown,
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: mock.contents }] },
  ipcMain: {
    handle: (_channel: string, handler: (event: unknown, value: unknown) => Promise<unknown>) => {
      mock.handler = handler;
    },
    removeHandler: vi.fn(),
  },
}));

it('allows only owned main-frame locale commands and does not grant runtime access', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-locale-ipc-'));
  try {
    const preferences = new LocalePreferences(path.join(directory, 'locale.json'));
    const changed = vi.fn();
    const frame = { url: 'file:///mock/dist/index.html' };
    mock.contents = { mainFrame: frame };
    const close = localeIpc(preferences, frame.url, changed);
    const event = { sender: mock.contents, senderFrame: frame };
    expect(await mock.handler!(event, { type: 'set', locale: 'en' })).toEqual({
      ok: true,
      value: 'en',
    });
    expect(changed).toHaveBeenCalledWith('en');
    for (const untrusted of [
      { sender: {}, senderFrame: frame },
      { sender: mock.contents, senderFrame: { ...frame } },
      { sender: mock.contents, senderFrame: { url: 'https://example.test' } },
    ])
      expect(await mock.handler!(untrusted, { type: 'set', locale: 'zh-CN' })).toEqual({
        ok: false,
        error: 'UNTRUSTED_SENDER',
      });
    expect(await mock.handler!(event, { type: 'set', locale: '../mock' })).toEqual({
      ok: false,
      error: 'LOCALE_STORE_UNAVAILABLE',
    });
    expect(preferences.current).toBe('en');
    close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
