import type { PeerBridge, RemoteBridge, RuntimeBridge } from '@daban/protocol';
import type { LocaleBridge } from '../shared/locale';
import type { NoticeBridge } from '../shared/notifications';
import type { UpdateBridge } from '../shared/updates';

declare global {
  interface Window {
    readonly dabanPeer?: PeerBridge;
    readonly daban?: Readonly<{
      platform: 'darwin' | 'win32' | 'linux';
      titlebar?: { setTheme: (theme: 'light' | 'dark') => Promise<boolean> };
      runtime?: RuntimeBridge;
      remote?: RemoteBridge;
      peer?: PeerBridge;
      notifications?: NoticeBridge;
      locale?: LocaleBridge;
      updates?: UpdateBridge;
    }>;
  }
}
