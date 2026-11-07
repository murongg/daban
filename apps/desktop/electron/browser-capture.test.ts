import { expect, it, vi } from 'vitest';
import { captureBrowser } from './browser-capture';

it('wakes the hidden guest before CDP capture and returns only the original masked CDP image', async () => {
  let awake = false;
  let finish!: (value: unknown) => unknown;
  const image = { data: 'SYNTHETIC_MASKED_CDP_IMAGE' };
  const contents = {
    capturePage: vi.fn(() => {
      awake = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
    debugger: {
      sendCommand: vi.fn(async () => {
        expect(awake).toBe(true);
        return image;
      }),
    },
  };
  const params = {
    format: 'jpeg',
    quality: 75,
    clip: { x: 100, y: 300, width: 960, height: 640, scale: 0.5 },
    captureBeyondViewport: false,
  };
  const pending = captureBrowser(contents as never, params);
  expect(contents.capturePage).toHaveBeenCalledWith(undefined, {
    stayHidden: false,
    stayAwake: true,
  });
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', params);
  finish({ syntheticNativeFrame: 'MUST_NOT_BE_RETURNED' });
  expect(await pending).toBe(image);
});

it.each(['wake', 'cdp'])(
  'propagates %s capture failures instead of returning an uncertain image',
  async (failure) => {
    const error = new Error('SYNTHETIC_CAPTURE_FAILURE');
    const contents = {
      capturePage: vi.fn(async () => {
        if (failure === 'wake') throw error;
        return undefined;
      }),
      debugger: {
        sendCommand: vi.fn(async () => {
          if (failure === 'cdp') throw error;
          return { data: 'SYNTHETIC_CDP_IMAGE' };
        }),
      },
    };
    await expect(captureBrowser(contents as never, {})).rejects.toThrow(error);
  },
);
