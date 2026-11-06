import {
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { restore, serialize, storageKey } from '../../app/storage';
import { demoState } from '../../test/fixtures';

beforeEach(() => localStorage.setItem(storageKey, serialize(demoState())));
afterEach(() => Reflect.deleteProperty(window, 'daban'));

function connect(
  uncertain = false,
  agent?: RuntimeSnapshot['agent'],
  setup?: RuntimeSnapshot['setup'],
  searchSettings = false,
) {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 39;
  snapshot.agent = agent;
  snapshot.setup = setup;
  if (searchSettings) snapshot.searchSettings = true;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 3,
    connections: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        baseURL: 'https://api.deepseek.com/v1',
        models: [
          {
            id: 'deepseek-flash',
            name: '合成模型',
            vision: true,
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    ],
  };
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  let writes = 0;
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'search.status')
      return {
        ok: true,
        value: {
          revision: 0,
          checkRevision: 0,
          enabled: false,
          provider: 'deepseek',
          credentialConfigured: false,
          credentialSource: 'none',
          health: 'disabled',
        },
      };
    if (command.type === 'model.configure') {
      if (uncertain && ++writes === 1) return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
      snapshot.model.revision = command.input.revision + 1;
      for (const listener of listeners) listener(snapshot);
      return {
        ok: true,
        value: {
          configured: true,
          provider: 'deepseek-official',
          model: command.input.model,
          revision: command.input.revision + 1,
          requestId: command.input.requestId,
        },
      };
    }
    return { ok: true, value: command.type === 'status' ? snapshot : {} };
  });
  const runtime: RuntimeBridge = {
    invoke: async <T,>(command: RuntimeCommand) => (await invoke(command)) as RuntimeReply<T>,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime },
  });
  return invoke;
}

it('opens settings over the current workspace and restores the underlying draft and view on close', async () => {
  render(<App />);
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'synthetic-unsent-draft');
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  expect(within(dialog).getByRole('tablist', { name: '设置分类' })).toBeVisible();
  expect(within(dialog).getByRole('tab', { name: '通用' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(JSON.parse(localStorage.getItem(storageKey)!).state.view).toBe('chat');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('synthetic-unsent-draft');
  await userEvent.click(screen.getByRole('button', { name: '任务' }));
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: '设置' })).getByRole('button', {
      name: '关闭对话框',
    }),
  );
  expect(screen.getByRole('heading', { name: '任务', level: 1 })).toBeVisible();
});

it('keeps an unsaved model key while switching categories but clears it after leaving settings', async () => {
  connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  await userEvent.click(within(dialog).getByRole('tab', { name: '模型与供应商' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '编辑 DeepSeek' }));
  const key = within(dialog).getByLabelText('API Key');
  await userEvent.click(key);
  await userEvent.paste('synthetic-secret-draft');
  await userEvent.click(within(dialog).getByRole('tab', { name: '通用' }));
  expect(key).not.toBeVisible();
  await userEvent.click(within(dialog).getByRole('tab', { name: '模型与供应商' }));
  expect(within(dialog).getByLabelText('API Key')).toHaveValue('synthetic-secret-draft');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-secret-draft');
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  const reopened = screen.getByRole('dialog', { name: '设置' });
  await userEvent.click(within(reopened).getByRole('tab', { name: '模型与供应商' }));
  await userEvent.click(within(reopened).getByRole('button', { name: '编辑 DeepSeek' }));
  expect(within(reopened).getByLabelText('API Key')).toHaveValue('');
});

it('retains the exact pending model write across category changes and retries only on request', async () => {
  const invoke = connect(true);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  await userEvent.click(within(dialog).getByRole('tab', { name: '模型与供应商' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '编辑 DeepSeek' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '验证并保存供应商' }));
  await within(dialog).findByRole('button', { name: '核对并重试保存' });
  await userEvent.click(within(dialog).getByRole('tab', { name: '关于' }));
  await userEvent.click(within(dialog).getByRole('tab', { name: '模型与供应商' }));
  const before = invoke.mock.calls.filter(([command]) => command.type === 'model.configure');
  expect(before).toHaveLength(1);
  await userEvent.click(within(dialog).getByRole('button', { name: '核对并重试保存' }));
  const after = invoke.mock.calls.filter(([command]) => command.type === 'model.configure');
  expect(after).toHaveLength(2);
  expect(after[1][0]).toEqual(after[0][0]);
});

