import { BrowserWindow, type BrowserWindowConstructorOptions, ipcMain } from 'electron';
import { trustedSender } from './ipc';

// Native controls sit above DOM overlays; transparency lets modal backdrops cover their background.
// Keep symbol colors aligned with the renderer's ink tokens, not the OS theme.
const themes = {
  light: { color: '#00000000', symbolColor: '#252523' },
  dark: { color: '#00000000', symbolColor: '#eaeae5' },
};

export function titlebarOptions(platform: NodeJS.Platform): BrowserWindowConstructorOptions {
  if (platform === 'darwin')
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 28 } };
  if (platform === 'win32')
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...themes.light, height: 56 },
    };
  return {};
}

export function titlebarIpc(rendererUrl: string, platform: NodeJS.Platform = process.platform) {
  ipcMain.handle('daban:titlebar-theme', (event, theme: unknown) => {
    if (platform !== 'win32' || (theme !== 'light' && theme !== 'dark')) return false;
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents === event.sender,
    );
    const frame = event.senderFrame;
    if (
      !window ||
      !trustedSender(
        {
          url: frame?.url || '',
          mainFrame: frame === event.sender.mainFrame,
          owned: true,
        },
        rendererUrl,
      )
    )
      return false;
    window.setTitleBarOverlay(themes[theme]);
    return true;
  });
  return () => ipcMain.removeHandler('daban:titlebar-theme');
}
