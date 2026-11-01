import {
  disconnected,
  isModelUpdate,
  type ModelConnection,
  managedProtocol,
  modelCatalog,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';

const catalog: ModelConnection[] = [
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
export function modelConnections() {
  return structuredClone(catalog);
}
export function modelPreview(empty = false) {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = managedProtocol;
  snapshot.model = {
    inspection: true,
    configured: !empty,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 0,
    connections: empty ? [] : modelConnections(),
  };
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      let value: unknown = snapshot;
      if (command.type === 'model.inspect') {
        const input = command.input;
        if (input.revision !== snapshot.model.revision)
          return { ok: false, error: 'MODEL_SETTINGS_CONFLICT' };
        const models = [
          {
            id: 'mock-chat-standard',
            name: '示例对话模型',
            contextWindow: 64000,
            maxTokens: 4096,
            source: 'provider' as const,
          },
          { id: 'mock-chat-long', name: '示例长上下文模型' },
        ];
        value =
          input.kind === 'list'
            ? { kind: 'list', revision: input.revision, models }
            : input.kind === 'test'
              ? {
                  kind: 'test',
                  revision: input.revision,
                  model: input.model,
                  latencyMs: 186,
                  checkedAt: '2026-01-01T00:00:00.000Z',
                }
              : {
                  kind: 'limits',
                  revision: input.revision,
                  model: {
                    id: input.model,
                    name: input.model,
                    contextWindow: 256000,
                    maxTokens: 8192,
                    source: 'models.dev',
                  },
                };
      } else if (command.type === 'model.configure') {
        const input = command.input;
        if (!isModelUpdate(input)) return { ok: false, error: 'INVALID_MODEL_SETTINGS' };
        if (input.revision !== snapshot.model.revision)
          return { ok: false, error: 'MODEL_SETTINGS_CONFLICT' };
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
        const selected = modelCatalog(updated).find((entry) => entry.id === input.model);
        if (!selected) return { ok: false, error: 'INVALID_MODEL_SETTINGS' };
        // Public connection metadata is retained; an entered synthetic key is deliberately never copied.
        snapshot.model = {
          ...snapshot.model,
          configured: true,
          connections: structuredClone(updated),
          model: input.model,
          provider: selected.provider,
          revision: input.revision + 1,
        };
        for (const listener of listeners) listener(structuredClone(snapshot));
        value = {
          configured: true,
          model: input.model,
          provider: selected.provider,
          revision: snapshot.model.revision,
          requestId: input.requestId,
        };
      } else if (command.type === 'model.check') {
        value = {
          model: snapshot.model.model,
          revision: command.revision,
          checkedAt: new Date().toISOString(),
        };
      } else if (command.type !== 'status' && command.type !== 'connect')
        return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
      return { ok: true, value: structuredClone(value) as T };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { snapshot, bridge };
}
