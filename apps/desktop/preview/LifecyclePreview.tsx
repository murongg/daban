import {
  agentId,
  type BotProfile,
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

const query = new URLSearchParams(location.search);
const mode = query.get('mode') ?? 'archive';
const seed = initialState();
seed.panel = null;
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
seed.bots = seed.bots.map((bot) => ({ ...bot, name: `合成${bot.name}` }));
seed.drafts.research = '合成未发送草稿：这些内容会保留，恢复后可继续编辑。';
seed.messages.research = [
  { id: 'mock-history-user', role: 'user', text: '这是一段用于验证归档保留的合成对话。' },
  {
    id: 'mock-history-bot',
    role: 'bot',
    text: '聊天记录、文件引用和未发送草稿会保留。恢复 Bot 不会自动重新运行旧任务。',
  },
];
const snapshot = disconnected('ready');
snapshot.protocolVersion = 22;
snapshot.groups = {
  available: true,
  revision: 1,
  items: seed.bots
    .filter((bot) => !!bot.members)
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      members: bot.members!.map(agentId),
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
};
if (mode === 'connected')
  snapshot.bots.a = {
    instance: 'mock-screen',
    owner: 'agent',
    epoch: 1,
    task: {
      running: false,
      phase: 'idle',
      prompt: '',
      result: '',
      error: '',
      files: [],
      toolCount: 0,
      executedCount: 0,
      trace: [],
      history: [],
    },
  };
snapshot.skills = { available: true, revision: 0 };
snapshot.mcp = { available: true, revision: 0 };
snapshot.computers = {
  available: true,
  revision: 0,
  limit: 2,
  items:
    mode === 'connected'
      ? [
          {
            bot: 'a',
            desired: true,
            phase: 'connected',
            revision: 1,
            reserved: true,
            instance: 'mock-screen',
          },
        ]
      : [],
};
snapshot.model = {
  available: true,
  configured: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 1,
};
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot): BotProfile => {
    const archived =
      mode === 'all' ||
      (['archived', 'pending', 'restore'].includes(mode) && bot.id === 'research');
    const pending = archived && mode === 'pending';
    const profile: BotProfile = {
      id: agentId(bot.id),
      name: bot.name,
      instructions: bot.role,
      color: bot.color,
      memory: 'SYNTHETIC-RETAINED-PREFERENCE',
      revision: archived ? (pending ? 2 : 3) : 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T01:00:00Z',
      ...(archived
        ? {
            archived: true,
            lifecycle: {
              id: `mock-archive-${agentId(bot.id)}`,
              action: 'archive',
              phase: pending ? 'pending' : 'complete',
              baseRevision: 1,
            },
          }
        : {}),
    };
    return profile;
  });
if (mode === 'pending')
  seed.lifecycleRequests.research = {
    id: 'mock-archive-a',
    bot: 'a',
    action: 'archive',
    revision: 1,
  };
localStorage.setItem(storageKey, serialize(seed));
const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
function publish() {
  for (const listener of listeners) listener(structuredClone(snapshot));
}
function fixture(command: RuntimeCommand): unknown {
  if (command.type === 'status' || command.type === 'connect') return structuredClone(snapshot);
  if (command.type === 'mcp.list') return { revision: 0, items: [] };
  if (command.type === 'group.read')
    return {
      group: snapshot.groups!.items.find((group) => group.id === command.group),
      revision: 1,
      messages: [],
      deliveries: [],
    };
  if (command.type === 'bot.register')
    return snapshot.profiles.find((profile) => profile.id === command.profile.id);
  if (command.type === 'bot.action') {
    if (mode === 'group-blocked') throw new Error('BOT_GROUP_PENDING');
    const request = command.request;
    const old = snapshot.profiles.find((profile) => profile.id === request.bot)!;
    if (old.lifecycle?.id !== request.id && old.revision !== request.revision)
      throw new Error('BOT_PROFILE_CONFLICT');
    const profile: BotProfile = {
      ...old,
      revision: request.revision + (request.action === 'archive' ? 2 : 1),
      archived: request.action === 'archive',
      lifecycle: {
        id: request.id,
        action: request.action,
        phase: 'complete',
        baseRevision: request.revision,
      },
    };
    snapshot.profiles = snapshot.profiles.map((row) => (row.id === profile.id ? profile : row));
    publish();
    if (mode === 'uncertain') throw new Error('RUNTIME_SESSION_CHANGED');
    return { profile, receipt: { ...profile.lifecycle!, bot: profile.id } };
  }
  if (command.type === 'bot.receipt') {
    const profile = snapshot.profiles.find((row) => row.id === command.bot);
    if (profile?.lifecycle?.id !== command.id) throw new Error('BOT_LIFECYCLE_NOT_FOUND');
    return { profile, receipt: { ...profile.lifecycle, bot: profile.id } };
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
