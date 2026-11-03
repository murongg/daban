import type { RuntimeBridge, RuntimeSnapshot } from '@daban/protocol';
import { contextBridge, ipcRenderer } from 'electron';
import type { LocaleBridge } from '../shared/locale';
import { isNoticeMessage, type NoticeBridge } from '../shared/notifications';
import { isUpdateMessage, type UpdateBridge } from '../shared/updates';

const runtime: RuntimeBridge = {
  invoke: (command) => ipcRenderer.invoke('daban:runtime', command),
  subscribe(callback) {
    const listener = (_event: unknown, state: RuntimeSnapshot) => callback(state);
    ipcRenderer.on('daban:runtime-state', listener);
    return () => ipcRenderer.removeListener('daban:runtime-state', listener);
  },
};
// No Node/IPC object or arbitrary channel is exposed; the main process validates every command and sender.
const notifications: NoticeBridge = {
  invoke: (command) => ipcRenderer.invoke('daban:notifications', command),
  subscribe(callback) {
    const listener = (_event: unknown, value: unknown) => {
      if (isNoticeMessage(value)) callback(value);
    };
    ipcRenderer.on('daban:notification-message', listener);
    return () => ipcRenderer.removeListener('daban:notification-message', listener);
  },
};
const locale: LocaleBridge = { invoke: (command) => ipcRenderer.invoke('daban:locale', command) };
const titlebar = {
  setTheme: (theme: 'light' | 'dark'): Promise<boolean> =>
    ipcRenderer.invoke('daban:titlebar-theme', theme),
};
const updates: UpdateBridge = {
  invoke: (command) => ipcRenderer.invoke('daban:updates', command),
  subscribe(callback) {
    const listener = (_event: unknown, value: unknown) => {
      if (isUpdateMessage(value)) callback(value);
    };
    ipcRenderer.on('daban:update-message', listener);
    return () => ipcRenderer.removeListener('daban:update-message', listener);
  },
};
contextBridge.exposeInMainWorld(
  'daban',
  Object.freeze({ platform: process.platform, runtime, notifications, locale, updates, titlebar }),
);
