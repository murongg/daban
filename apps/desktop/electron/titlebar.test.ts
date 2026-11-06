import { beforeEach, expect, it, vi } from 'vitest';
import { titlebarIpc, titlebarOptions } from './titlebar';

const mock = vi.hoisted(() => ({
  handler: undefined as ((event: unknown, value: unknown) => boolean) | undefined,
  windows: [] as { webContents: unknown; setTitleBarOverlay: ReturnType<typeof vi.fn> }[],
  removeHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mock.windows },
  ipcMain: {
    handle: (_channel: string, handler: (event: unknown, value: unknown) => boolean) => {
      mock.handler = handler;
    },
    removeHandler: mock.removeHandler,
  },
}));

beforeEach(() => {
  mock.windows = [];
});

it('integrates native Windows controls while retaining the macOS and Linux frame styles', () => {
  expect(titlebarOptions('win32')).toEqual({
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#252523', height: 56 },
  });
  expect(titlebarOptions('darwin')).toEqual({
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 28 },
  });
  expect(titlebarOptions('linux')).toEqual({});
});

it('matches native controls to the app theme only for the owned Windows main frame', () => {
  const frame = { url: 'file:///mock/dist/index.html' };
  const contents = { mainFrame: frame };
  const setTitleBarOverlay = vi.fn();
  mock.windows = [{ webContents: contents, setTitleBarOverlay }];
  const close = titlebarIpc(frame.url, 'win32');
  const event = { sender: contents, senderFrame: frame };
  expect(mock.handler!(event, 'dark')).toBe(true);
  expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
    color: '#1c1c1a',
    symbolColor: '#eaeae5',
  });
  expect(mock.handler!(event, 'light')).toBe(true);
  expect(setTitleBarOverlay).toHaveBeenLastCalledWith({
    color: '#ffffff',
    symbolColor: '#252523',
  });
  setTitleBarOverlay.mockClear();
  for (const untrusted of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { ...frame } },
    { sender: contents, senderFrame: { url: 'https://example.test' } },
  ])
    expect(mock.handler!(untrusted, 'dark')).toBe(false);
  for (const invalid of [null, {}, 'system', '#000000'])
    expect(mock.handler!(event, invalid)).toBe(false);
  expect(setTitleBarOverlay).not.toHaveBeenCalled();
  close();
  expect(mock.removeHandler).toHaveBeenCalledWith('daban:titlebar-theme');
});

it('leaves native controls alone on platforms without the Windows overlay', () => {
  const frame = { url: 'file:///mock/dist/index.html' };
  const contents = { mainFrame: frame };
  const setTitleBarOverlay = vi.fn();
  mock.windows = [{ webContents: contents, setTitleBarOverlay }];
  const close = titlebarIpc(frame.url, 'darwin');
  expect(mock.handler!({ sender: contents, senderFrame: frame }, 'dark')).toBe(false);
  expect(setTitleBarOverlay).not.toHaveBeenCalled();
  close();
});
