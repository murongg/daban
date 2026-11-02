import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, value: unknown) => Promise<unknown>),
  contents: { id: 7, mainFrame: {} },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: mock.contents }] },
  ipcMain: {
    handle: (_name: string, handler: typeof mock.handler) => {
      mock.handler = handler;
    },
    removeHandler: vi.fn(),
  },
}));

import { updateIpc } from './update-ipc';
import { UpdateSave } from './update-save';
import { Updates } from './updates';

it('never checks, downloads or installs for a foreign frame or a URL supplied by the renderer', async () => {
  const owner = new Updates({ version: '1.0.0', supported: false });
  const invoke = vi.spyOn(owner, 'invoke');
  const dispose = updateIpc(owner, new UpdateSave(() => undefined), 'file:///synthetic/index.html');
  try {
    for (const url of ['https://models.example.test', 'file:///synthetic/other.html']) {
      const reply = await mock.handler!(
        { sender: mock.contents, senderFrame: { url } },
        { type: 'install' },
      );
      expect(reply).toEqual({ ok: false, error: 'UNTRUSTED_SENDER' });
    }
    Object.assign(mock.contents.mainFrame, { url: 'file:///synthetic/index.html' });
    const event = { sender: mock.contents, senderFrame: mock.contents.mainFrame };
    expect(
      await mock.handler!(event, {
        type: 'download',
        url: 'https://models.example.test/update.exe',
      }),
    ).toEqual({ ok: false, error: 'INVALID_UPDATE_COMMAND' });
    expect(invoke).not.toHaveBeenCalled();
    expect(await mock.handler!(event, { type: 'status' })).toMatchObject({
      ok: true,
      value: { phase: 'unsupported' },
    });
  } finally {
    dispose();
  }
});
