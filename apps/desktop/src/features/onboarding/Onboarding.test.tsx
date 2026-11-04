import {
  disconnected,
  managedProtocol,
  type RemoteBridge,
  type RemoteState,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { initialState, reduce } from '../../app/state';
import { serialize, storageKey } from '../../app/storage';
import { selectControl, selectOption } from '../../test/select.fixture.ts';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function snapshot(configured = false) {
  const value = disconnected('ready');
  value.protocolVersion = managedProtocol;
  value.setup = { required: false, phase: 'existing' };
  value.model = {
    configured,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 0,
    connections: [],
    inspection: true,
  };
  return value;
}
function connect(
  initial: RuntimeSnapshot,
  save?: (command: Extract<RuntimeCommand, { type: 'model.configure' }>) => Promise<unknown>,
  hold = false,
) {
  let current = initial;
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const writes: RuntimeCommand[] = [];
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'status' && hold) return new Promise(() => {});
    if (command.type === 'model.configure') {
      writes.push(structuredClone(command));
      try {
        return {
          ok: true,
          value: save
            ? await save(command)
            : {
                configured: true,
                model: command.input.model,
                provider: command.input.connection?.id,
                revision: command.input.revision + 1,
                requestId: command.input.requestId,
              },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE' };
      }
    }
    return { ok: true, value: current };
  });
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      return (await invoke(command)) as RuntimeReply<T>;
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
  return {
    invoke,
    writes,
    publish(value: RuntimeSnapshot) {
      current = value;
      act(() => {
        for (const listener of listeners) listener(structuredClone(value));
      });
    },
  };
}
async function fill() {
  await screen.findByRole('heading', { name: '连接你的第一个模型' });
  await userEvent.type(screen.getByLabelText('API Key'), 'SYNTHETIC-ONBOARDING-KEY');
  await userEvent.type(screen.getByLabelText('模型 1 ID'), 'mock-chat');
}
it('waits for authoritative startup status instead of flashing an unusable workspace', () => {
  connect(snapshot(), undefined, true);
  render(<App />);
  expect(screen.getByRole('heading', { name: '正在连接本机工作区' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '自定义 Bot' })).not.toBeInTheDocument();
});
it('opens a previously configured empty workspace immediately on the next launch', async () => {
  connect(snapshot(true));
  const first = render(<App />);
  await screen.findByRole('button', { name: '自定义 Bot' });
  first.unmount();
  const backend = connect(disconnected('connecting'), undefined, true);
  render(<App />);
  expect(screen.getByRole('button', { name: '自定义 Bot' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '正在连接本机工作区' })).not.toBeInTheDocument();
  expect(backend.writes).toHaveLength(0);
});

it('restores an existing workspace before connection and keeps draft submission gated on readiness', async () => {
  const state = reduce(initialState(), {
    type: 'create',
    id: 'mock-returning-bot',
    name: 'SYNTHETIC RETURNING BOT',
    role: '',
    color: 'mint',
  });
  state.drafts['mock-returning-bot'] = 'SYNTHETIC UNSENT DRAFT';
  state.messages['mock-returning-bot'] = [
    { id: 'mock-cached-message', role: 'bot', text: 'SYNTHETIC CACHED REPLY' },
  ];
  localStorage.setItem(storageKey, serialize(state));
  const backend = connect(disconnected('connecting'), undefined, true);
  render(<App />);
  expect(screen.getByRole('heading', { name: 'SYNTHETIC RETURNING BOT' })).toBeVisible();
  expect(screen.getByText('SYNTHETIC CACHED REPLY')).toBeVisible();
  const draft = screen.getByRole('textbox', { name: '发送消息' });
  expect(draft).toHaveValue('SYNTHETIC UNSENT DRAFT');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.queryByText('可对话 · 未连接电脑')).not.toBeInTheDocument();
  await userEvent.type(draft, '{Enter}');
  expect(backend.invoke).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'task.start' }));
  expect(draft).toHaveValue('SYNTHETIC UNSENT DRAFT');
  backend.publish(disconnected('offline'));
  expect(screen.getByRole('heading', { name: 'SYNTHETIC RETURNING BOT' })).toBeVisible();
  expect(draft).toHaveValue('SYNTHETIC UNSENT DRAFT');
});

