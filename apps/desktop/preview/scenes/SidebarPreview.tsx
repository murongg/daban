import {
  agentId,
  type GroupPage,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { clientCache } from '../../src/cache';
import { demoState as initialState } from '../../src/fixtures';
import { reduce } from '../../src/state';
import { serialize, storageKey } from '../../src/storage';
import { previewSnapshot } from '../runtime';
import '../../src/tokens.css';
import '../../src/styles.css';

// An isolated session-storage specimen with synthetic data only. No VM, model, credential or external tool is connected.
const query = new URLSearchParams(location.search);
let seed = initialState();
seed.panel = null;
seed.selected = 'ideas';
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
for (const bot of seed.bots) {
  bot.name = `合成${bot.name}`;
  seed.messages[bot.id] = [
    { id: `mock-sidebar-${bot.id}`, role: 'notice', text: '合成侧栏验收 · 未连接真实模型或电脑' },
  ];
}
seed.drafts.ideas = '合成未发送草稿：整理列表时请保留。';
seed = reduce(seed, { type: 'section-create', id: 'mock-project', name: '合成项目' });
seed = reduce(seed, { type: 'section-create', id: 'mock-empty', name: '合成空分组' });
seed = reduce(seed, {
  type: 'section-create',
  id: 'mock-long',
  name: '合成长名称分组用于核对窗口收窄后的文字显示',
});
seed = reduce(seed, { type: 'bot-section', bot: 'writer', section: 'mock-project' });
seed = reduce(seed, { type: 'bot-section', bot: 'crew', section: 'mock-project' });
seed = reduce(seed, { type: 'bot-pin', bot: 'research', pinned: true });
seed = reduce(seed, { type: 'bot-read', bot: 'writer', unread: true });
seed = reduce(seed, { type: 'bot-read', bot: 'crew', unread: true });
if (query.get('keep') !== '1' || !clientCache().getItem(storageKey))
  clientCache().setItem(storageKey, serialize(seed));
let snapshot = previewSnapshot(query.get('mode') === 'legacy' ? 33 : undefined);
snapshot.model = {
  ...snapshot.model,
  available: true,
  // Bypass first-run setup in this scene; the synthetic bridge never calls a model.
  configured: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 0,
};
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    memory: '',
    color: bot.color,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
snapshot.notices = { available: true, items: [] };
const group = {
  id: 'crew',
  name: '合成周报协作',
  members: ['chief', 'a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
snapshot.groups = { available: true, revision: 1, items: [group] };
const page: GroupPage = {
  group,
  revision: 1,
  deliveries: [],
  messages: [
    {
      id: 'mock-group-message',
      sourceId: 'mock-group-source',
      group: 'crew',
      sequence: 1,
      role: 'notice',
      text: '合成群聊记录 · 未运行模型',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
};
const listeners = new Set<(state: RuntimeSnapshot) => unknown>();
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
    if (command.type === 'status' || command.type === 'connect')
      return { ok: true, value: snapshot as T };
    if (command.type === 'group.read' && command.group === 'crew')
      return { ok: true, value: page as T };
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
let sequence = 0;
const eventPrefix = `mock-sidebar-${crypto.randomUUID()}`;
function emit(groupQuestion: boolean) {
  sequence++;
  const id = `${eventPrefix}-${sequence}`;
  snapshot = groupQuestion
    ? {
        ...snapshot,
        interactions: [
          {
            id,
            kind: 'question',
            status: 'pending',
            bot: 'a',
            sessionId: 'mock-sidebar-session',
            runId: 'mock-sidebar-group-run',
            conversationId: 'crew',
            questions: [
              {
                id: 'format',
                question: '选择哪种合成格式？',
                options: [{ label: '清单' }, { label: '表格' }],
              },
            ],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
    : {
        ...snapshot,
        agents: {
          ...snapshot.agents,
          b: {
            running: false,
            phase: 'completed',
            runId: id,
            requestId: `mock-request-${sequence}`,
            chatRevision: 0,
            prompt: '合成请求：只验证侧栏未读提示。',
            result: '合成结果已就绪；没有调用真实模型。',
            error: '',
            toolCount: 0,
            executedCount: 0,
            files: [],
            trace: [],
            history: [],
          },
        },
        notices: {
          available: true,
          items: [
            ...(snapshot.notices?.items || []),
            { kind: 'task', id, bot: 'b', chatRevision: 0, phase: 'completed' },
          ],
        },
      };
  for (const listener of listeners) listener(snapshot);
}

function Preview() {
  const [controls, setControls] = useState(query.get('controls') === '1');
  return (
    <>
      <App />
      {controls && (
        <aside
          aria-label="合成验收控制"
          style={{
            position: 'fixed',
            top: 85,
            right: 16,
            zIndex: 60,
            display: 'flex',
            gap: 8,
            background: 'var(--canvas)',
            padding: 8,
          }}
        >
          <button type="button" className="secondary" onClick={() => emit(false)}>
            合成：后台新回复
          </button>
          <button type="button" className="secondary" onClick={() => emit(true)}>
            合成：群聊提问
          </button>
          <button type="button" className="text-button" onClick={() => setControls(false)}>
            隐藏验收控件
          </button>
        </aside>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
