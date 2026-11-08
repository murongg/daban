import type { RuntimeBridge } from '@daban/protocol';
import type { BrowserBridge } from '../shared/browser';
import type { LocaleBridge } from '../shared/locale';
import type { NoticeBridge } from '../shared/notifications';
import type { UpdateBridge } from '../shared/updates';

declare global {
  interface Window {
    readonly daban?: Readonly<{
      platform: 'darwin' | 'win32' | 'linux';
      titlebar?: { setTheme: (theme: 'light' | 'dark') => Promise<boolean> };
      runtime?: RuntimeBridge;
      browser?: BrowserBridge;
      notifications?: NoticeBridge;
      locale?: LocaleBridge;
      updates?: UpdateBridge;
    }>;
  }
}