it('does not treat an offline preview as completed first-use setup', async () => {
  const preview = render(<App />);
  await screen.findByRole('button', { name: '自定义 Bot' });
  preview.unmount();
  connect(disconnected('connecting'), undefined, true);
  render(<App />);
  expect(screen.getByRole('heading', { name: '正在连接本机工作区' })).toBeVisible();
});
it('shows Linux startup downloads while connecting and replaces them with failure recovery', async () => {
  const value = disconnected('connecting');
  value.setup = {
    required: true,
    target: 'linux',
    phase: 'downloading',
    progress: 25,
    downloaded: 25,
    total: 100,
  };
  const backend = connect(value);
  render(<App />);
  expect(await screen.findByRole('progressbar', { name: '下载进度' })).toHaveAttribute(
    'aria-valuenow',
    '25',
  );
  expect(screen.getByRole('status')).toHaveTextContent('正在下载 Linux 运行组件');
  expect(backend.invoke).not.toHaveBeenCalledWith({ type: 'setup.start' });
  const failed = disconnected('offline');
  failed.setup = { required: true, target: 'linux', phase: 'failed', error: 'AGENT_START_FAILED' };
  backend.publish(failed);
  expect(await screen.findByRole('button', { name: '重新连接' })).toBeEnabled();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});
