import {
  agentId,
  type GroupPage,
  type Interaction,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeTask,
  type TranscriptItem,
  type TranscriptScope,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { clientCache } from '../../src/cache';
import { demoState as initialState } from '../../src/fixtures';
import { serialize, storageKey } from '../../src/storage';
import { previewSnapshot } from '../runtime';
import '../../src/tokens.css';
import '../../src/styles.css';

// Synthetic production-component preview. No model, VM, credential or original workspace is connected.
const query = new URLSearchParams(location.search),
  mode = query.get('mode') || 'normal';
const seed = initialState();
seed.panel = null;
seed.selected = mode === 'group' ? 'crew' : 'research';
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
for (const bot of seed.bots) {
  seed.messages[bot.id] = [];
  bot.name = `合成${bot.name}`;
}
seed.drafts.research = '合成未发送草稿：下一步由我确认后发送。';
seed.drafts.crew = '合成群聊草稿：保留给下一轮协作。';
const scope: TranscriptScope =
  mode === 'group'
    ? { bot: 'b', runId: 'mock-preview-group-run', conversationId: 'crew' }
    : { bot: 'a', runId: 'mock-preview-private-run', chatRevision: 0 };
const reply =
  mode === 'incomplete'
    ? '合成任务已停止。以下记录只覆盖已保存的部分，请核对后续操作。'
    : '合成核对已完成。执行步骤与原始输出已保留，可以展开查看；未执行任何真实业务操作。';
seed.messages.research = [
  { id: 'mock-execution-disclosure', role: 'notice', text: '合成验收数据 · 未连接真实模型或电脑' },
  {
    id: 'mock-preview-request',
    role: 'user',
    text: '合成请求：核对资料，列出步骤和需要我确认的事项。',
  },
  { id: `runtime-result:${scope.runId}`, role: 'bot', text: reply },
];
if (mode === 'approval') seed.messages.research = seed.messages.research.slice(0, 2);
clientCache().setItem(storageKey, serialize(seed));
const snapshot = previewSnapshot(mode === 'legacy' ? 32 : undefined);
snapshot.model = {
  ...snapshot.model,
  configured: true,
  available: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 1,
};
snapshot.profiles = seed.bots
  .filter((bot) => !bot.members)
  .map((bot) => ({
    id: agentId(bot.id),
    name: bot.name,
    color: bot.color,
    instructions: '',
    memory: '',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
snapshot.chats = { available: true, revision: 0, items: [] };
if (mode === 'history')
  snapshot.chats = {
    available: true,
    revision: 1,
    items: [{ bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' }],
  };
snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
const task: RuntimeTask = {
  ...scope,
  running: false,
  phase: mode === 'incomplete' ? 'stopped' : 'completed',
  requestId: 'mock-preview-request',
  prompt: '合成请求：核对资料，列出步骤和需要我确认的事项。',
  result: reply,
  error: '',
  toolCount: 2,
  executedCount: 2,
  files: [],
  trace: [],
  history: [],
};
snapshot.agents[scope.bot] = task;
if (mode === 'approval') {
  snapshot.agents[scope.bot] = { ...task, running: true, phase: 'waiting', result: '' };
  snapshot.interactions = [
    {
      id: 'mock-command-review',
      bot: scope.bot,
      runId: scope.runId,
      sessionId: 'mock-session',
      kind: 'approval',
      tool: 'vm_command',
      target: 'linux-vm',
      purpose: '在独立终端里打开示例工具',
      cwd: '/mock/workspace/shared/model-runs/mock-session/mock-bot',
      command:
        'cd /mock/workspace/shared/model-runs/mock-session/mock-bot && x-terminal-emulator -e /opt/mock/bin/mock-cli --no-alt-screen',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
}
const group = {
  id: 'crew',
  name: '合成协作小组',
  members: ['a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
snapshot.groups = { available: true, revision: 1, items: [group] };
const groupPage: GroupPage = {
  group,
  revision: 1,
  deliveries: [],
  messages: [
    {
      id: 'mock-group-disclosure',
      group: group.id,
      sequence: 1,
      sourceId: 'mock-preview-source',
      role: 'notice',
      text: '合成验收数据 · 未连接真实模型或电脑',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'mock-group-request',
      group: group.id,
      sequence: 2,
      sourceId: 'mock-preview-source',
      role: 'user',
      text: task.prompt,
      createdAt: '2026-01-01T00:00:01Z',
    },
    {
      id: 'mock-group-reply',
      group: group.id,
      sequence: 3,
      sourceId: 'mock-preview-source',
      role: 'bot',
      author: 'b',
      name: '合成写作搭档',
      runId: scope.runId,
      text: reply,
      phase: 'completed',
      createdAt: '2026-01-01T00:00:02Z',
    },
  ],
};
const bodies = [
  JSON.stringify({ query: '合成资料核对要点', limit: 3 }, null, 2),
  mode === 'long'
    ? `${'合成长输出：资料、时间、责任人与待确认事项。\n'.repeat(3500)}${'SYNTHETIC-UNBROKEN-OUTPUT-'.repeat(80)}`
    : '合成检索结果：已找到三项待核对资料。本页仅用于展示执行记录，不代表真实检索。',
  JSON.stringify(
    {
      kind: 'question',
      status: 'resolved',
      questions: [
        { question: '合成计划采用哪个版本？', options: [{ label: '简版' }, { label: '详细版' }] },
      ],
      reply: { kind: 'answer', answers: [{ selected: ['简版'] }] },
    },
    null,
    2,
  ),
  JSON.stringify(
    [
      { content: '核对合成资料与日期', status: 'completed' },
      { content: '整理需要人类确认的事项', status: 'completed' },
    ],
    null,
    2,
  ),
  reply,
];
const items: TranscriptItem[] = bodies.map((text, index) => ({
  seq: index + 1,
  kind: (['call', 'result', 'interaction', 'plan', 'assistant'] as const)[index],
  at: `2026-01-01T00:00:0${index}Z`,
  characters: text.length,
  ...(index < 2
    ? { callId: 'mock-search-call', ...(index === 0 ? { name: 'web_search' } : { isError: false }) }
    : {}),
}));
function fixture(command: RuntimeCommand): unknown {
  if (command.type === 'status') return snapshot;
  if (command.type === 'interaction.reply' && mode === 'approval') {
    const request = snapshot.interactions?.find((item) => item.id === command.id);
    if (!request) throw new Error('SYNTHETIC_REQUEST_NOT_FOUND');
    const updated: Interaction = { ...request, status: 'resolved', reply: command.reply };
    snapshot.interactions = snapshot.interactions?.map((item) =>
      item.id === updated.id ? updated : item,
    );
    return updated;
  }
  if (command.type === 'bot.register')
    return snapshot.profiles.find((profile) => profile.id === command.profile.id);
  if (command.type === 'group.read') return groupPage;
  if (command.type === 'chat.history')
    return {
      bot: 'a',
      revision: command.revision,
      items: [
        {
          chatRevision: command.revision,
          runId: scope.runId,
          requestId: task.requestId!,
          prompt: task.prompt,
          result: reply,
          error: '',
          phase: task.phase,
        },
      ],
    };
  if (command.type === 'transcript.list') {
    if (mode === 'error') throw new Error('TRANSCRIPT_UNAVAILABLE');
    return {
      ...command.query.scope,
      state: mode === 'incomplete' ? 'interrupted' : 'complete',
      items: items.filter((item) => item.seq > (command.query.after ?? 0)),
    };
  }
  if (command.type === 'transcript.content') {
    const source = bodies[command.query.seq - 1];
    if (source === undefined) throw new Error('TRANSCRIPT_NOT_FOUND');
    const offset = command.query.offset ?? 0,
      text = source.slice(offset, offset + 32000);
    return {
      ...command.query.scope,
      seq: command.query.seq,
      offset,
      text,
      total: source.length,
      ...(offset + text.length < source.length ? { nextOffset: offset + text.length } : {}),
    };
  }
  throw new Error('SYNTHETIC_PREVIEW_ONLY');
}
const runtime: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand) {
    try {
      return { ok: true, value: fixture(command) as T };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'SYNTHETIC_PREVIEW_ONLY',
      };
    }
  },
  subscribe: () => () => {},
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime },
});
createRoot(document.getElementById('root')!).render(<App />);
