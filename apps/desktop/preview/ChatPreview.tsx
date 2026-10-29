import {
  agentId,
  type ChatAck,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { initialState } from '../src/state';
import { serialize, storageKey } from '../src/storage';
import '../src/tokens.css';
import '../src/styles.css';

// Synthetic production-React fixture, with no VM, provider, credentials or user data.
const query = new URLSearchParams(location.search),
  mode = query.get('mode') || 'active';
const state = initialState();
state.panel = null;
state.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
state.drafts.research = '合成未发送草稿：整理下一份方案时，再发送这些内容。';
state.messages.research = [
  { id: 'mock-old-user', role: 'user', text: '合成历史：请整理上一份方案的核对要点。' },
  {
    id: 'runtime-result:mock-old-run',
    role: 'bot',
    text: '合成回复：先核对目标、时间和资料，确认后再安排执行。',
  },
  { id: 'mock-local-only', role: 'notice', text: '合成本机缓存：这里的内容会保留。' },
];
if (mode === 'pending')
  state.chatRequests.research = { bot: 'a', id: 'mock-pending-chat', revision: 0 };
localStorage.setItem(storageKey, serialize(state));
let snapshot = disconnected('ready');
snapshot.protocolVersion = 29;
snapshot.chats = {
  available: true,
  revision: mode === 'pending' || mode === 'history' ? 1 : 0,
  items:
    mode === 'pending' || mode === 'history'
      ? [{ bot: 'a', revision: 1, updatedAt: '2026-01-01T01:00:00Z' }]
      : [],
};
snapshot.model = {
  configured: true,
  available: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 1,
};
snapshot.profiles = state.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    color: bot.color,
    instructions: bot.role,
    memory: '',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
if (mode === 'busy')
  snapshot.agents.a = {
    running: true,
    phase: 'running',
    runId: 'mock-running',
    requestId: 'mock-running',
    prompt: '合成进行中的私聊任务',
    result: '',
    error: '',
    files: [],
    toolCount: 0,
    executedCount: 0,
    trace: [],
    history: [],
    chatRevision: 0,
  };
const listeners = new Set<Parameters<RuntimeBridge['subscribe']>[0]>();
let ack: ChatAck | undefined;
function publish() {
  snapshot = { ...snapshot };
  for (const listener of listeners) listener(snapshot);
}
function fixture(command: RuntimeCommand): unknown {
  if (command.type === 'status') return snapshot;
  if (command.type === 'chat.new') {
    if (mode === 'busy') throw new Error('CHAT_BUSY');
    if (ack?.receipt.request.id !== command.request.id) {
      const chat = {
        bot: command.request.bot,
        revision: command.request.revision + 1,
        updatedAt: '2026-01-01T01:00:00Z',
      };
      ack = {
        chat,
        receipt: { request: command.request, revision: chat.revision, completedAt: chat.updatedAt },
      };
      snapshot.chats = { available: true, revision: chat.revision, items: [chat] };
      publish();
    }
    if (mode === 'uncertain') throw new Error('RUNTIME_TIMEOUT');
    return ack;
  }
  if (command.type === 'chat.receipt') {
    if (mode === 'pending') {
      const chat = snapshot.chats!.items[0];
      return {
        chat,
        receipt: {
          request: state.chatRequests.research!,
          revision: 1,
          completedAt: chat.updatedAt,
        },
      };
    }
    if (!ack) throw new Error('CHAT_RECEIPT_NOT_FOUND');
    return ack;
  }
  if (command.type === 'chat.history')
    return {
      bot: command.bot,
      revision: command.revision,
      items: [
        {
          chatRevision: command.revision,
          runId: command.before ? 'mock-earlier-run' : 'mock-old-run',
          requestId: 'mock-old-user',
          prompt: command.before ? '合成更早的问题' : '合成历史：请整理上一份方案的核对要点。',
          result: command.before
            ? '合成更早的回复：旧内容仍可独立阅读。'
            : '合成回复：先核对目标、时间和资料，确认后再安排执行。\n\n- 明确本轮要交付的内容。\n- 核对资料版本和时间。\n- 等待用户确认，再安排下一步。',
          phase: 'completed',
          error: '',
        },
      ],
      ...(command.before ? {} : { nextBefore: 'mock-old-run' }),
    };
  if (command.type === 'files.list') return [];
  if (command.type === 'task.start') throw new Error('SYNTHETIC_PREVIEW_NO_MODEL');
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
