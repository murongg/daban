import type { RuntimeBridge } from '@daban/protocol';
import type { LocaleBridge } from '../locale';
import type { NoticeBridge } from '../notifications';

declare global {
  interface Window {
    readonly daban?: Readonly<{
      platform: 'darwin' | 'win32' | 'linux';
      runtime?: RuntimeBridge;
      notifications?: NoticeBridge;
      locale?: LocaleBridge;
    }>;
  }
}
