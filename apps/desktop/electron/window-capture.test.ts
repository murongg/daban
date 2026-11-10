import { EventEmitter } from 'node:events';
import type { BrowserWindowConstructorOptions } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { windowCapture } from './window-capture';

const mocks = vi.hoisted(() => ({ create: vi.fn(), sources: vi.fn() }));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: mocks.sources },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) {
      Object.assign(this, mocks.create(options));
    }
  },
}));

function surface() {
  const events = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() });
  const window = {
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
    webContents: contents,
    loadURL: vi.fn(async () => {}),
    loadFile: vi.fn(async () => {}),
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
  };
  mocks.create.mockReturnValue(window);
  return window;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sources.mockResolvedValue([{ id: 'window:11:0' }]);
});

it('captures only the approved native window in a hidden isolated renderer and reuses its stream', async () => {
  const window = surface();
  const capture = windowCapture();
  window.webContents.send.mockImplementation(
    (channel: string, request: { id: number; source: string }) => {
      expect(channel).toBe('daban:capture');
      expect(request.source).toBe('window:11:0');
      window.webContents.emit('ipc-message', {}, 'daban:captured', {
        id: request.id,
        image: 'data:image/jpeg;base64,U1lOVEhFVElD',
        width: 800,
        height: 600,
      });
    },
  );
  expect(await capture.capture(11, new AbortController().signal)).toMatchObject({
    width: 800,
    height: 600,
  });
  await capture.capture(11, new AbortController().signal);
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(window.loadFile).toHaveBeenCalledOnce();
  expect(mocks.sources).toHaveBeenCalledWith({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      show: false,
      focusable: false,
      webPreferences: expect.objectContaining({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      }),
    }),
  );
  capture.close();
  expect(window.destroy).toHaveBeenCalledOnce();
});

it('does not open a stream when the exact granted HWND is unavailable', async () => {
  surface();
  mocks.sources.mockResolvedValue([{ id: 'window:12:0' }]);
  await expect(windowCapture().capture(11, new AbortController().signal)).rejects.toThrow(
    'LOCAL_SCREEN_UNAVAILABLE',
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

it('rejects interrupted captures and destroys the stream before accepting any late frame', async () => {
  const window = surface();
  const capture = windowCapture();
  const abort = new AbortController();
  const pending = capture.capture(11, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledOnce());
  abort.abort();
  await rejected;
  expect(window.destroy).toHaveBeenCalledOnce();
  expect(window.webContents.listenerCount('ipc-message')).toBe(0);
});

it('rejects failed or malformed observations rather than returning the previous frame', async () => {
  const window = surface();
  const capture = windowCapture();
  window.webContents.send.mockImplementation((_channel: string, request: { id: number }) => {
    window.webContents.emit('ipc-message', {}, 'daban:captured', { id: request.id, error: true });
  });
  await expect(capture.capture(11, new AbortController().signal)).rejects.toThrow(
    'LOCAL_SCREEN_UNAVAILABLE',
  );
  expect(window.destroy).toHaveBeenCalledOnce();
});

it('cleans up a capture renderer that fails to load', async () => {
  const window = surface();
  window.loadFile.mockRejectedValueOnce(new Error('SYNTHETIC_LOAD_FAILED'));
  await expect(windowCapture().capture(11, new AbortController().signal)).rejects.toThrow();
  expect(window.destroy).toHaveBeenCalledOnce();
  expect(window.webContents.send).not.toHaveBeenCalled();
});
