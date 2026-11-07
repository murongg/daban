import type { BrowserBinding, RuntimeReply } from '@daban/protocol';
import { BrowserWindow, ipcMain } from 'electron';
import { parseBrowserMount } from '../shared/browser';
import type { BrowserHost } from './browser-host';
import { trustedSender } from './ipc';

export function browserIpc(
  host: BrowserHost,
  rendererUrl: string,
  target: (bot: string, epoch: number, binding: BrowserBinding) => Promise<{ target: string }>,
) {
  const revisions = new Map<string, number>();
  let serial = 0;
  let selected: string | undefined;
  ipcMain.handle(
    'daban:browser',
    async (event, value): Promise<RuntimeReply<{ attached: boolean }>> => {
      const frame = event.senderFrame;
      const window = BrowserWindow.getAllWindows().find(
        (item) => item.webContents === event.sender,
      );
      if (
        !trustedSender(
          { url: frame?.url || '', mainFrame: frame === event.sender.mainFrame, owned: !!window },
          rendererUrl,
        )
      )
        return { ok: false, error: 'UNTRUSTED_SENDER' };
      try {
        const request = parseBrowserMount(value);
        if ((revisions.get(request.id) ?? -1) >= request.revision)
          return { ok: true, value: { attached: false } };
        revisions.set(request.id, request.revision);
        if (revisions.size > 128) revisions.delete(revisions.keys().next().value!);
        if (request.action === 'hide') {
          if (selected === request.id) {
            selected = undefined;
            ++serial;
          }
          host.hide(request.id);
          return { ok: true, value: { attached: false } };
        }
        selected = request.id;
        const ticket = ++serial;
        // Resolve the owned page in the Agent; the renderer never chooses a raw CDP target.
        const page = await target(request.bot, request.epoch, request.binding);
        if (ticket !== serial || revisions.get(request.id) !== request.revision)
          return { ok: true, value: { attached: false } };
        const attached = await host.present(
          request.id,
          request.bot,
          request.epoch,
          request.binding.instance,
          page.target,
          window!,
          request.bounds,
        );
        return { ok: true, value: { attached } };
      } catch {
        return { ok: false, error: 'HOST_BROWSER_DESKTOP_UNAVAILABLE' };
      }
    },
  );
  return () => {
    ++serial;
    ipcMain.removeHandler('daban:browser');
  };
}
