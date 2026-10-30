import { disconnected, type RuntimeBridge } from '@daban/protocol';
import { useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Computer } from '../src/Computer';
import { Conversation } from '../src/Conversation';
import { demoState as initialState } from '../src/fixtures';
import { RuntimeProvider } from '../src/Runtime';
import { reduce } from '../src/state';
import '../src/tokens.css';
import '../src/styles.css';

const snapshot = disconnected('ready');
snapshot.protocolVersion = 17;
snapshot.computerError = 'COMPUTER_START_FAILED';
snapshot.bots = {};
snapshot.model = {
  configured: true,
  available: true,
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
};
const bridge: RuntimeBridge = {
  invoke: async <T,>(command: Parameters<RuntimeBridge['invoke']>[0]) =>
    command.type === 'status'
      ? { ok: true as const, value: snapshot as T }
      : { ok: false as const, error: 'SYNTHETIC_PREVIEW_READ_ONLY' },
  subscribe: () => () => {},
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});

function seed() {
  const state = initialState();
  state.messages.research = [
    {
      id: 'mock-headless-response',
      role: 'bot',
      text: '这是合成回复展示。电脑暂不可用时，普通对话和文件任务仍可继续。',
    },
  ];
  state.drafts.research = '合成普通对话';
  return state;
}

function Preview() {
  const [state, dispatch] = useReducer(reduce, undefined, seed),
    [theme, setTheme] = useState('light'),
    [narrow, setNarrow] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const bot = state.bots.find((item) => item.id === 'research')!;
  return (
    <main
      style={{
        maxWidth: narrow ? 520 : 1200,
        width: '100%',
        margin: '0 auto',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>电脑不可用状态验收</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>
        合成网页组件状态。此页不调用模型，不代表原 Electron 已升级。
      </p>
      <nav aria-label="验收显示" style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button
          type="button"
          className="secondary"
          aria-pressed={theme === 'light'}
          onClick={() => setTheme('light')}
        >
          浅色
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme('dark')}
        >
          深色
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={narrow}
          onClick={() => setNarrow(!narrow)}
        >
          紧凑宽度
        </button>
      </nav>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) 360px',
          minHeight: 480,
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
          onSend={() => setNotice('合成发送按钮已触发，未调用模型。')}
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
    <Preview />
  </RuntimeProvider>,
);
