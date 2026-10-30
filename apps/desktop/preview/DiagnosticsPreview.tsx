import {
  agentId,
  type DiagnosticReport,
  diagnosticIds,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { demoState as initialState } from '../src/fixtures';
import { serialize, storageKey } from '../src/storage';
import '../src/tokens.css';
import '../src/styles.css';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'ready';
const state = initialState();
state.view = 'settings';
state.panel = null;
state.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
state.bots = state.bots.map((bot) => ({ ...bot, name: `合成${bot.name}` }));
localStorage.setItem(storageKey, serialize(state));
const snapshot = disconnected(mode === 'offline' ? 'offline' : 'ready');
snapshot.protocolVersion = mode === 'old' ? 15 : 23;
snapshot.model = {
  available: true,
  configured: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 1,
};
snapshot.mcp = { available: true, revision: 0 };
snapshot.skills = { available: true, revision: 0 };
snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
snapshot.groups = {
  available: true,
  revision: 1,
  items: state.bots
    .filter((bot) => bot.members)
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      members: bot.members!.map(agentId),
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
};
snapshot.profiles = state.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    memory: 'SYNTHETIC-PREFERENCE',
    color: bot.color,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
const report: DiagnosticReport = {
  scope: 'host',
  checkedAt: '2026-01-01T08:30:00.000Z',
  checks: [...diagnosticIds.host, ...diagnosticIds.runtime].map((id) => {
    if (mode === 'offline')
      return {
        id,
        state: id === 'configuration' ? 'ready' : id === 'vm' ? 'unavailable' : 'unchecked',
      };
    if (mode === 'old' && diagnosticIds.runtime.some((entry) => entry === id) && id !== 'agent')
      return { id, state: 'unsupported' };
    if (mode === 'degraded') {
      if (id === 'model') return { id, state: 'unconfigured' };
      if (id === 'computers') return { id, state: 'degraded', affected: 2 };
      if (id === 'knowledge') return { id, state: 'timeout' };
      if (id === 'graphics') return { id, state: 'unavailable' };
    }
    return { id, state: 'ready' };
  }),
};
function result(command: RuntimeCommand): unknown {
  if (command.type === 'status' || command.type === 'connect') return structuredClone(snapshot);
  if (command.type === 'runtime.inspect')
    return mode === 'busy' ? new Promise(() => undefined) : structuredClone(report);
  if (command.type === 'bot.register')
    return snapshot.profiles.find((profile) => profile.id === command.profile.id);
  if (command.type === 'mcp.list' || command.type === 'skill.list')
    return { revision: 0, items: [] };
  return {};
}
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: {
    platform: 'darwin',
    runtime: {
      invoke: async (command: RuntimeCommand) => ({ ok: true, value: await result(command) }),
      subscribe: () => () => undefined,
    } as unknown as RuntimeBridge,
  },
});
const target = document.getElementById('root');
if (!target) throw new Error('SYNTHETIC_ROOT_MISSING');
const view = createRoot(target);
view.render(<App />);
import.meta.hot?.dispose(() => view.unmount());
