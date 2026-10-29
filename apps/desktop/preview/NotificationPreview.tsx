import { agentId, disconnected, type RuntimeBridge, type RuntimeCommand } from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import type {
  NoticeActivation,
  NoticeBridge,
  NoticeCommand,
  NoticeMessage,
  NoticeStatus,
} from '../notifications';
import { App } from '../src/App';
import { initialState } from '../src/state';
import { serialize, storageKey } from '../src/storage';
import '../src/tokens.css';
import '../src/styles.css';

// Synthetic production-React fixture: no native permission, OS notification, VM or provider call.
const query = new URLSearchParams(location.search),
  mode = query.get('mode') || 'off';
const seed = initialState();
seed.panel = null;
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
seed.view = mode === 'defer' ? 'chat' : 'settings';
seed.drafts.research = '合成未发送草稿：提醒不会替我发送内容。';
localStorage.setItem(storageKey, serialize(seed));
const snapshot = disconnected('ready');
snapshot.protocolVersion = 30;
snapshot.chats = { available: true, revision: 0, items: [] };
snapshot.notices = { available: true, items: [] };
snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
snapshot.skills = { available: true, revision: 0 };
snapshot.mcp = { available: false, error: 'MCP_STORE_UNAVAILABLE' };
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    color: bot.color,
    memory: '',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
let status: NoticeStatus = {
  available: mode !== 'corrupt',
  supported: mode !== 'unsupported',
  enabled: ['on', 'failed', 'task', 'defer'].includes(mode),
  revision: 0,
  delivery: 'untried',
  runtime: mode === 'partial' ? 'partial' : 'ready',
  ...(mode === 'corrupt' ? { error: 'NOTIFICATION_STORE_UNAVAILABLE' } : {}),
};
const listeners = new Set<(message: NoticeMessage) => unknown>();
let pending: NoticeActivation | undefined;
const emit = (activation: NoticeActivation) => {
  pending = activation;
  for (const listener of listeners) listener({ type: 'navigate', activation });
};
let simulated = false;
const runtime: RuntimeBridge = {
  invoke: async <T,>(command: RuntimeCommand) => ({
    ok: true,
    value: (command.type === 'status'
      ? snapshot
      : command.type === 'chat.history'
        ? {
            bot: command.bot,
            revision: command.revision,
            items: [
              {
                chatRevision: command.revision,
                runId: command.runId || 'mock-result',
                requestId: 'mock-result-request',
                prompt: '合成任务：整理方案核对要点。',
                result:
                  '合成结果：已列出三项待核对内容。\n\n- 明确目标和交付时间。\n- 核对资料版本。\n- 确认后再执行下一步。',
                error: '',
                phase: 'completed',
              },
            ],
          }
        : command.type === 'files.list'
          ? []
          : {}) as T,
  }),
  subscribe: () => () => {},
};
const notifications: NoticeBridge = {
  invoke: async <T,>(command: NoticeCommand) => {
    if (command.type === 'pending') return { ok: true, value: pending as T };
    if (command.type === 'ack') {
      if (pending?.id === command.id) pending = undefined;
      return { ok: true, value: undefined as T };
    }
    if (command.type === 'configure')
      status = {
        ...status,
        enabled: command.enabled,
        revision: status.revision + 1,
        error: undefined,
      };
    if (command.type === 'test')
      status = {
        ...status,
        delivery: mode === 'failed' ? 'failed' : 'submitted',
        ...(mode === 'failed' ? { error: 'NOTIFICATION_DELIVERY_FAILED' } : {}),
      };
    for (const listener of listeners) listener({ type: 'status', status });
    return { ok: true, value: status as T };
  },
  subscribe: (listener) => {
    listeners.add(listener);
    if (mode === 'task' && !simulated) {
      simulated = true;
      queueMicrotask(() =>
        emit({
          id: 'mock-click',
          scope: 'a'.repeat(64),
          target: {
            kind: 'task',
            id: 'mock-result',
            bot: 'a',
            chatRevision: 0,
            phase: 'completed',
          },
        }),
      );
    }
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime, notifications },
});
const root = document.getElementById('root');
if (!root) throw new Error('SYNTHETIC_ROOT_MISSING');
const view = createRoot(root);
view.render(<App />);
const observer = new MutationObserver(() => {
  if (mode === 'defer' && !simulated && document.querySelector('[role="dialog"]')) {
    simulated = true;
    emit({ id: 'mock-deferred', scope: 'a'.repeat(64), target: { kind: 'settings' } });
  }
});
if (mode === 'defer') observer.observe(document.body, { childList: true, subtree: true });
import.meta.hot?.dispose(() => {
  observer.disconnect();
  view.unmount();
});
