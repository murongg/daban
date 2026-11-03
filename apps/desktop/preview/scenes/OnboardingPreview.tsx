import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import { clientCache } from '../../src/app/cache';
import { initialState } from '../../src/app/state';
import { serialize, storageKey } from '../../src/app/storage';
import { modelPreview } from '../models';
import '../../src/styles/tokens.css';
import '../../src/styles/styles.css';

// The first-use form runs against the shared synthetic bridge, never a real key store or model API.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const state = initialState();
state.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
clientCache().setItem(storageKey, serialize(state));
const { bridge, snapshot } = modelPreview(query.get('configured') !== '1');
if (query.get('mode') === 'offline') {
  snapshot.phase = 'offline';
  snapshot.error = 'errors.runtimeConnectionUnavailable';
}
if (query.get('mode') === 'legacy') {
  snapshot.protocolVersion = 42;
  snapshot.model.configured = true;
  snapshot.setup = {
    required: false,
    target: 'agent',
    phase: 'waiting',
    error: 'AGENT_LEGACY_RESTART_REQUIRED',
  };
  snapshot.groups = { available: true, revision: 0, items: [] };
  snapshot.schedules = { available: true, items: [] };
}
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
createRoot(document.getElementById('root')!).render(<App />);
