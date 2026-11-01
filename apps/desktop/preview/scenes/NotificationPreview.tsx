import { agentId, type RuntimeBridge, type RuntimeCommand } from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import type {
  NoticeActivation,
  NoticeBridge,
  NoticeCommand,
  NoticeMessage,
  NoticeStatus,
} from '../../notifications';
import { isNoticeStatus } from '../../notifications';
import { App } from '../../src/App';
import { clientCache } from '../../src/cache';
import { demoState as initialState } from '../../src/fixtures';
import { serialize, storageKey } from '../../src/storage';
import { previewSnapshot } from '../runtime';
import '../../src/tokens.css';
import '../../src/styles.css';

// Synthetic production-React fixture: no native permission, OS notification, VM or provider call.
const query = new URLSearchParams(location.search),
  mode = query.get('mode') || 'off';
const seed = initialState();
seed.panel = null;
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
seed.view = mode === 'defer' ? 'chat' : 'settings';
seed.drafts.research = '合成未发送草稿：提醒不会替我发送内容。';
clientCache().setItem(storageKey, serialize(seed));
const snapshot = previewSnapshot(mode === 'legacy' ? 30 : undefined);
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
if (mode === 'offline') snapshot.phase = 'offline';
let status: NoticeStatus = {
  available: mode !== 'corrupt',
  supported: mode !== 'unsupported',
  enabled: ['on', 'failed', 'task', 'defer', 'conflict', 'long', 'offline'].includes(mode),
  revision: 0,
  delivery: 'untried',
  runtime: mode === 'partial' ? 'partial' : mode === 'offline' ? 'offline' : 'ready',
  scope: mode === 'offline' ? undefined : 'a'.repeat(64),
  bots:
    mode === 'empty'
      ? []
      : snapshot.profiles.slice(0, 3).map((bot, index) => ({
          id: bot.id,
          name:
            mode === 'long' && index === 0
              ? '合成：需要完整显示的研究与资料整理工作伙伴'
              : `合成${bot.name}`,
          enabled: index !== 1,
        })),
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
    if (command.type === 'bot.configure') {
      if (mode === 'conflict') return { ok: false, error: 'NOTIFICATION_CONFLICT' };
      if (command.scope !== status.scope) return { ok: false, error: 'NOTIFICATION_SCOPE_CHANGED' };
      if (command.revision !== status.revision)
        return { ok: false, error: 'NOTIFICATION_CONFLICT' };
      status = {
        ...status,
        revision: status.revision + 1,
        bots: status.bots?.map((bot) =>
          bot.id === command.bot ? { ...bot, enabled: command.enabled } : bot,
        ),
      };
    }
    if (command.type === 'test')
      status = {
        ...status,
        delivery: mode === 'failed' ? 'failed' : 'submitted',
        ...(mode === 'failed' ? { error: 'NOTIFICATION_DELIVERY_FAILED' } : {}),
      };
    if (!isNoticeStatus(status)) throw new Error('SYNTHETIC_NOTICE_STATUS_INVALID');
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
