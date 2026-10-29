import {
  agentId,
  type BotCopyAck,
  type BotCopyRequest,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { initialState } from '../src/state';
import { restore, serialize, storageKey } from '../src/storage';
import '../src/tokens.css';
import '../src/styles.css';

// This private fixture uses production components with synthetic data and no VM/model connection.
const query = new URLSearchParams(location.search);
const mode = query.get('mode') ?? 'normal';
const seed = initialState();
seed.selected = 'research';
seed.panel = null;
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
for (const bot of seed.bots) {
  bot.name = `合成${bot.name}`;
  seed.messages[bot.id] = [
    { id: `mock-copy-${bot.id}`, role: 'notice', text: '合成复制验收 · 未连接模型或电脑' },
  ];
}
seed.drafts.research = '合成未发送草稿：复制后请保留在原 Bot。';
const sealed: BotCopyRequest = {
  id: 'mock-copy-pending',
  bot: 'a',
  revision: 1,
  name: '合成研究员 副本',
  memory: true,
};
if (mode === 'pending') seed.botCopy = sealed;
if (query.get('keep') !== '1' || !localStorage.getItem(storageKey))
  localStorage.setItem(storageKey, serialize(seed));
const state = restore(localStorage.getItem(storageKey));
let snapshot = disconnected('ready');
snapshot.protocolVersion = mode === 'old' ? 33 : 34;
snapshot.profiles = state.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    color: bot.color,
    revision: 1,
    instructions:
      bot.id === 'research' ? '整理公开资料，核对出处，并将结论写成简洁的中文说明。' : bot.role,
    memory: bot.id === 'research' ? '先给结论，再列出证据。遇到不确定的信息，请明确说明。' : '',
    ...(bot.id === 'research' ? { model: 'deepseek-v4-pro' as const } : {}),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
const receipts = new Map<string, BotCopyAck>();
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
let conflict = mode === 'conflict';
function publish() {
  snapshot = { ...snapshot };
  for (const listener of listeners) listener(snapshot);
}
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
    if (command.type === 'status') return { ok: true, value: snapshot as T };
    if (command.type === 'bot.copy.receipt')
      return {
        ok: true,
        value: (receipts.get(command.request.id) ?? {
          request: command.request,
          state: 'unknown',
        }) as T,
      };
    if (command.type === 'bot.copy') {
      const request = command.request;
      if (conflict) {
        conflict = false;
        snapshot.profiles = snapshot.profiles.map((profile) =>
          profile.id === request.bot
            ? {
                ...profile,
                revision: 2,
                instructions: '合成更新：补充证据日期，保留不确定性说明。',
              }
            : profile,
        );
        publish();
        return { ok: false, error: 'BOT_PROFILE_CONFLICT' };
      }
      const source = snapshot.profiles.find((profile) => profile.id === request.bot);
      if (!source) return { ok: false, error: 'BOT_PROFILE_NOT_FOUND' };
      const previous = receipts.get(request.id);
      if (previous) return { ok: true, value: previous as T };
      const value: BotCopyAck = {
        request,
        state: 'complete',
        profile: {
          ...source,
          id: request.id,
          name: request.name,
          memory: request.memory ? source.memory : '',
          revision: 1,
        },
      };
      receipts.set(request.id, value);
      snapshot.profiles = [...snapshot.profiles, value.profile];
      publish();
      return { ok: true, value: value as T };
    }
    if (command.type === 'files.list') return { ok: true, value: [] as T };
    return { ok: false, error: 'MOCK_PREVIEW_ONLY' };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
createRoot(document.getElementById('root')!).render(<App />);
