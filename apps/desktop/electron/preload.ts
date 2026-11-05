import type {
  PeerBridge,
  PeerCommand,
  RemoteBridge,
  RemoteState,
  RuntimeBridge,
  RuntimeSnapshot,
} from '@daban/protocol';
import { contextBridge, ipcRenderer } from 'electron';
import type { LocaleBridge } from '../shared/locale';
import { isNoticeMessage, type NoticeBridge } from '../shared/notifications';
import { isUpdateMessage, type UpdateBridge } from '../shared/updates';

const runtime: RuntimeBridge = {
  invoke: (command, host) =>
    host
      ? ipcRenderer.invoke('daban:runtime', command, host)
      : ipcRenderer.invoke('daban:runtime', command),
  subscribe(callback, host = null) {
    const listener = (_event: unknown, state: RuntimeSnapshot, source: string | null = null) => {
      if (source === host) callback(state);
    };
    ipcRenderer.on('daban:runtime-state', listener);
    return () => ipcRenderer.removeListener('daban:runtime-state', listener);
  },
};
const remote: RemoteBridge = {
  invoke: (command) => ipcRenderer.invoke('daban:remote', command),
  subscribe(callback) {
    const listener = (_event: unknown, state: RemoteState) => callback(state);
    ipcRenderer.on('daban:remote-state', listener);
    return () => ipcRenderer.removeListener('daban:remote-state', listener);
  },
};
const peer: PeerBridge = {
  subscribe(callback) {
    const listener = (_event: unknown, command: PeerCommand) => callback(command);
    ipcRenderer.on('daban:peer-command', listener);
    return () => ipcRenderer.removeListener('daban:peer-command', listener);
  },
  emit: (event) => ipcRenderer.send('daban:peer-event', event),
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
  Object.freeze({
    platform: process.platform,
    runtime,
    remote,
    peer,
    notifications,
    locale,
    updates,
    titlebar,
  }),
);
