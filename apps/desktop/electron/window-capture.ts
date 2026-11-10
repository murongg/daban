import { join } from 'node:path';
import { BrowserWindow, desktopCapturer } from 'electron';

type Frame = { image: string; width: number; height: number };

export function windowCapture() {
  let surface: BrowserWindow | undefined;
  let source: number | undefined;
  let sourceId: string | undefined;
  let sequence = 0;
  let cancel: (() => unknown) | undefined;

  function close() {
    const previous = surface;
    surface = undefined;
    source = undefined;
    sourceId = undefined;
    cancel?.();
    if (previous && !previous.isDestroyed()) previous.destroy();
  }

  return {
    close,
    async capture(windowId: number, signal: AbortSignal): Promise<Frame> {
      signal.throwIfAborted();
      if (source !== windowId || surface?.isDestroyed()) close();
      try {
        if (!surface) {
          const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 0, height: 0 },
          });
          signal.throwIfAborted();
          sourceId = sources.find((item) => item.id.startsWith(`window:${windowId}:`))?.id;
          if (!sourceId) throw new Error('LOCAL_SCREEN_UNAVAILABLE');
          source = windowId;
          surface = new BrowserWindow({
            show: false,
            focusable: false,
            skipTaskbar: true,
            webPreferences: {
              preload: join(__dirname, 'capture.cjs'),
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              backgroundThrottling: false,
              offscreen: true,
              partition: `daban-window-capture-${++sequence}`,
            },
          });
          await surface.loadFile(join(__dirname, '../dist/capture.html'));
        }
        signal.throwIfAborted();
        const current = surface;
        if (!current) throw new Error('LOCAL_SCREEN_UNAVAILABLE');
        const id = ++sequence;
        return await new Promise<Frame>((resolve, reject) => {
          const finish = (frame?: Frame) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            current.webContents.removeListener('ipc-message', received);
            current.removeListener('closed', abort);
            cancel = undefined;
            if (frame && !signal.aborted && surface === current) resolve(frame);
            else reject(new Error('LOCAL_SCREEN_UNAVAILABLE'));
          };
          const abort = () => finish();
          const received = (_event: unknown, channel: string, value: unknown) => {
            if (
              channel !== 'daban:captured' ||
              !value ||
              typeof value !== 'object' ||
              Reflect.get(value, 'id') !== id
            )
              return;
            const image: unknown = Reflect.get(value, 'image');
            const width: unknown = Reflect.get(value, 'width');
            const height: unknown = Reflect.get(value, 'height');
            if (
              typeof image === 'string' &&
              image.startsWith('data:image/jpeg;base64,') &&
              typeof width === 'number' &&
              typeof height === 'number' &&
              width > 0 &&
              height > 0 &&
              width <= 16384 &&
              height <= 16384
            )
              finish({ image, width, height });
            else {
              console.warn('Local window capture failed:', Reflect.get(value, 'error'));
              finish();
            }
          };
          const timer = setTimeout(abort, 5000);
          cancel = abort;
          signal.addEventListener('abort', abort, { once: true });
          current.once('closed', abort);
          current.webContents.on('ipc-message', received);
          // A native window source captures only this grant; enumerating thumbnails would also read other windows.
          current.webContents.send('daban:capture', { id, source: sourceId });
        });
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
