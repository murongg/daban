import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import { clientCache } from '../../src/app/cache';
import { initialState, reduce } from '../../src/app/state';
import { serialize, storageKey } from '../../src/app/storage';
import { onboardingKey } from '../../src/features/onboarding/Onboarding';
import { modelPreview } from '../models';
import '../../src/styles/tokens.css';
import '../../src/styles/styles.css';

// The first-use form runs against the shared synthetic bridge, never a real key store or model API.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const returning = query.get('mode') === 'returning';
const state = returning
  ? reduce(initialState(), {
      type: 'create',
      id: 'mock-returning-bot',
      name: '示例 Bot',
      role: '合成工作区预览',
      color: 'mint',
    })
  : initialState();
if (returning) {
  state.messages['mock-returning-bot'] = [
    {
      id: 'mock-cached-message',
      role: 'bot',
      text: '这是本地保留的示例对话。工作区已打开，后台正在连接。',
    },
  ];
  state.drafts['mock-returning-bot'] = '这份草稿在连接时仍可编辑。';
  clientCache().setItem(onboardingKey, 'complete');
} else clientCache().removeItem(onboardingKey);
state.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
clientCache().setItem(storageKey, serialize(state));
const { bridge, snapshot } = modelPreview(query.get('configured') !== '1');
if (returning) snapshot.phase = 'connecting';
if (query.get('mode') === 'offline') {
  snapshot.phase = 'offline';
  snapshot.error = 'errors.runtimeConnectionUnavailable';
}
if (query.get('mode') === 'startup' || query.get('mode') === 'startup-failed') {
  const failed = query.get('mode') === 'startup-failed';
  snapshot.phase = failed ? 'offline' : 'connecting';
  snapshot.setup = failed
    ? { required: true, target: 'linux', phase: 'failed', error: 'AGENT_START_FAILED' }
    : {
        required: true,
        target: 'linux',
        phase: 'downloading',
        progress: 37,
        downloaded: 37,
        total: 100,
      };
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
