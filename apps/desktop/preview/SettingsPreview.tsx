import {
  disconnected,
  modelCatalog,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { useEffect, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Brand } from '../src/Avatar';
import { demoState } from '../src/fixtures';
import { RuntimeProvider } from '../src/Runtime';
import { Settings } from '../src/Settings';
import { reduce } from '../src/state';
import '../src/tokens.css';
import '../src/styles.css';

// Isolated production-component preview: no localStorage, real account, API or VM is connected.
let snapshot = disconnected('ready');
snapshot.protocolVersion = 39;
snapshot.agent = { location: 'host', execution: 'linux-vm', privilege: 'sudo', approvals: 'host' };
snapshot.model = {
  available: true,
  configured: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  revision: 0,
  connections: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      models: [
        {
          id: 'deepseek-flash',
          name: '示例默认模型',
          vision: true,
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    },
    {
      id: 'mock-claude',
      name: 'Claude',
      baseURL: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      models: [
        {
          id: 'mock-claude',
          name: '示例 Claude 模型',
          vision: true,
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    },
    {
      id: 'mock-gemini',
      name: 'Gemini',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      api: 'google-generative-ai',
      models: [
        {
          id: 'mock-gemini',
          name: '示例 Gemini 模型',
          vision: true,
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    },
  ],
};
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand) {
    let value: unknown = snapshot;
    if (command.type === 'model.configure') {
      if (snapshot.model.revision !== command.input.revision)
        return { ok: false, error: 'MODEL_SETTINGS_CONFLICT' };
      const input = command.input;
      const connections = snapshot.model.connections || [];
      const existing =
        input.connection && connections.some((entry) => entry.id === input.connection!.id);
      const updated = input.connection
        ? existing
          ? connections.map((entry) =>
              entry.id === input.connection!.id ? input.connection! : entry,
            )
          : [...connections, input.connection]
        : connections;
      snapshot = {
        ...snapshot,
        model: {
          ...snapshot.model,
          connections: updated,
          model: input.model,
          provider:
            modelCatalog(updated).find((entry) => entry.id === input.model)?.provider ||
            snapshot.model.provider,
          revision: input.revision + 1,
        },
      };
      for (const listener of listeners) listener(snapshot);
      value = {
        configured: true,
        model: input.model,
        provider: snapshot.model.provider,
        revision: input.revision + 1,
        requestId: input.requestId,
      };
    } else if (command.type === 'model.check')
      value = {
        model: snapshot.model.model,
        revision: command.revision,
        checkedAt: new Date().toISOString(),
      };
    else if (command.type !== 'status' && command.type !== 'connect')
      return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
    return { ok: true, value: value as T };
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
function Preview() {
  const [state, dispatch] = useReducer(reduce, undefined, () => ({
    ...demoState(),
    theme:
      new URLSearchParams(location.search).get('theme') === 'dark'
        ? ('dark' as const)
        : ('light' as const),
  }));
  const [open, setOpen] = useState(true);
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);
  return (
    <RuntimeProvider>
      <main className="settings-preview-canvas">
        <header>
          <Brand />
          <strong>Daban</strong>
        </header>
        <h1>设置弹窗预览</h1>
        <p>独立合成预览，不连接真实账户、工作区或模型 API。</p>
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          打开设置
        </button>
      </main>
      {open && <Settings state={state} dispatch={dispatch} onClose={() => setOpen(false)} />}
    </RuntimeProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