it('keeps legacy runtimes without model setup support in their existing workspace flow', async () => {
  const value = snapshot();
  value.protocolVersion = 12;
  connect(value);
  render(<App />);
  expect(await screen.findByRole('button', { name: '自定义 Bot' })).toBeVisible();
});
it('allows offline workspace recovery without pretending a model has been configured', async () => {
  const backend = connect(disconnected('offline'));
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '离线查看工作区' }));
  expect(await screen.findByRole('button', { name: '自定义 Bot' })).toBeVisible();
  expect(backend.writes).toHaveLength(0);
});
it('finishes environment setup before opening the first model connection form', async () => {
  const value = snapshot();
  value.setup = { required: true, phase: 'available' };
  const backend = connect(value);
  render(<App />);
  expect(await screen.findByRole('heading', { name: '给 Bot 一个本地工作空间' })).toBeVisible();
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
  backend.publish(snapshot());
  expect(await screen.findByRole('heading', { name: '连接你的第一个模型' })).toBeVisible();
  expect(screen.getByLabelText('API Key')).toBeVisible();
});
it('offers model configuration and chat without installing an optional Linux environment', async () => {
  const value = snapshot();
  value.setup = { required: true, target: 'linux', phase: 'available' };
  const backend = connect(value);
  render(<App />);
  await fill();
  expect(screen.queryByRole('button', { name: '创建本地环境' })).not.toBeInTheDocument();
  expect(backend.invoke).not.toHaveBeenCalledWith({ type: 'setup.start' });
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  await userEvent.click(await screen.findByRole('button', { name: '开始使用' }));
  expect(await screen.findByRole('button', { name: '自定义 Bot' })).toBeVisible();
  expect(backend.invoke).not.toHaveBeenCalledWith({ type: 'setup.start' });
});
it('requires an acknowledged model save and an explicit Start before entering the workspace', async () => {
  const backend = connect(snapshot());
  render(<App />);
  await fill();
  expect(screen.queryByRole('button', { name: '开始使用' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  expect(await screen.findByText('模型配置已保存')).toBeVisible();
  expect(backend.writes).toHaveLength(1);
  expect(JSON.stringify(localStorage)).not.toContain('SYNTHETIC-ONBOARDING-KEY');
  await userEvent.click(screen.getByRole('button', { name: '开始使用' }));
  expect(await screen.findByRole('button', { name: '自定义 Bot' })).toBeVisible();
});
it('keeps the first form focused on provider, key and model while connection details remain available', async () => {
  connect(snapshot());
  render(<App />);
  await screen.findByRole('heading', { name: '连接你的第一个模型' });
  expect(screen.queryByLabelText('API 地址')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '连接设置（可选）' }));
  expect(screen.getByLabelText('API 地址')).toHaveValue('https://api.deepseek.com/v1');
});
it('does not carry a first-provider credential or model into a different supplier', async () => {
  const backend = connect(snapshot());
  render(<App />);
  await fill();
  await selectOption(userEvent, selectControl('供应商类型'), 'claude');
  expect(screen.getByLabelText('API Key')).toHaveValue('');
  expect(screen.getByLabelText('模型 1 ID')).toHaveValue('');
  expect(backend.writes).toHaveLength(0);
});
it('keeps failed configuration in the guide with the entered key and recovery action', async () => {
  connect(snapshot(), async () => {
    throw Error('MODEL_API_UNAUTHORIZED');
  });
  render(<App />);
  await fill();
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('供应商拒绝了这个密钥');
  expect(screen.getByLabelText('API Key')).toHaveValue('SYNTHETIC-ONBOARDING-KEY');
  expect(screen.queryByRole('button', { name: '开始使用' })).not.toBeInTheDocument();
});
it('retains the exact uncertain intent even when status reports configured before the save reply', async () => {
  let attempts = 0;
  const backend = connect(snapshot(), async (command) => {
    if (++attempts === 1) {
      backend.publish({ ...snapshot(true), model: { ...snapshot(true).model, revision: 1 } });
      throw Error('RUNTIME_UNAVAILABLE');
    }
    return {
      configured: true,
      model: command.input.model,
      revision: 1,
      requestId: command.input.requestId,
    };
  });
  render(<App />);
  await fill();
  await userEvent.click(screen.getByRole('button', { name: '验证并保存供应商' }));
  expect(await screen.findByRole('button', { name: '核对并重试保存' })).toBeVisible();
  expect(screen.getByLabelText('API Key')).toHaveValue('SYNTHETIC-ONBOARDING-KEY');
  expect(screen.queryByRole('button', { name: '开始使用' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '核对并重试保存' }));
  expect(await screen.findByRole('button', { name: '开始使用' })).toBeVisible();
  expect(backend.writes[1]).toEqual(backend.writes[0]);
});
it('retains a first-model secret draft through a transient disconnection', async () => {
  const backend = connect(snapshot());
  render(<App />);
  await fill();
  backend.publish(disconnected('offline'));
  expect(screen.getByLabelText('API Key')).toHaveValue('SYNTHETIC-ONBOARDING-KEY');
  backend.publish(snapshot());
  expect(screen.getByLabelText('API Key')).toHaveValue('SYNTHETIC-ONBOARDING-KEY');
});
it('bypasses onboarding for configured users and does not remount their workspace on disconnect', async () => {
  const backend = connect(snapshot(true));
  render(<App />);
  await screen.findByRole('button', { name: '自定义 Bot' });
  backend.publish(disconnected('offline'));
  expect(screen.getByRole('button', { name: '自定义 Bot' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: '连接你的第一个模型' })).not.toBeInTheDocument();
});

it('offers remote connection before configuring a local model', async () => {
  const local = connect(snapshot());
  const state: RemoteState = {
    selected: null,
    identity: { id: 'a'.repeat(64), publicKey: 'A'.repeat(59), name: 'Synthetic controller' },
    hosting: false,
    server: '',
    hosts: [],
    pending: [],
  };
  const remote: RemoteBridge = { invoke: async () => state, subscribe: () => () => {} };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { ...window.daban, remote },
  });
  render(<App />);
  await screen.findByRole('heading', { name: '连接你的第一个模型' });
  await userEvent.click(await screen.findByRole('button', { name: '连接另一台电脑' }));
  expect(screen.getByRole('dialog', { name: '远程电脑' })).toBeVisible();
  expect(local.writes).toHaveLength(0);
});
