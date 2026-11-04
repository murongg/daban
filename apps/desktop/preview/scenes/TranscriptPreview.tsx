import {
  agentId,
  disconnected,
  type Group,
  type GroupPage,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
  type RuntimeTask,
  type RuntimeTaskSummary,
} from '@daban/protocol';
import {
  type Dispatch,
  Profiler,
  type ProfilerOnRenderCallback,
  useCallback,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import { clientCache } from '../../src/app/cache';
import { RuntimeProvider } from '../../src/app/Runtime';
import { type Action, type Message, reduce } from '../../src/app/state';
import { serialize, storageKey } from '../../src/app/storage';
import { Conversation } from '../../src/features/chat/Conversation';
import { GroupChat } from '../../src/features/groups/GroupChat';
import { demoState } from '../../src/test/fixtures';
import '../../src/styles/styles.css';

// Offline production-component benchmark: synthetic data only, with no model, credentials or VM connection.
const query = new URLSearchParams(location.search);
const count = Math.max(100, Math.min(10000, Number(query.get('count')) || 1000));
const groupMode = query.get('kind') === 'group';
const seed = demoState();
seed.selected = groupMode ? 'crew' : 'research';
seed.panel = null;
const bot = seed.bots.find((item) => item.id === (groupMode ? 'crew' : 'research'))!;
const text = (index: number) =>
  `SYNTHETIC MESSAGE ${index}\n\n${'合成资料：核对目标、时间和约束。'.repeat((index % 7) + 1)}${index % 13 === 1 ? '\n\n```ts\nconst synthetic = 7 + 11;\n```' : ''}`;
const messages: Message[] = Array.from({ length: count }, (_, index) => ({
  id: index % 2 ? `runtime-result:run-${String(index).padStart(6, '0')}` : `mock-user-${index}`,
  role: index % 2 ? 'bot' : 'user',
  text: text(index),
  chatRevision: 0,
}));
const active: RuntimeTask = {
  running: true,
  phase: 'running',
  runId: 'mock-active-run',
  requestId: 'mock-active-request',
  prompt: 'SYNTHETIC CURRENT REQUEST',
  result: '',
  error: '',
  files: [],
  toolCount: 0,
  executedCount: 0,
  trace: [],
  response: {
    revision: 1,
    turnId: 'mock-active-request',
    text: 'SYNTHETIC STREAM 0',
    state: 'streaming',
  },
  history: [
    {
      runId: `run-${String(count - 1).padStart(6, '0')}`,
      requestId: 'mock-saved-request',
      chatRevision: 0,
      prompt: 'SYNTHETIC SAVED QUESTION',
      result: text(count - 1),
      error: '',
      phase: 'completed',
    },
  ],
  ...(groupMode ? { conversationId: bot.id } : { chatRevision: 0 }),
};
seed.messages[bot.id] = groupMode
  ? []
  : [...messages, { id: active.requestId!, role: 'user', text: active.prompt }];
seed.drafts[bot.id] = '';
const group: Group = {
  id: bot.id,
  name: 'Synthetic benchmark group',
  members: ['a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const page: GroupPage = {
  group,
  revision: 1,
  messages: [
    ...messages.map((message, index) => ({
      id: message.id,
      group: bot.id,
      sourceId: `mock-source-${Math.floor(index / 3)}`,
      sequence: index + 1,
      role: message.role === 'bot' ? ('bot' as const) : ('user' as const),
      author: message.role === 'bot' ? 'b' : undefined,
      name: message.role === 'bot' ? 'Synthetic member' : undefined,
      text: message.text,
      createdAt: '2026-01-01T00:00:00Z',
    })),
    {
      id: active.requestId!,
      group: bot.id,
      sourceId: 'mock-live-source',
      sequence: count + 1,
      role: 'user',
      text: active.prompt,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  deliveries: [
    {
      id: 'mock-live-delivery',
      group: bot.id,
      sourceId: 'mock-live-source',
      requestId: active.requestId!,
      bot: 'a',
      position: 0,
      state: 'running',
      runId: active.runId,
    },
  ],
};
let snapshot = disconnected('ready');
snapshot.protocolVersion = 45;
snapshot.model.configured = true;
snapshot.model.available = true;
snapshot.groups = { available: true, revision: 1, items: [group] };
snapshot.agents.a = active;
snapshot.profiles = seed.bots
  .filter((item) => !item.members)
  .map((item) => ({
    id: agentId(item.id),
    name: item.name,
    color: item.color,
    instructions: item.role,
    memory: '',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
clientCache().setItem(storageKey, serialize(seed));
const durations: number[] = [];
const profile: ProfilerOnRenderCallback = (_id, _phase, duration) => {
  durations.push(duration);
};
const listeners = new Set<(state: RuntimeSnapshot) => unknown>();
function publish(task: Partial<RuntimeTask> = {}) {
  snapshot = { ...snapshot, agents: { ...snapshot.agents, a: { ...snapshot.agents.a, ...task } } };
  for (const listener of listeners) listener(snapshot);
}
let requestCount = 0;
async function command(command: RuntimeCommand): Promise<unknown> {
  if (command.type === 'status') return snapshot;
  if (command.type === 'group.read') return page;
  if (command.type === 'transcript.list')
    return {
      ...command.query.scope,
      state: 'complete',
      items: [
        { seq: 1, kind: 'thinking', at: '2026-01-01T00:00:00Z', characters: thinking.length },
      ],
    };
  if (command.type === 'transcript.content')
    return { ...command.query.scope, seq: 1, offset: 0, total: thinking.length, text: thinking };
  if (command.type === 'chat.history') {
    requestCount++;
    const items: RuntimeTaskSummary[] = Array.from({ length: 20 }, (_, index) => ({
      chatRevision: 0,
      runId: `older-${String(index).padStart(6, '0')}`,
      requestId: `mock-older-request-${index}`,
      prompt: `SYNTHETIC OLDER REQUEST ${index}`,
      result: `SYNTHETIC OLDER ANSWER ${index}`,
      error: '',
      phase: 'completed',
    }));
    return { bot: command.bot, revision: command.revision, items };
  }
  return {};
}
const thinking = 'SYNTHETIC THINKING: 核对合成材料并保留阅读位置。'.repeat(30);
const bridge: RuntimeBridge = {
  async invoke<T>(value: RuntimeCommand) {
    return { ok: true, value: (await command(value)) as T };
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
declare global {
  interface Window {
    transcriptPreview: {
      stream: (index: number) => unknown;
      question: () => unknown;
      resolve: () => unknown;
      requestCount: () => number;
      metrics: () => { commits: number; totalMs: number; maxMs: number };
      resetMetrics: () => unknown;
    };
  }
}
window.transcriptPreview = {
  stream(index) {
    publish({
      response: {
        revision: index + 2,
        turnId: 'mock-active-request',
        text: `SYNTHETIC STREAM ${index}\n\n${'合成流式段落持续增长。'.repeat(index + 1)}`,
        state: 'streaming',
      },
    });
  },
  question() {
    snapshot = {
      ...snapshot,
      interactions: [
        {
          id: 'mock-window-question',
          bot: 'a',
          runId: active.runId!,
          sessionId: 'mock-window-session',
          kind: 'question',
          status: 'pending',
          questions: [{ id: 'format', question: 'SYNTHETIC PENDING QUESTION' }],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          ...(groupMode ? { conversationId: bot.id } : {}),
        },
      ],
    };
    publish({ phase: 'waiting' });
  },
  resolve() {
    snapshot = { ...snapshot, interactions: [] };
    publish({ phase: 'running' });
  },
  requestCount: () => requestCount,
  metrics: () => ({
    commits: durations.length,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    maxMs: Math.max(0, ...durations),
  }),
  resetMetrics: () => {
    durations.length = 0;
  },
};
const noop = () => {};
function Preview() {
  const [state, setState] = useState(seed);
  const dispatch: Dispatch<Action> = useCallback(
    (action) => setState((previous) => reduce(previous, action)),
    [],
  );
  const props = { state, bot, dispatch, notify: noop, preview: noop };
  return (
    <RuntimeProvider>
      {groupMode ? <GroupChat {...props} /> : <Conversation {...props} onModel={() => {}} />}
    </RuntimeProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <Profiler id="synthetic-transcript" onRender={profile}>
    {query.has('shell') ? (
      <App />
    ) : (
      <div className="app">
        <Preview />
      </div>
    )}
  </Profiler>,
);