it('returns from a child recovery dialog without discarding another category editor', async () => {
  const invoke = connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '设置' }));
  const settings = await screen.findByRole('dialog', { name: '设置' });
  await userEvent.click(within(settings).getByRole('tab', { name: '模型与供应商' }));
  await userEvent.click(within(settings).getByRole('button', { name: '编辑 DeepSeek' }));
  await userEvent.click(within(settings).getByLabelText('API Key'));
  await userEvent.paste('synthetic-child-draft');
  await userEvent.click(within(settings).getByRole('tab', { name: '电脑与权限' }));
  await userEvent.click(within(settings).getByRole('button', { name: '检查并恢复' }));
  expect(await screen.findByRole('dialog', { name: '恢复整个运行环境' })).toBeVisible();
  expect(settings).not.toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(settings).toBeVisible();
  await userEvent.click(within(settings).getByRole('tab', { name: '模型与供应商' }));
  expect(within(settings).getByLabelText('API Key')).toHaveValue('synthetic-child-draft');
  expect(
    invoke.mock.calls.some(([command]) =>
      ['recovery.prepare', 'model.configure'].includes(command.type),
    ),
  ).toBe(false);
});

it('restores the legacy settings view as a dialog and supports vertical category keyboard navigation', async () => {
  const state = demoState();
  state.view = 'settings';
  localStorage.setItem(storageKey, serialize(state));
  render(<App />);
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  const general = within(dialog).getByRole('tab', { name: '通用' });
  general.focus();
  await userEvent.keyboard('{ArrowDown}');
  expect(within(dialog).getByRole('tab', { name: '模型与供应商' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('heading', { name: '研究员', level: 1 })).toBeVisible();
  expect(JSON.parse(localStorage.getItem(storageKey)!).state.view).toBe('chat');
});

it('preserves unread state beneath a legacy settings cache until the focused conversation is revealed', async () => {
  const state = demoState();
  state.view = 'settings';
  state.organization.attention = { initialized: true, seen: [], unread: ['research'] };
  localStorage.setItem(storageKey, serialize(state));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  render(<App />);
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  expect(restore(localStorage.getItem(storageKey)).organization.attention.unread).toContain(
    'research',
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  expect(restore(localStorage.getItem(storageKey)).organization.attention.unread).not.toContain(
    'research',
  );
});

it('does not clear conversation unread when settings closes in an unfocused window', async () => {
  const state = demoState();
  state.view = 'settings';
  state.organization.attention = { initialized: true, seen: [], unread: ['research'] };
  localStorage.setItem(storageKey, serialize(state));
  const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  render(<App />);
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  expect(restore(localStorage.getItem(storageKey)).organization.attention.unread).toContain(
    'research',
  );
  focused.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(restore(localStorage.getItem(storageKey)).organization.attention.unread).not.toContain(
    'research',
  );
});

it.each(['cancelled', 'downloading'] as const)(
  'controls %s core components from settings without replacing the existing workspace',
  async (phase) => {
    const invoke = connect(false, undefined, {
      required: true,
      target: 'agent',
      phase,
    });
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    await userEvent.click(within(dialog).getByRole('tab', { name: '电脑与权限' }));
    await userEvent.click(
      within(dialog).getByRole('button', {
        name: phase === 'downloading' ? '暂停安装' : '继续安装',
      }),
    );
    expect(invoke).toHaveBeenCalledWith({
      type: phase === 'downloading' ? 'setup.cancel' : 'setup.start',
    });
  },
);

it('explains native-only setup without offering Linux installation or VM recovery', async () => {
  connect(false, {
    location: 'host',
    execution: 'local-workspace',
    privilege: 'workspace',
    approvals: 'host',
  });
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '设置' }));
  const dialog = await screen.findByRole('dialog', { name: '设置' });
  await userEvent.click(within(dialog).getByRole('tab', { name: '电脑与权限' }));
  expect(within(dialog).getByRole('heading', { name: '本机电脑' })).toBeVisible();
  const panel = within(dialog).getByRole('tabpanel', { name: '电脑与权限' });
  expect(
    within(panel).getByText('在 Bot 的电脑面板单独授权桌面操作，无需创建 Linux 虚拟机。'),
  ).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: '检查并恢复' })).toBeNull();
});

it('keeps a search key only while Settings is open and never stops a background task on close', async () => {
  const invoke = connect(false, undefined, undefined, true);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '设置' }));
  const settings = await screen.findByRole('dialog', { name: '设置' });
  await userEvent.click(within(settings).getByRole('tab', { name: '搜索' }));
  const key = await within(settings).findByLabelText('搜索 API Key');
  await userEvent.type(key, 'synthetic-search-draft');
  await userEvent.click(within(settings).getByRole('tab', { name: '通用' }));
  expect(key).not.toBeVisible();
  await userEvent.click(within(settings).getByRole('tab', { name: '搜索' }));
  expect(key).toHaveValue('synthetic-search-draft');
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-search-draft');
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  const reopened = screen.getByRole('dialog', { name: '设置' });
  await userEvent.click(within(reopened).getByRole('tab', { name: '搜索' }));
  expect(await within(reopened).findByLabelText('搜索 API Key')).toHaveValue('');
  expect(
    invoke.mock.calls.some(([command]) =>
      ['search.configure', 'search.check', 'task.stop'].includes(command.type),
    ),
  ).toBe(false);
});
