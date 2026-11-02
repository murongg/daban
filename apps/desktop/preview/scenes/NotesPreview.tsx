import {
  agentId,
  type NoteItem,
  type NoteWrite,
  noteKey,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import { clientCache } from '../../src/app/cache';
import { storageKey } from '../../src/app/storage';
import { noteDraft, noteInitial, noteInput } from '../../src/features/notes/notes-state';
import { demoState as initialState } from '../../src/test/fixtures';
import { previewSnapshot } from '../runtime';
import '../../src/styles/tokens.css';
import '../../src/styles/styles.css';

// Synthetic production-component specimen; no model, VM, credentials or external services are connected.
const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'list';
const at = '2026-01-01T09:20:00Z';
const items = new Map<string, NoteItem>();
for (const bot of ['a', 'b'])
  for (let index = 0; index < (mode === 'empty' ? 0 : 4); index++) {
    const id = `mock-note-${index}`;
    const status = (['open', 'parked', 'done'] as const)[index % 3];
    items.set(`${bot}/${id}`, {
      bot,
      id,
      title: [
        '合成：核对活动资料',
        '合成：暂存两个内容方向',
        '合成：整理复盘摘要',
        '合成：保留待确认的问题',
      ][index],
      body: '合成验收记录：\n核对提供的材料，记下需要进一步确认的问题。\n这张便笺只属于当前 Bot，不会自动启动任务。',
      status,
      revision: 1,
      deleted: false,
      createdAt: at,
      updatedAt: at,
      createdBy: { kind: 'human' },
      updatedBy: { kind: 'bot', bot },
      ...(status === 'done' ? { completedAt: at } : {}),
    });
  }
const seed = initialState();
seed.panel = 'notes';
seed.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
seed.drafts.research = '合成未发送草稿：切换便笺后请保留。';
for (const bot of seed.bots) {
  bot.name = `合成${bot.name}`;
  seed.messages[bot.id] = [
    { id: `mock-notes-${bot.id}`, role: 'notice', text: '合成便笺界面验收 · 未连接模型或电脑' },
  ];
}
const first = items.get('a/mock-note-0');
const notes = noteInitial();
if (first && ['editor', 'conflict', 'archived'].includes(mode)) {
  notes.draft = noteDraft('a', first);
  if (mode === 'conflict') {
    notes.draft.title = '合成：本机保留的核对标题';
    items.set('a/mock-note-0', {
      ...first,
      body: '合成 Bot 新进展：两份材料已收到，还需核对第三份。',
      status: 'parked',
      revision: 2,
    });
  }
}
if (mode === 'pending') {
  const draft = {
    ...noteDraft('a'),
    title: '合成：待确认的复盘便笺',
    body: '合成待确认记录：重新打开只核对回执，不会自动重发。',
  };
  notes.draft = draft;
  notes.pending = { draft, request: noteInput(draft, 'mock-pending-op', 'mock-pending-note')! };
}
seed.notes = { research: notes };
clientCache().setItem(storageKey, JSON.stringify({ version: 1, state: seed }));
const snapshot = previewSnapshot(['old', 'legacy'].includes(mode) ? 36 : undefined);
snapshot.notes =
  mode === 'unavailable' ? { available: false, error: 'NOTES_CORRUPT' } : { available: true };
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    memory: '',
    color: bot.color,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...(mode === 'archived' && bot.id === 'research' ? { archived: true } : {}),
  }));
const operations = new Map<string, { request: NoteWrite; bot: string; acceptedRevision: number }>();
const ack = (saved: { request: NoteWrite; bot: string; acceptedRevision: number }) => ({
  state: 'complete',
  ...saved,
  actor: { kind: 'human' },
  acceptedAt: at,
  item: items.get(`${saved.bot}/${saved.request.note}`),
});
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
    try {
      let value: unknown;
      if (command.type === 'status') value = snapshot;
      else if (command.type === 'notes.list') {
        if (mode === 'load-error') throw Error('RUNTIME_REQUEST_FAILED');
        const selected = [...items.values()].filter(
          (row) =>
            row.bot === command.bot &&
            row.deleted === (command.query.filter === 'trash') &&
            (command.query.filter !== 'active' || row.status !== 'done') &&
            (!['open', 'parked', 'done'].includes(command.query.filter ?? '') ||
              row.status === command.query.filter) &&
            (!command.query.text || `${row.title} ${row.body}`.includes(command.query.text)),
        );
        value = {
          bot: command.bot,
          query: command.query,
          page: {
            bot: command.bot,
            revision: [...items.values()]
              .filter((row) => row.bot === command.bot)
              .reduce((sum, row) => sum + row.revision, 0),
            items: selected.map((row) => ({
              ...row,
              body: Array.from(row.body).slice(0, 200).join(''),
              bodyTruncated: Array.from(row.body).length > 200,
            })),
          },
        };
      } else if (command.type === 'notes.read') {
        value = items.get(`${command.bot}/${command.id}`);
        if (!value) throw Error('NOTE_NOT_FOUND');
      } else if (command.type === 'notes.receipt') {
        const saved = operations.get(noteKey(command.bot, command.request, { kind: 'human' }));
        value = saved
          ? ack(saved)
          : {
              state: 'unknown',
              bot: command.bot,
              request: command.request,
              actor: { kind: 'human' },
            };
      } else if (command.type === 'notes.write') {
        if (mode === 'pending') throw Error('RUNTIME_REQUEST_FAILED');
        const { bot, request } = command;
        const fingerprint = noteKey(bot, request, { kind: 'human' });
        const saved = operations.get(fingerprint);
        if (saved) return { ok: true, value: structuredClone(ack(saved)) as T };
        const key = `${bot}/${request.note}`,
          old = items.get(key);
        if (request.action === 'create')
          items.set(key, {
            bot,
            id: request.note,
            ...request.value,
            revision: 1,
            deleted: false,
            createdAt: at,
            updatedAt: at,
            createdBy: { kind: 'human' },
            updatedBy: { kind: 'human' },
            ...(request.value.status === 'done' ? { completedAt: at } : {}),
          });
        else {
          if (!old) throw Error('NOTE_NOT_FOUND');
          if (old.revision !== request.revision) throw Error('NOTE_CONFLICT');
          const next = {
            ...old,
            ...(request.action === 'update'
              ? request.value
              : { deleted: request.action === 'trash' }),
            revision: old.revision + 1,
            updatedBy: { kind: 'human' as const },
          };
          if (next.status === 'done') next.completedAt ||= at;
          else delete next.completedAt;
          items.set(key, next);
        }
        const accepted = { bot, request, acceptedRevision: items.get(key)!.revision };
        operations.set(fingerprint, accepted);
        value = ack(accepted);
      } else return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
      return { ok: true, value: structuredClone(value) as T };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'MOCK_FAILED' };
    }
  },
  subscribe: () => () => {},
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
createRoot(document.getElementById('root')!).render(<App />);
