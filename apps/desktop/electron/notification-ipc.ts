import type { RuntimeReply } from '@daban/protocol';
import { BrowserWindow, ipcMain } from 'electron';
import { type NoticeCommand, parseNoticeCommand } from '../notifications';
import { trustedSender } from './ipc';

export function noticeIpc(
  owner: { invoke: (command: NoticeCommand) => Promise<unknown> },
  rendererUrl: string,
) {
  ipcMain.handle('daban:notifications', async (event, value): Promise<RuntimeReply> => {
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
      return { ok: true, value: await owner.invoke(parseNoticeCommand(value)) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'NOTIFICATION_UNAVAILABLE',
      };
    }
  });
  return () => ipcMain.removeHandler('daban:notifications');
}
