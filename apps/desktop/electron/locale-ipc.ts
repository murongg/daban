import type { RuntimeReply } from '@daban/protocol';
import { BrowserWindow, ipcMain } from 'electron';
import { type Locale, parseLocaleCommand } from '../locale';
import { trustedSender } from './ipc';
import type { LocalePreferences } from './locale';

export function localeIpc(
  preferences: LocalePreferences,
  rendererUrl: string,
  changed: (locale: Locale) => unknown,
) {
  ipcMain.handle('daban:locale', async (event, value): Promise<RuntimeReply<Locale>> => {
    const frame = event.senderFrame;
    if (
      !trustedSender(
        {
          url: frame?.url || '',
          mainFrame: frame === event.sender.mainFrame,
          owned: BrowserWindow.getAllWindows().some(
            (window) => window.webContents === event.sender,
          ),
        },
        rendererUrl,
      )
    )
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    try {
      const command = parseLocaleCommand(value);
      await preferences.ready;
      if (command.type === 'set') {
        await preferences.change(command.locale);
        changed(preferences.current);
      }
      return { ok: true, value: preferences.current };
    } catch {
      return { ok: false, error: 'LOCALE_STORE_UNAVAILABLE' };
    }
  });
  return () => ipcMain.removeHandler('daban:locale');
}
