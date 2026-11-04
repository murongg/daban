import type { RemoteBridge, RemoteState } from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { RemoteProvider } from '../../src/app/Remote';
import { RemoteButton } from '../../src/features/computer/Remote';
import '../../src/styles/styles.css';

const state: RemoteState = {
  selected: null,
  identity: { id: 'a'.repeat(64), publicKey: 'A'.repeat(59), name: 'Synthetic local computer' },
  hosting: true,
  server: 'https://connect.example.test',
  hosts: [
    {
      identity: { id: 'b'.repeat(64), publicKey: 'B'.repeat(59), name: 'Synthetic cloud desktop' },
      server: 'https://connect.example.test',
      workspace: 'synthetic-workspace',
      platform: 'linux',
      state: 'connected',
      transport: 'relay',
    },
    {
      identity: { id: 'c'.repeat(64), publicKey: 'C'.repeat(59), name: 'Synthetic idle computer' },
      server: 'https://connect.example.test',
      workspace: 'synthetic-idle',
      platform: 'win32',
      state: 'offline',
      transport: 'unknown',
    },
  ],
  pending: [
    {
      id: 'synthetic-pair',
      identity: { id: 'd'.repeat(64), publicKey: 'D'.repeat(59), name: 'Synthetic controller' },
      expiresAt: Date.now() + 120000,
    },
  ],
};
const remote: RemoteBridge = {
  invoke: async (command) => {
    if (command.type === 'select') state.selected = command.host;
    if (command.type === 'host') {
      state.hosting = command.enabled;
      state.server = command.server;
    }
    if (command.type === 'approve') state.pending = [];
    if (command.type === 'invite') state.invitation = 'daban://pair#synthetic-invitation';
    return structuredClone(state);
  },
  subscribe: () => () => {},
};
Object.defineProperty(window, 'daban', { value: { platform: 'darwin', remote } });
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
createRoot(document.getElementById('root')!).render(
  <RemoteProvider>
    <div style={{ width: 280, margin: 30 }}>
      <RemoteButton />
    </div>
  </RemoteProvider>,
);
