import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value: unknown) => Promise<unknown>>(),
  windows: [] as { webContents: unknown }[],
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mock.windows },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value: unknown) => Promise<unknown>) =>
      mock.handlers.set(name, handler),
    removeHandler: (name: string) => mock.handlers.delete(name),
  },
}));

import { noticeIpc } from './notification-ipc';

it('exposes only strict desktop notice commands to the owned top-level renderer', async () => {
  const invoke = vi.fn(async () => ({ available: true })),
    frame = { url: 'file:///mock/index.html' },
    sender = { mainFrame: frame };
  mock.windows = [{ webContents: sender }];
  const close = noticeIpc({ invoke }, 'file:///mock/index.html');
  const handler = mock.handlers.get('daban:notifications')!;
  try {
    expect(await handler({ sender, senderFrame: frame }, { type: 'status' })).toEqual({
      ok: true,
      value: { available: true },
    });
    expect(await handler({ sender, senderFrame: { url: frame.url } }, { type: 'test' })).toEqual({
      ok: false,
      error: 'UNTRUSTED_SENDER',
    });
    expect(
      await handler(
        { sender, senderFrame: frame },
        { type: 'test', script: 'SYNTHETIC INJECTION' },
      ),
    ).toEqual({ ok: false, error: 'INVALID_NOTIFICATION_COMMAND' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const command = {
      type: 'bot.configure',
      scope: 'a'.repeat(64),
      bot: 'mock-alpha',
      revision: 0,
      enabled: false,
    };
    expect(await handler({ sender, senderFrame: frame }, command)).toEqual({
      ok: true,
      value: { available: true },
    });
    expect(invoke).toHaveBeenLastCalledWith(command);
    expect(await handler({ sender, senderFrame: { url: frame.url } }, command)).toEqual({
      ok: false,
      error: 'UNTRUSTED_SENDER',
    });
    expect(await handler({ sender, senderFrame: frame }, { ...command, approved: true })).toEqual({
      ok: false,
      error: 'INVALID_NOTIFICATION_COMMAND',
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    close();
    mock.windows = [];
  }
  expect(mock.handlers.has('daban:notifications')).toBe(false);
});
