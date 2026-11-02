import { BrowserWindow, ipcMain } from 'electron';
import { parseUpdateCommand } from '../shared/updates';
import { trustedSender } from './ipc';
import type { UpdateSave } from './update-save';
import type { Updates } from './updates';

export function updateIpc(owner: Updates, save: UpdateSave, rendererUrl: string) {
  ipcMain.handle('daban:updates', async (event, value) => {
    const frame = event.senderFrame;
    if (
      !trustedSender(
        {
          url: frame?.url ?? '',
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
      const command = parseUpdateCommand(value);
      if (command.type === 'saved') {
        save.ack(command.id, command.success, event.sender.id);
        return { ok: true, value: owner.status() };
      }
      return { ok: true, value: await owner.invoke(command) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'UPDATE_INSTALL_FAILED',
      };
    }
  });
  return () => {
    ipcMain.removeHandler('daban:updates');
    save.close();
  };
}
