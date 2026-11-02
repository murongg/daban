import type { RuntimeBridge } from '@daban/protocol';
import type { LocaleBridge } from '../shared/locale';
import type { NoticeBridge } from '../shared/notifications';

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
