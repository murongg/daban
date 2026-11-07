import type { WebContents } from 'electron';

export async function captureBrowser(
  contents: WebContents,
  bounds: { width: number; height: number },
  params: Record<string, unknown> = {},
) {
  const unsupported = () => new Error('BROWSER_CAPTURE_UNSUPPORTED');
  const number = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw unsupported();
    return value;
  };
  const format = params.format ?? 'png';
  const quality = number(params.quality ?? 80);
  if (
    !['jpeg', 'png'].includes(String(format)) ||
    !Number.isInteger(quality) ||
    quality < 0 ||
    quality > 100 ||
    params.captureBeyondViewport === true
  )
    throw unsupported();
  const metrics = (await contents.debugger.sendCommand('Page.getLayoutMetrics')) as {
    visualViewport: { pageX: number; pageY: number; scale: number };
  };
  const viewport = metrics.visualViewport;
  const zoom = number(viewport.scale);
  if (zoom <= 0) throw unsupported();
  const clip = (params.clip ?? {
    x: viewport.pageX,
    y: viewport.pageY,
    width: bounds.width / zoom,
    height: bounds.height / zoom,
    scale: zoom,
  }) as Record<string, unknown>;
  const width = number(clip.width),
    height = number(clip.height),
    scale = number(clip.scale);
  const rect = {
    x: Math.round((number(clip.x) - number(viewport.pageX)) * zoom),
    y: Math.round((number(clip.y) - number(viewport.pageY)) * zoom),
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
  };
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.x + rect.width > bounds.width ||
    rect.y + rect.height > bounds.height ||
    scale <= 0 ||
    scale > 8
  )
    throw unsupported();
  // Native capture wakes hidden guest surfaces, including cross-process frames.
  // Playwright keeps its password/OTP masks installed until this CDP command finishes.
  const frame = await contents.capturePage(rect, { stayHidden: false, stayAwake: true });
  if (frame.isEmpty()) throw new Error('BROWSER_CAPTURE_UNAVAILABLE');
  // Electron 45 can label device pixels as 1x; derive DPI from actual bitmap dimensions.
  const bitmap = frame.getSize(Math.max(...frame.getScaleFactors()));
  const size = {
    width: Math.round((width * bitmap.width * scale) / rect.width),
    height: Math.round((height * bitmap.height * scale) / rect.height),
  };
  if (
    !Object.values(size).every((value) => Number.isSafeInteger(value) && value > 0 && value <= 4096)
  )
    throw unsupported();
  const image = frame.resize(size);
  const data = format === 'jpeg' ? image.toJPEG(quality) : image.toPNG();
  return { data: data.toString('base64') };
}
