import type { PeerBridge, PeerCommand } from '@daban/protocol';
import { contextBridge, ipcRenderer } from 'electron';

const peer: PeerBridge = {
  subscribe(callback) {
    const listener = (_event: unknown, command: PeerCommand) => callback(command);
    ipcRenderer.on('daban:peer-command', listener);
    return () => ipcRenderer.removeListener('daban:peer-command', listener);
  },
  emit: (event) => ipcRenderer.send('daban:peer-event', event),
};
contextBridge.exposeInMainWorld('dabanPeer', peer);
