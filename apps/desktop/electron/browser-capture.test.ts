import { expect, it, vi } from 'vitest';
import { captureBrowser } from './browser-capture';

function fixture(scale = 2) {
  let captured = { width: 960, height: 640 };
  const image = {
    isEmpty: () => false,
    getScaleFactors: () => [1],
    getSize: () => ({ width: captured.width * scale, height: captured.height * scale }),
    resize: vi.fn(),
    toJPEG: vi.fn(() => Buffer.from('synthetic-jpeg')),
    toPNG: vi.fn(() => Buffer.from('synthetic-png')),
  };
  image.resize.mockReturnValue(image);
  const contents = {
    debugger: {
      sendCommand: vi.fn(async () => ({
        visualViewport: { pageX: 100, pageY: 300, scale: 1 },
      })),
    },
    capturePage: vi.fn(async (rect: { width: number; height: number }) => {
      captured = rect;
      return image;
    }),
  };
  return { contents, image };
}

it('captures a hidden guest at CSS resolution after scrolling, including mislabeled Retina bitmaps', async () => {
  const { contents, image } = fixture();
  const result = await captureBrowser(
    contents as never,
    { width: 960, height: 640 },
    {
      format: 'jpeg',
      quality: 75,
      clip: { x: 100, y: 300, width: 960, height: 640, scale: 0.5 },
      captureBeyondViewport: false,
    },
  );
  expect(contents.capturePage).toHaveBeenCalledWith(
    { x: 0, y: 0, width: 960, height: 640 },
    { stayHidden: false, stayAwake: true },
  );
  expect(image.resize).toHaveBeenCalledWith({ width: 960, height: 640 });
  expect(image.toJPEG).toHaveBeenCalledWith(75);
  expect(result).toEqual({ data: Buffer.from('synthetic-jpeg').toString('base64') });
});

it('maps a zoomed document clip into the native viewport', async () => {
  const { contents, image } = fixture(1);
  contents.debugger.sendCommand.mockResolvedValue({
    visualViewport: { pageX: 100, pageY: 300, scale: 2 },
  });
  await captureBrowser(
    contents as never,
    { width: 960, height: 640 },
    {
      format: 'png',
      clip: { x: 120, y: 310, width: 100, height: 50, scale: 2 },
    },
  );
  expect(contents.capturePage).toHaveBeenCalledWith(
    { x: 40, y: 20, width: 200, height: 100 },
    { stayHidden: false, stayAwake: true },
  );
  expect(image.resize).toHaveBeenCalledWith({ width: 200, height: 100 });
  expect(image.toPNG).toHaveBeenCalledOnce();
});

it('rejects capture outside the owned viewport and unreasonable output scales', async () => {
  const { contents } = fixture();
  for (const clip of [
    { x: 99, y: 300, width: 100, height: 100, scale: 1 },
    { x: 100, y: 300, width: 961, height: 640, scale: 1 },
    { x: 100, y: 300, width: 960, height: 640, scale: 100 },
  ])
    await expect(
      captureBrowser(contents as never, { width: 960, height: 640 }, { clip }),
    ).rejects.toThrow('BROWSER_CAPTURE_UNSUPPORTED');
  expect(contents.capturePage).not.toHaveBeenCalled();
});
