import {
  agentId,
  type Group,
  type GroupActionAck,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { clientCache } from '../../src/cache';
import { demoState as initialState } from '../../src/fixtures';
import { serialize, storageKey } from '../../src/storage';
import { previewSnapshot } from '../runtime';
import '../../src/tokens.css';
import '../../src/styles.css';

// Synthetic UI fixture only; no VM, credentials, provider or real workspace is used.
const query = new URLSearchParams(location.search);
const mode = query.get('mode') || 'active';
const seed = initialState();
seed.selected = 'crew';
seed.panel = null;
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
seed.drafts.crew = '合成未发送草稿：整理完成后再发给成员。';
let group: Group = {
  id: 'crew',
  name: '合成项目协作',
  members: ['chief', 'a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
if (mode === 'archived') {
  group.archived = true;
  group.revision = 2;
}
if (mode === 'pending')
  seed.groupActions.crew = {
    id: 'mock-pending-archive',
    group: 'crew',
    action: 'archive',
    revision: 1,
  };
clientCache().setItem(storageKey, serialize(seed));
const snapshot = previewSnapshot(mode === 'legacy' ? 28 : undefined);
snapshot.groups = { available: true, revision: 1, items: [group] };
snapshot.model = {
  ...snapshot.model,
  available: true,
  configured: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 1,
};
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    color: bot.color,
    memory: '',
    revision: 1,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  }));
const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
let receipt: GroupActionAck | undefined;
function publish() {
  snapshot.groups = { available: true, revision: group.revision, items: [group] };
  for (const listener of listeners) listener({ ...snapshot });
}
function fixture(command: RuntimeCommand): unknown {
  if (command.type === 'status') return snapshot;
  if (command.type === 'group.read')
    return {
      group,
      revision: group.revision,
      deliveries: [],
      messages: [
        {
          id: 'mock-retained-history',
          group: group.id,
          sequence: 1,
          sourceId: 'mock-retained-history',
          role: 'user',
          text: '合成历史：先核对方案，稍后再安排协作。',
          createdAt: group.createdAt,
        },
      ],
    };
  if (command.type === 'group.action') {
    if (mode === 'busy') throw new Error('GROUP_BUSY');
    const request = command.request;
    if (receipt?.receipt.request.id !== request.id) {
      group = { ...group, revision: request.revision + 1 };
      if (request.action === 'archive') group.archived = true;
      else delete group.archived;
      receipt = {
        group,
        receipt: { request, revision: group.revision, completedAt: group.updatedAt },
      };
      publish();
    }
    if (mode === 'uncertain') throw new Error('RUNTIME_TIMEOUT');
    return { ...receipt, group };
  }
  if (command.type === 'group.receipt') {
    if (mode === 'pending') {
      group = { ...group, revision: 2, archived: true };
      publish();
      return {
        group,
        receipt: { request: seed.groupActions.crew!, revision: 2, completedAt: group.updatedAt },
      };
    }
    if (!receipt) throw new Error('GROUP_ACTION_NOT_FOUND');
    return { ...receipt, group };
  }
  if (command.type === 'files.list') return [];
  if (command.type === 'skill.list') return { revision: 0, items: [] };
  return {};
}
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: {
    platform: 'darwin',
    runtime: {
      invoke: async (command: RuntimeCommand) => {
        try {
          return { ok: true, value: fixture(command) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'SYNTHETIC_FAILURE' };
        }
      },
      subscribe: (listener: Parameters<RuntimeBridge['subscribe']>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as RuntimeBridge,
  },
});
const root = document.getElementById('root');
if (!root) throw new Error('SYNTHETIC_ROOT_MISSING');
const view = createRoot(root);
view.render(<App />);
import.meta.hot?.dispose(() => view.unmount());
