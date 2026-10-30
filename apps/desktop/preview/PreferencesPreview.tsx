import {
  agentId,
  disconnected,
  type MemoryPage,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App';
import { demoState as initialState } from '../src/fixtures';
import { serialize, storageKey } from '../src/storage';
import '../src/tokens.css';
import '../src/styles.css';

// Synthetic production-component preview only. No model or original user workspace is connected.
const query = new URLSearchParams(location.search),
  mode = query.get('mode') || 'normal';
const seed = initialState();
seed.selected = 'research';
seed.panel = 'memory';
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
for (const bot of seed.bots) seed.messages[bot.id] = [];
seed.drafts.research = '合成聊天草稿：核对后由我发送。';
const current = mode === 'empty' ? '' : '合成工作偏好：先给结论，再列出需要确认的事项。';
seed.memories.research = current;
seed.memoryDrafts.research =
  mode === 'dirty' ? '合成未保存草稿：保留这段内容，不要用历史版本覆盖。' : current;
seed.memoryVersions.research = seed.profileRevisions.a = mode === 'empty' ? 1 : 8;
localStorage.setItem(storageKey, serialize(seed));
let snapshot = disconnected('ready');
snapshot.protocolVersion = mode === 'legacy' ? 31 : 32;
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    color: bot.color,
    memory: bot.id === 'research' ? current : '',
    revision: bot.id === 'research' && mode !== 'empty' ? 8 : 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-08T00:00:00Z',
  }));
snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
snapshot.chats = { available: true, revision: 0, items: [] };
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
const runtime: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand) {
    let value: unknown = {};
    if (command.type === 'status') value = snapshot;
    else if (command.type === 'bot.register')
      value = snapshot.profiles.find((profile) => profile.id === command.profile.id);
    else if (command.type === 'memory.history') {
      if (mode === 'error') return { ok: false, error: 'MEMORY_HISTORY_CORRUPT' };
      const profile = snapshot.profiles.find((profile) => profile.id === command.bot)!;
      const before = command.query.before ?? profile.revision + 1;
      const numbers = Array.from(
        { length: Math.min(5, before - 1) },
        (_, index) => before - index - 1,
      );
      value = {
        bot: command.bot,
        profileRevision: profile.revision,
        currentRevision: profile.revision,
        limited: mode === 'long',
        ...(numbers.at(-1)! > 1 ? { nextBefore: numbers.at(-1) } : {}),
        items: numbers.map((revision) => ({
          revision,
          content:
            revision === profile.revision
              ? profile.memory
              : mode === 'long'
                ? '合成历史长内容：这里保留完整偏好，查看时不会交给模型。\n'.repeat(120)
                : `合成历史偏好 ${revision}：先列依据，再整理成简洁的待办。`,
          source: mode === 'empty' ? 'baseline' : revision === profile.revision ? 'agent' : 'edit',
          createdAt: `2026-01-${String(revision).padStart(2, '0')}T00:00:00Z`,
        })),
      } satisfies MemoryPage;
    } else if (command.type === 'bot.update') {
      const existing = snapshot.profiles.find((profile) => profile.id === command.bot)!;
      if (existing.revision !== command.revision)
        return { ok: false, error: 'BOT_PROFILE_CONFLICT' };
      value = {
        ...existing,
        memory: command.patch.memory ?? existing.memory,
        revision: existing.revision + 1,
      };
      snapshot = {
        ...snapshot,
        profiles: snapshot.profiles.map((profile) =>
          profile.id === command.bot ? (value as typeof existing) : profile,
        ),
      };
      for (const listener of listeners) listener(snapshot);
    } else if (command.type === 'task.start') return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
    return { ok: true, value: value as T };
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime },
});
createRoot(document.getElementById('root')!).render(<App />);
