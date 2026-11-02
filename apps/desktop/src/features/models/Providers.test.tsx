import {
  disconnected,
  type ModelConnection,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeProvider } from '../../app/Runtime';
import { restore, serialize } from '../../app/storage';
import { demoState } from '../../test/fixtures';
import { selectControl, selectOption } from '../../test/select.fixture.ts';
import { Models } from './Models';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

const connection = {
  id: 'synthetic-provider',
  name: '示例供应商',
  baseURL: 'https://models.example.test/v1',
  models: [
    { id: 'model-alpha', name: '示例 Alpha', vision: true, contextWindow: 128000, maxTokens: 8192 },
    { id: 'model-beta', name: '示例 Beta', vision: false, contextWindow: 64000, maxTokens: 4096 },
  ],
};
it('loads a searchable provider list and adds a selected model with matched context without saving', async () => {
  const backend = connect();
  backend.snapshot.model.inspection = true;
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'model.inspect'
      ? {
          ok: true,
          value:
            command.input.kind === 'list'
              ? { kind: 'list', revision: 3, models: [{ id: 'mock-gamma', name: 'Mock Gamma' }] }
              : {
                  kind: 'limits',
                  revision: 3,
                  model: {
                    id: 'mock-gamma',
                    name: 'Mock Gamma',
                    contextWindow: 96000,
                    maxTokens: 8192,
                    source: 'provider',
                    capabilities: { input: ['text', 'image'], toolCall: true, reasoning: true },
                  },
                },
        }
      : invoke(command),
  );
  render(
    <RuntimeProvider>
      <Models />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.click(screen.getByRole('button', { name: '加载模型列表' }));
  await userEvent.click(await screen.findByRole('button', { name: '添加 mock-gamma' }));
  expect(screen.getByLabelText('模型 3 ID')).toHaveValue('mock-gamma');
  expect(screen.getByRole('button', { name: '模型 3 支持图片' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await userEvent.click(screen.getAllByText('上下文与输出上限')[2]);
  expect(screen.getByRole('textbox', { name: '模型 3 上下文窗口' })).toHaveValue('96000');
  expect(backend.writes).toHaveLength(0);
  expect(backend.invoke).toHaveBeenCalledWith({
    type: 'model.inspect',
    input: {
      kind: 'list',
      revision: 3,
      connection: { id: connection.id, baseURL: connection.baseURL },
    },
  });
});
it.each([
  { clicks: 1, input: ['text'], checked: true, before: false },
  { clicks: 2, input: ['text', 'image'], checked: false, before: false },
  { clicks: 1, input: ['text'], checked: true, before: true },
])(
  'preserves a manual image choice after $clicks changes during automatic matching',
  async ({ clicks, input, checked, before }) => {
    const backend = connect();
    backend.snapshot.model.inspection = true;
    let finish: ((reply: RuntimeReply) => unknown) | undefined;
    const reply = new Promise<RuntimeReply>((resolve) => {
      finish = resolve;
    });
    const invoke = backend.invoke.getMockImplementation()!;
    backend.invoke.mockImplementation((command) =>
      command.type === 'model.inspect' ? reply : invoke(command),
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
    await userEvent.clear(screen.getByLabelText('模型 2 ID'));
    await userEvent.type(screen.getByLabelText('模型 2 ID'), 'mock-new');
    const vision = screen.getByRole('button', { name: '模型 2 支持图片' });
    if (before) for (let i = 0; i < clicks; i++) await userEvent.click(vision);
    await vi.waitFor(
      () =>
        expect(backend.invoke).toHaveBeenCalledWith({
          type: 'model.inspect',
          input: {
            kind: 'metadata',
            revision: 3,
            connection: { id: connection.id, baseURL: connection.baseURL },
            model: 'mock-new',
          },
        }),
      { timeout: 2500 },
    );
    if (!before) for (let i = 0; i < clicks; i++) await userEvent.click(vision);
    await act(async () => {
      finish!({
        ok: true,
        value: {
          kind: 'metadata',
          revision: 3,
          model: {
            id: 'mock-new',
            name: 'Mock New',
            source: 'models.dev',
            capabilities: { input, toolCall: false },
          },
        },
      });
      await reply;
    });
    expect(vision).toHaveAttribute('aria-pressed', String(checked));
    expect(backend.writes).toHaveLength(0);
  },
);
it('retries automatic matching after a draft key change and saves the matched capabilities', async () => {
  const backend = connect();
  backend.snapshot.model.inspection = true;
  let finish: ((reply: RuntimeReply) => unknown) | undefined;
  const pending = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  const invoke = backend.invoke.getMockImplementation()!;
  let inspections = 0;
  const metadata = {
    kind: 'metadata',
    revision: 3,
    model: {
      id: 'mock-new',
      name: 'Mock New',
      contextWindow: 96000,
      source: 'models.dev',
      capabilities: { input: ['text', 'image'], toolCall: true },
    },
  };
  backend.invoke.mockImplementation((command) => {
    if (command.type !== 'model.inspect') return invoke(command);
    expect(command.input.apiKey).toBeUndefined();
    return ++inspections === 1 ? pending : Promise.resolve({ ok: true, value: metadata });
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  expect(inspections).toBe(0);
  await userEvent.clear(screen.getByLabelText('模型 2 ID'));
  await userEvent.type(screen.getByLabelText('模型 2 ID'), 'mock-new');
  await vi.waitFor(() => expect(inspections).toBe(1), { timeout: 2500 });
  await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-new-key');
  await act(async () => {
    finish!({ ok: true, value: metadata });
    await pending;
  });
  await vi.waitFor(
    () =>
      expect(screen.getByRole('button', { name: '模型 2 支持图片' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    { timeout: 2500 },
  );
  expect(inspections).toBe(2);
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  const command = backend.writes[0];
  expect(command.type).toBe('model.configure');
  if (command.type === 'model.configure')
    expect(command.input.connection?.models[1]).toMatchObject({
      vision: true,
      contextWindow: 96000,
      capabilities: metadata.model.capabilities,
    });
});
it('tests an individual draft model and reports latency without saving or exposing the key', async () => {
  const backend = connect();
  backend.snapshot.model.inspection = true;
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation(async (command) =>
    command.type === 'model.inspect'
      ? {
          ok: true,
          value: {
            kind: 'test',
            revision: 3,
            model: 'model-beta',
            checkedAt: '2026-01-01T00:00:00.000Z',
            latencyMs: 123,
          },
        }
      : invoke(command),
  );
  render(
    <RuntimeProvider>
      <Models />
    </RuntimeProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.click(screen.getByRole('button', { name: '测试模型 2' }));
  expect(await screen.findByText('调用成功 · 123 ms')).toBeVisible();
  expect(backend.writes).toHaveLength(0);
});
it('discards an in-flight test error after the user changes the model ID', async () => {
  const backend = connect();
  backend.snapshot.model.inspection = true;
  let finish: ((reply: RuntimeReply) => unknown) | undefined;
  const reply = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'model.inspect' ? reply : invoke(command),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.click(screen.getByRole('button', { name: '测试模型 2' }));
  await userEvent.clear(screen.getByLabelText('模型 2 ID'));
  await userEvent.type(screen.getByLabelText('模型 2 ID'), 'mock-new');
  await act(async () => {
    finish!({ ok: false, error: 'MODEL_API_UNAUTHORIZED' });
    await reply;
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('preserves a manual context edit made while automatic matching is in flight', async () => {
  const backend = connect();
  backend.snapshot.model.inspection = true;
  let finish: ((reply: RuntimeReply) => unknown) | undefined;
  const reply = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'model.inspect' ? reply : invoke(command),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.click(screen.getByRole('button', { name: '匹配模型 2 能力' }));
  await userEvent.click(screen.getAllByText('上下文与输出上限')[1]);
  const context = screen.getByRole('textbox', { name: '模型 2 上下文窗口' });
  await userEvent.clear(context);
  await userEvent.type(context, '32000');
  await act(async () => {
    finish!({
      ok: true,
      value: {
        kind: 'limits',
        revision: 3,
        model: { id: 'model-beta', name: 'Mock Beta', contextWindow: 96000, source: 'provider' },
      },
    });
    await reply;
  });
  expect(context).toHaveValue('32000');
});
it('does not let late matching modify a frozen configuration whose save result is uncertain', async () => {
  const backend = connect(true);
  backend.snapshot.model.inspection = true;
  let finish: ((reply: RuntimeReply) => unknown) | undefined;
  const reply = new Promise<RuntimeReply>((resolve) => {
    finish = resolve;
  });
  const invoke = backend.invoke.getMockImplementation()!;
  backend.invoke.mockImplementation((command) =>
    command.type === 'model.inspect' ? reply : invoke(command),
  );
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.click(screen.getAllByText('上下文与输出上限')[1]);
  await userEvent.click(screen.getByRole('button', { name: '匹配模型 2 能力' }));
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  await screen.findByText('保存结果未确认。重试会核对同一次操作，不会改用其他密钥或模型。');
  await act(async () => {
    finish!({
      ok: true,
      value: {
        kind: 'limits',
        revision: 3,
        model: { id: 'model-beta', name: 'Mock Beta', contextWindow: 96000, source: 'provider' },
      },
    });
    await reply;
  });
  expect(screen.getByRole('textbox', { name: '模型 2 上下文窗口' })).toHaveValue('64000');
});
function connect(
  failFirst: boolean | string = false,
  saved: ModelConnection = connection,
  model = 'model-alpha',
) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 39;
  snapshot.model = {
    configured: true,
    available: true,
    provider: saved.id,
    model: `provider:${saved.id}:${model}`,
    revision: 3,
    ...{ connections: [saved] },
  };
  const readySnapshot = structuredClone(snapshot);
  const writes: RuntimeCommand[] = [];
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'model.configure') {
      writes.push(command);
      if (failFirst && writes.length === 1) {
        if (failFirst === 'MODEL_SETTINGS_CONFLICT') {
          snapshot = { ...snapshot, model: { ...snapshot.model, revision: 4 } };
          for (const listener of listeners) listener(snapshot);
        }
        return {
          ok: false,
          error: typeof failFirst === 'string' ? failFirst : 'RUNTIME_UNAVAILABLE',
        };
      }
      snapshot.model = { ...snapshot.model, model: command.input.model, revision: 4 };
      for (const listener of listeners) listener(snapshot);
      return { ok: true, value: { ...snapshot.model, requestId: command.input.requestId } };
    }
    return { ok: true, value: snapshot };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      runtime: {
        invoke,
        subscribe: (listener: (snapshot: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as RuntimeBridge,
    },
  });
  return {
    snapshot,
    invoke,
    writes,
    disconnect() {
      snapshot = disconnected('offline');
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
    reconnect(withCatalog = true) {
      snapshot = structuredClone(readySnapshot);
      if (!withCatalog) delete snapshot.model.connections;
      act(() => {
        for (const listener of listeners) listener(snapshot);
      });
    },
  };
}
function mount() {
  return render(
    <RuntimeProvider>
      <Models />
    </RuntimeProvider>,
  );
}

it.each([
  ['claude', 'https://api.anthropic.com', 'anthropic-messages', 'Claude Messages'],
  [
    'gemini',
    'https://generativelanguage.googleapis.com/v1beta',
    'google-generative-ai',
    'Gemini GenerateContent',
  ],
  ['openai', 'https://api.openai.com/v1', 'openai-responses', 'OpenAI Responses'],
])(
  'uses the native %s preset and submits its actual protocol',
  async (preset, baseURL, api, label) => {
    const { writes } = connect();
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '添加供应商' }));
    await selectOption(userEvent, selectControl('供应商类型'), preset);
    expect(screen.getByLabelText('API 地址')).toHaveValue(baseURL);
    expect(selectControl('接口协议')).toHaveTextContent(label);
    await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-native-provider-key');
    await userEvent.type(screen.getByLabelText('模型 1 ID'), 'synthetic-native-model');
    await userEvent.click(screen.getByLabelText('将首个模型设为工作区默认模型'));
    await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
    expect(writes[0]).toMatchObject({
      type: 'model.configure',
      input: { connection: { baseURL, api } },
    });
  },
);

it('offers mainstream platform presets with explicit protocols instead of placeholder providers', async () => {
  connect();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '添加供应商' }));
  await userEvent.click(selectControl('供应商类型'));
  const text = screen.getByRole('listbox').textContent;
  for (const name of [
    'OpenAI',
    'Claude',
    'Gemini',
    'Grok',
    'DeepSeek',
    '千问',
    'Kimi',
    '智谱',
    'MiniMax',
    '豆包',
    '硅基流动',
    'OpenRouter',
    '腾讯混元',
    '百度千帆',
    'Groq',
    'Together',
  ])
    expect(text).toContain(name);
});

it('uses endpoint identity for vendor icons in provider rows and model choices, never an editable name', async () => {
  connect(false, {
    ...connection,
    name: '任意连接名称',
    baseURL: 'https://api.anthropic.com',
    api: 'anthropic-messages',
  });
  const view = mount();
  await screen.findByRole('button', { name: '编辑 任意连接名称' });
  expect(
    view.container.querySelector('.provider-row [data-provider="claude"] img'),
  ).toBeInTheDocument();
  expect(
    selectControl('工作区默认模型').querySelector('[data-provider="claude"] img'),
  ).toBeInTheDocument();
});

it.each(['https://model.example.test/v1', 'https://api.anthropic.com/proxy'])(
  'keeps a custom endpoint generic even when its name claims a vendor: %s',
  async (baseURL) => {
    connect(false, { ...connection, name: 'Claude', baseURL, api: 'anthropic-messages' });
    const view = mount();
    await screen.findByRole('button', { name: '编辑 Claude' });
    expect(
      view.container.querySelector('.provider-row [data-provider="custom"]'),
    ).toBeInTheDocument();
    expect(
      view.container.querySelector('.provider-row [data-provider="claude"]'),
    ).not.toBeInTheDocument();
  },
);

it('requires a fresh key when changing a saved connection protocol and preserves missing legacy api metadata', async () => {
  const { writes } = connect();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await selectOption(userEvent, selectControl('接口协议'), 'anthropic-messages');
  expect(screen.getByLabelText('API Key')).toBeRequired();
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  expect(writes).toHaveLength(0);
  await selectOption(userEvent, selectControl('接口协议'), 'openai-completions');
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toHaveProperty('input.connection.api');
});

it('lists configured suppliers and changes the workspace default without copying a key', async () => {
  const { writes } = connect();
  mount();
  expect(await screen.findByText('示例供应商')).toBeVisible();
  await selectOption(
    userEvent,
    selectControl('工作区默认模型'),
    'provider:synthetic-provider:model-beta',
  );
  await userEvent.click(screen.getByRole('button', { name: '保存默认模型' }));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    type: 'model.configure',
    input: { model: 'provider:synthetic-provider:model-beta', revision: 3 },
  });
  expect(writes[0]).not.toHaveProperty('input.apiKey');
  expect(writes[0]).not.toHaveProperty('input.connection');
});

it('adds multiple models and keeps exact ambiguous-save retries and secret input out of storage', async () => {
  const { writes } = connect(true);
  const view = mount();
  await userEvent.click(await screen.findByRole('button', { name: '添加供应商' }));
  await userEvent.type(screen.getByLabelText('供应商名称'), '第二供应商');
  await userEvent.type(screen.getByLabelText('API 地址'), 'https://second.example.test/v1');
  await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-second-provider-key');
  await userEvent.click(screen.getByLabelText('将首个模型设为工作区默认模型'));
  await userEvent.type(screen.getByLabelText('模型 1 ID'), 'model-one');
  await userEvent.type(screen.getByLabelText('模型 1 名称'), '模型一');
  await userEvent.click(screen.getByLabelText('模型 1 支持图片'));
  await userEvent.click(screen.getByRole('button', { name: '添加模型' }));
  await userEvent.type(screen.getByLabelText('模型 2 ID'), 'model-two');
  await userEvent.type(screen.getByLabelText('模型 2 名称'), '模型二');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-second-provider-key');
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  await userEvent.click(await screen.findByRole('button', { name: '核对并重试保存' }));
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toMatchObject({
    type: 'model.configure',
    input: {
      connection: {
        name: '第二供应商',
        baseURL: 'https://second.example.test/v1',
        models: [
          { id: 'model-one', name: '模型一', vision: true },
          { id: 'model-two', name: '模型二', vision: false },
        ],
      },
      apiKey: 'synthetic-second-provider-key',
    },
  });
  if (writes[0].type === 'model.configure') {
    expect(writes[0].input.model).toBe(`provider:${writes[0].input.connection!.id}:model-one`);
  }
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
  view.unmount();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '添加供应商' }));
  expect(screen.getByLabelText('API Key')).toHaveValue('');
});

it('requires a fresh key when editing an existing provider endpoint', async () => {
  const { writes } = connect();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  expect(screen.getByLabelText('API Key')).toHaveValue('');
  await userEvent.clear(screen.getByLabelText('API 地址'));
  await userEvent.type(screen.getByLabelText('API 地址'), 'https://changed.example.test/v1');
  expect(screen.getByLabelText('API Key')).toBeRequired();
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  expect(writes).toHaveLength(0);
});

it('keeps the reserved official DeepSeek endpoint fixed while allowing model and key edits', async () => {
  connect(false, {
    ...connection,
    id: 'deepseek-official',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 DeepSeek' }));
  expect(screen.getByLabelText('API 地址')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: '供应商类型' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('供应商名称')).not.toHaveAttribute('readonly');
  expect(screen.getByLabelText('模型 1 ID')).not.toHaveAttribute('readonly');
  expect(screen.getByLabelText('API Key')).toBeEnabled();
});

it('does not change the intent after a storage failure with an unknown save outcome', async () => {
  const { writes } = connect('MODEL_CONFIG_UNAVAILABLE');
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  await userEvent.click(await screen.findByRole('button', { name: '核对并重试保存' }));
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it('keeps supplier key drafts and pending intent through offline or catalog-missing snapshots', async () => {
  const backend = connect(true);
  const view = mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  await userEvent.type(screen.getByLabelText('API Key'), 'synthetic-pending-key');
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  await screen.findByRole('button', { name: '核对并重试保存' });
  backend.disconnect();
  expect(screen.getByLabelText('API Key')).toHaveValue('synthetic-pending-key');
  expect(screen.getByRole('button', { name: '核对并重试保存' })).toBeDisabled();
  backend.reconnect(false);
  expect(screen.getByLabelText('API Key')).toHaveValue('synthetic-pending-key');
  expect(screen.getByRole('button', { name: '核对并重试保存' })).toBeDisabled();
  backend.reconnect();
  await userEvent.click(screen.getByRole('button', { name: '核对并重试保存' }));
  expect(backend.writes).toHaveLength(2);
  expect(backend.writes[1]).toEqual(backend.writes[0]);
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-pending-key');
  view.unmount();
  mount();
  await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
  expect(screen.getByLabelText('API Key')).toHaveValue('');
});

it.each(['MODEL_UNAVAILABLE', 'MODEL_CREDENTIAL_REQUIRED'])(
  'keeps the editor repairable after the definitive %s decision',
  async (code) => {
    const { writes } = connect(code);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
    await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByLabelText('模型 1 ID')).toBeEnabled();
    expect(screen.getByLabelText('API Key')).toBeEnabled();
    expect(writes).toHaveLength(1);
  },
);

it.each([
  { action: 'rename', index: 2, model: 'model-beta', replacement: 'model-alpha' },
  { action: 'remove', index: 2, model: 'model-beta', replacement: 'model-alpha' },
  { action: 'rename', index: 1, model: 'model-alpha', replacement: 'renamed-model' },
  { action: 'remove', index: 1, model: 'model-alpha', replacement: 'model-beta' },
])(
  'requires an explicit replacement before saving a $action of default model $index',
  async ({ action, index, model, replacement }) => {
    const { writes } = connect(false, connection, model);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '编辑 示例供应商' }));
    if (action === 'rename') {
      await userEvent.clear(screen.getByLabelText(`模型 ${index} ID`));
      await userEvent.type(screen.getByLabelText(`模型 ${index} ID`), 'renamed-model');
    } else await userEvent.click(screen.getByRole('button', { name: `移除模型 ${index}` }));
    await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
    expect(writes).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('默认模型');
    expect(screen.getByLabelText('模型 1 ID')).toBeEnabled();
    await userEvent.click(screen.getByLabelText('将首个模型设为工作区默认模型'));
    await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      input: { model: `provider:synthetic-provider:${replacement}` },
    });
  },
);

it('requires explicit review before rebasing a conflicting workspace-default edit', async () => {
  const { writes } = connect('MODEL_SETTINGS_CONFLICT');
  mount();
  await screen.findByText('示例供应商');
  await selectOption(
    userEvent,
    selectControl('工作区默认模型'),
    'provider:synthetic-provider:model-beta',
  );
  await userEvent.click(screen.getByRole('button', { name: '保存默认模型' }));
  await userEvent.click(await screen.findByRole('button', { name: '保留输入，按当前版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '保存默认模型' }));
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ input: { revision: 3 } });
  expect(writes[1]).toMatchObject({
    input: { revision: 4, model: 'provider:synthetic-provider:model-beta' },
  });
});

it('retains a configured model route when reopening a workspace without the provider catalog', () => {
  const state = demoState();
  Object.assign(state.bots[0], { model: 'provider:synthetic-provider:model-alpha' });
  const reopened = restore(serialize(state));
  expect(reopened.bots[0].model).toBe('provider:synthetic-provider:model-alpha');
});
