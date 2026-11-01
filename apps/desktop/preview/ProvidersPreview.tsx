import {
  disconnected,
  type ModelConnection,
  modelCatalog,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { Models } from '../src/Models';
import { RuntimeProvider } from '../src/Runtime';
import '../src/tokens.css';
import '../src/styles.css';

// Synthetic UI only: no real account, API, VM or workspace storage is connected.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const connections: ModelConnection[] =
  query.get('empty') === '1'
    ? []
    : [
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
              id: 'mock-claude-model',
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
              id: 'mock-gemini-model',
              name: '示例 Gemini 模型',
              vision: true,
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      ];
let snapshot = disconnected('ready');
snapshot.protocolVersion = 39;
snapshot.model = {
  configured: !!connections.length,
  available: true,
  revision: 0,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  connections,
};
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand) {
    let value: unknown = snapshot;
    if (command.type === 'model.configure') {
      const input = command.input;
      if (input.revision !== snapshot.model.revision)
        return { ok: false, error: 'MODEL_SETTINGS_CONFLICT' };
      const updated = input.connection
        ? [
            ...(snapshot.model.connections || []).filter(
              (item) => item.id !== input.connection!.id,
            ),
            input.connection,
          ]
        : snapshot.model.connections || [];
      snapshot = {
        ...snapshot,
        model: {
          ...snapshot.model,
          configured: true,
          model: input.model,
          provider:
            modelCatalog(updated).find((entry) => entry.id === input.model)?.provider ||
            snapshot.model.provider,
          connections: updated,
          revision: input.revision + 1,
        },
      };
      for (const listener of listeners) listener(snapshot);
      value = {
        configured: true,
        provider: snapshot.model.provider,
        model: input.model,
        revision: input.revision + 1,
        requestId: input.requestId,
      };
    } else if (command.type === 'model.check') {
      value = {
        model: snapshot.model.model,
        revision: command.revision,
        checkedAt: new Date().toISOString(),
      };
    } else if (command.type !== 'status') return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
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
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider>
    <main className="full-page" aria-label="供应商配置预览">
      <div className="page-inner">
        <h1 className="page-heading">模型与供应商</h1>
        <p className="page-subtitle">合成界面预览 · 不会连接真实模型服务</p>
        <section className="settings-section">
          <Models />
        </section>
      </div>
    </main>
  </RuntimeProvider>,
);
