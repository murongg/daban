import {
  type ComputerAck,
  type ComputerState,
  disconnected,
  isComputerStatus,
  type RuntimeBridge,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Computer } from '../src/Computer';
import { Conversation } from '../src/Conversation';
import { beginComputer, clearComputer, pendingComputer } from '../src/connections';
import { demoState as initialState } from '../src/fixtures';
import { RuntimeProvider } from '../src/Runtime';
import { reduce } from '../src/state';
import '../src/tokens.css';
import '../src/styles.css';

declare const __CONNECTION_SCREEN__: string;
const bot = { ...initialState().bots[0], id: 'mock-preview-bot', name: '合成研究员' };
const snapshot = disconnected('ready');
snapshot.protocolVersion = 19;
snapshot.model.configured = true;
snapshot.computers = { available: true, revision: 0, limit: 2, items: [] };
snapshot.profiles = [
  {
    id: bot.id,
    name: bot.name,
    instructions: '',
    memory: '',
    color: 'mint',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
function publish() {
  if (!isComputerStatus(snapshot.computers)) throw new Error('INVALID_SYNTHETIC_STATUS');
  for (const listener of listeners) listener(structuredClone(snapshot));
}
function stage(phase: ComputerState['phase'], occupied = false) {
  const pending = pendingComputer(bot.id);
  if (pending) clearComputer(bot.id, pending.id);
  snapshot.agents = {};
  const previous = snapshot.computers!.items.find((item) => item.bot === bot.id);
  const connected = phase === 'connected';
  const item: ComputerState = {
    bot: bot.id,
    phase,
    revision: (previous?.revision ?? 0) + 1,
    desired: phase !== 'disconnected',
    reserved: connected || phase === 'interrupted' || phase === 'connecting',
    ...(connected ? { instance: `mock-preview-instance-${crypto.randomUUID()}` } : {}),
    ...(phase === 'interrupted'
      ? { error: 'COMPUTER_OUTCOME_UNKNOWN', recovery: 'restart' as const }
      : {}),
  };
  snapshot.computers = {
    available: true,
    revision: snapshot.computers!.revision + 1,
    limit: 2,
    items: occupied
      ? ['mock-busy-a', 'mock-busy-b'].map((id) => ({
          ...item,
          bot: id,
          phase: 'connected',
          desired: true,
          reserved: true,
          instance: `${id}-instance`,
        }))
      : [item],
  };
  snapshot.bots = connected
    ? {
        [bot.id]: {
          owner: 'agent',
          epoch: item.revision,
          instance: item.instance,
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
        },
      }
    : {};
  publish();
  return item;
}
const bridge: RuntimeBridge = {
  invoke: async <T,>(command: Parameters<RuntimeBridge['invoke']>[0]) => {
    if (command.type === 'status')
      return { ok: true as const, value: structuredClone(snapshot) as T };
    if (command.type === 'frame') return { ok: true as const, value: __CONNECTION_SCREEN__ as T };
    if (command.type === 'computer.receipt')
      return { ok: false as const, error: 'RUNTIME_UNAVAILABLE' };
    if (command.type === 'control') {
      const screen = snapshot.bots[bot.id];
      if (!screen || command.bot !== bot.id || command.instance !== screen.instance)
        return { ok: false as const, error: 'DESKTOP_VIEW_STALE' };
      screen.owner = command.owner;
      screen.epoch++;
      publish();
      return { ok: true as const, value: {} as T };
    }
    if (command.type === 'computer.action') {
      if (command.request.bot !== bot.id)
        return { ok: false as const, error: 'COMPUTER_BOT_NOT_FOUND' };
      const state = stage(command.request.action === 'connect' ? 'connected' : 'disconnected');
      const value: ComputerAck = {
        state,
        receipt: { id: command.request.id, bot: bot.id, phase: 'settled' },
      };
      return { ok: true as const, value: value as T };
    }
    return { ok: false as const, error: 'SYNTHETIC_PREVIEW_READ_ONLY' };
  },
  subscribe: (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});

function ConnectionPreview() {
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const value = reduce(initialState(), {
      type: 'create',
      id: bot.id,
      name: bot.name,
      role: bot.role,
      color: bot.color,
    });
    if (!Array.isArray(value.attachments[bot.id])) throw new Error('INCOMPLETE_SYNTHETIC_BOT');
    value.messages[bot.id] = [
      {
        id: 'mock-preview-message',
        role: 'bot',
        text: '普通对话和工作区工具随时可用。需要操作电脑时，再连接这位 Bot 的独立屏幕。',
      },
    ];
    value.drafts[bot.id] = '合成草稿，连接和停止电脑时保留';
    return value;
  });
  const [theme, setTheme] = useState('light'),
    [narrow, setNarrow] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main
      style={{
        width: '100%',
        maxWidth: narrow ? 440 : 1200,
        margin: '0 auto',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>Bot 电脑连接验收</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.8 }}>
        合成网页组件状态，不调用模型或原工作区。屏幕为本轮真实 Linux 验收的静态截图，不是实时控制。
      </p>
      <nav
        aria-label="验收显示"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '16px 0' }}
      >
        <button
          type="button"
          className="secondary"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          切换主题
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={narrow}
          onClick={() => setNarrow(!narrow)}
        >
          紧凑宽度
        </button>
        <button type="button" className="secondary" onClick={() => stage('disconnected')}>
          空闲状态
        </button>
        <button type="button" className="secondary" onClick={() => stage('interrupted')}>
          恢复待确认
        </button>
        <button type="button" className="secondary" onClick={() => stage('disconnected', true)}>
          名额已满
        </button>
        <button type="button" className="secondary" onClick={() => stage('connecting')}>
          正在启动
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            stage('connected');
            beginComputer({ id: crypto.randomUUID(), bot: bot.id, action: 'connect', revision: 0 });
          }}
        >
          回执未确认
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            stage('connected');
            snapshot.agents[bot.id] = {
              ...snapshot.bots[bot.id]!.task!,
              running: true,
              phase: 'running',
            };
            publish();
          }}
        >
          任务进行中
        </button>
      </nav>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 520px',
          minHeight: 460,
          border: '1px solid var(--line)',
          borderRadius: 12,
        }}
      >
        <Conversation
          state={state}
          bot={bot}
          dispatch={dispatch}
          notify={setNotice}
          preview={() => {}}
          onModel={() => {}}
          onSend={() => setNotice('合成发送回调，未调用模型。')}
        />
        <aside
          style={{ minWidth: 0, borderInlineStart: narrow ? undefined : '1px solid var(--line)' }}
        >
          <Computer bot={bot} notify={setNotice} />
        </aside>
      </div>
      {notice && <p role="status">{notice}</p>}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('PREVIEW_ROOT_MISSING');
createRoot(root).render(
  <RuntimeProvider>
    <ConnectionPreview />
  </RuntimeProvider>,
);
