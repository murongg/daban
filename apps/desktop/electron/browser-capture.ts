import type { WebContents } from 'electron';

export async function captureBrowser(contents: WebContents, params: Record<string, unknown> = {}) {
  // Electron's capturer wakes hidden guest surfaces after navigation. Start CDP
  // capture while it is active, retaining Playwright's masks, clip and DPI handling.
  const painting = contents.capturePage(undefined, { stayHidden: false, stayAwake: true });
  const capture = contents.debugger.sendCommand('Page.captureScreenshot', params);
  const [, image] = await Promise.all([painting, capture]);
  return image as Record<string, unknown>;
}
