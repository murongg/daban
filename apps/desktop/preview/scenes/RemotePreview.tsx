import type { RemoteBridge, RemoteState } from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { RemoteProvider } from '../../src/app/Remote';
import { RemoteButton } from '../../src/features/computer/Remote';
import { t } from '../../src/i18n/locale';
import '../../src/styles/styles.css';

const query = new URLSearchParams(location.search);
const state: RemoteState = {
  selected: null,
  identity: { id: 'a'.repeat(64), publicKey: 'A'.repeat(59), name: 'Synthetic local computer' },
  hosting: query.has('sharing'),
  server: 'https://127.0.0.1:45678',
  hosts: [
    {
      identity: { id: 'b'.repeat(64), publicKey: 'B'.repeat(59), name: 'Synthetic Linux desktop' },
      server: 'https://127.0.0.1:45678',
      workspace: 'synthetic-workspace',
      platform: 'linux',
      state: 'connected',
      transport: 'direct',
    },
    {
      identity: { id: 'c'.repeat(64), publicKey: 'C'.repeat(59), name: 'Synthetic idle computer' },
      server: 'https://127.0.0.1:45678',
      workspace: 'synthetic-idle',
      platform: 'win32',
      state: 'offline',
      transport: 'unknown',
    },
  ],
  pending: query.has('pending')
    ? [
        {
          id: 'synthetic-pair',
          identity: { id: 'd'.repeat(64), publicKey: 'D'.repeat(59), name: 'Synthetic controller' },
          expiresAt: Date.now() + 120000,
        },
      ]
    : [],
  ...(query.has('sharing')
    ? { pairingCode: { code: '123456', expiresAt: Date.now() + 300000 } }
    : {}),
};
const remote: RemoteBridge = {
  invoke: async (command) => {
    if (command.type === 'select') state.selected = command.host;
    if (command.type === 'host') {
      state.hosting = command.enabled;
      state.server = command.enabled ? 'https://127.0.0.1:45678' : '';
      if (!command.enabled) state.pairingCode = undefined;
    }
    if (command.type === 'pair') {
      if (command.code !== '123456') throw Error('REMOTE_CODE_NOT_FOUND');
      state.pairedHost = state.hosts[0].identity.id;
    }
    if (command.type === 'approve') state.pending = [];
    if (command.type === 'invite')
      state.pairingCode = { code: '123456', expiresAt: Date.now() + 300000 };
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
      <p className="muted" style={{ marginBottom: 14 }}>
        {t('remote.previewHint')}
      </p>
      <RemoteButton />
    </div>
  </RemoteProvider>,
);
