import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from '../test/fixtures';
import { appAction, workspaceTab } from '../test/navigation.fixture';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  type BotProfile,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

// UI fixtures and user inputs are synthetic; the renderer never calls a model API.
describe('daban client', () => {
  it('synchronizes the Windows native titlebar with the restored and selected app theme', async () => {
    const state = seedDemoState();
    state.theme = 'dark';
    localStorage.setItem(seedStorageKey, seedSerialize(state));
    const setTheme = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'daban', {
      configurable: true,
      value: { platform: 'win32', titlebar: { setTheme } },
    });
    render(<App />);
    await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith('dark'));
    await appAction(userEvent, '切换浅色主题');
    await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('shows the conversation workspace and filters Bot navigation', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '研究员' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索 Bot 和对话' }), '写作');
    expect(within(nav).getByRole('button', { name: '写作搭档' })).toBeVisible();
    expect(within(nav).queryByRole('button', { name: '研究员' })).not.toBeInTheDocument();
  });
  it('keeps drafts when switching Bots and labels the response as demonstration', async () => {
    render(<App />);
    await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '这是一条合成测试消息');
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
        name: '写作搭档',
      }),
    );
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
        name: '研究员',
      }),
    );
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('这是一条合成测试消息');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(
      within(screen.getByRole('log', { name: '对话记录' })).getByText('这是一条合成测试消息'),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
    expect(screen.getAllByText(/尚未连接模型/).length).toBeGreaterThan(0);
  });
  it('creates a Bot and validates its required name', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '新建 Bot' }));
    const dialog = screen.getByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: '名称' });
    expect(name).toBeRequired();
    await userEvent.type(name, '测试助手');
    await userEvent.type(within(dialog).getByRole('textbox', { name: '职责' }), '只用于合成测试');
    await userEvent.click(within(dialog).getByRole('button', { name: '创建 Bot' }));
    expect(screen.getByRole('heading', { name: '测试助手' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps research takeover active after switching to another Bot and back', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '接管电脑' }));
    expect(screen.getByRole('button', { name: '交还给 Bot' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
    await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
    expect(screen.getByRole('button', { name: '接管电脑' })).toBeVisible();
    await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
    expect(screen.getByRole('button', { name: '交还给 Bot' })).toBeVisible();
  });
  it('saves memory and restores it after a new mount', async () => {
    const first = render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
    const memory = screen.getByRole('textbox', { name: '工作偏好' });
    await userEvent.clear(memory);
    await userEvent.type(memory, '合成偏好：每次给出三条建议');
    await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    first.unmount();
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
    expect(screen.getByRole('textbox', { name: '工作偏好' })).toHaveValue(
      '合成偏好：每次给出三条建议',
    );
  });
  it('preserves unsaved memory text when the workspace panel is closed', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
    const memory = screen.getByRole('textbox', { name: '工作偏好' });
    await userEvent.clear(memory);
    await userEvent.type(memory, '合成的未保存记忆');
    await userEvent.click(screen.getByRole('button', { name: '关闭工作区面板' }));
    await workspaceTab(userEvent, '记忆');
    expect(screen.getByRole('textbox', { name: '工作偏好' })).toHaveValue('合成的未保存记忆');
  });
  it('does not send a message while a Chinese input composition is active', async () => {
    render(<App />);
    const input = screen.getByRole('textbox', { name: '发送消息' });
    await userEvent.type(input, '合成输入法测试');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(input).toHaveValue('合成输入法测试');
    expect(
      within(screen.getByRole('log', { name: '对话记录' })).queryByText('合成输入法测试'),
    ).not.toBeInTheDocument();
  });
  it('starts a fresh routine form when switching to another Bot', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: '定时' }));
    await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
    await userEvent.type(screen.getByRole('textbox', { name: '任务名称' }), '合成研究任务');
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
        name: '写作搭档',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: '新建定时任务' }));
    expect(screen.getByRole('textbox', { name: '任务名称' })).toHaveValue('');
    await userEvent.click(
      within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
        name: '研究员',
      }),
    );
    expect(screen.getByRole('textbox', { name: '任务名称' })).toHaveValue('合成研究任务');
  });
  it('requires a time before saving a demo routine and accepts a complete time', async () => {
    const state = seedDemoState();
    state.routineDrafts.research = {
      ...state.routineDrafts.research,
      open: true,
      title: '合成时间必填任务',
      instruction: '只使用合成内容验证时间',
      time: '',
    };
    localStorage.setItem(seedStorageKey, seedSerialize(state));
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: '定时' }));
    await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
    expect(screen.getByText('请输入有效时间（00:00–23:59）。')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '任务名称' })).toHaveValue('合成时间必填任务');
    await userEvent.click(screen.getByRole('spinbutton', { name: /小时, 时间/ }));
    await userEvent.keyboard('10');
    await userEvent.click(screen.getByRole('spinbutton', { name: /分钟, 时间/ }));
    await userEvent.keyboard('30');
    await userEvent.click(screen.getByRole('button', { name: '保存定时任务' }));
    expect(screen.queryByRole('textbox', { name: '任务名称' })).not.toBeInTheDocument();
    expect(screen.getByText('合成时间必填任务')).toBeVisible();
    expect(screen.getByText('每天 · 10:30')).toBeVisible();
  });
  it('records an approval locally and opens the correct Bot for handoff', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /收件箱/ }));
    await userEvent.click(screen.getByRole('button', { name: '确认草稿' }));
    expect(screen.queryByRole('button', { name: '确认草稿' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '前往接管' }));
    expect(screen.getByRole('heading', { name: '浏览器助手' })).toBeVisible();
    expect(screen.getByRole('button', { name: '交还给 Bot' })).toBeVisible();
  });
  it('closes the create dialog with Escape', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '新建 Bot' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

it('continues an interrupted live task with its original input reference and a new request ID', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 1;
  snapshot.model.configured = true;
  snapshot.bots.a = {
    owner: 'agent',
    epoch: 3,
    task: {
      running: false,
      phase: 'interrupted',
      runId: 'mock-old-run',
      requestId: 'mock-old-request',
      prompt: '只处理合成输入',
      result: '',
      error: '合成中断',
      files: [],
      toolCount: 2,
      executedCount: 2,
      trace: [],
      history: [],
    },
  };
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true as const,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'frame'
          ? 'data:image/jpeg;base64,c3ludGhldGlj'
          : {},
  }));
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(<App />);
  await userEvent.type(await screen.findByRole('textbox', { name: '发送消息' }), '下一项合成草稿');
  await userEvent.click(await screen.findByRole('button', { name: '继续处理' }));
  const command = invoke.mock.calls
    .map(([value]) => value)
    .find((value) => value.type === 'task.start');
  expect(command).toMatchObject({
    type: 'task.start',
    bot: 'a',
    task: { prompt: '只处理合成输入', retryOf: 'mock-old-run' },
  });
  if (command?.type === 'task.start') expect(command.task.requestId).not.toBe('mock-old-request');
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('下一项合成草稿');
});
it('continues the unfinished inserted turn instead of replaying completed work', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 43;
  snapshot.model.configured = true;
  snapshot.bots.a = {
    owner: 'agent',
    epoch: 3,
    task: {
      running: false,
      phase: 'failed',
      runId: 'mock-turn-run',
      requestId: 'mock-turn-request',
      prompt: '合成原始请求',
      result: '',
      error: '合成插话失败',
      files: [],
      toolCount: 1,
      executedCount: 1,
      trace: [],
      history: [],
      turns: [
        { id: 'mock-turn-request', prompt: '合成原始请求', result: '合成原始回复' },
        { id: 'mock-turn-inserted', prompt: '合成失败的插话', result: '' },
      ],
      inserts: [
        { id: 'mock-turn-inserted', text: '合成失败的插话', done: false, started: true },
        { id: 'mock-turn-waiting', text: '合成待执行插话', done: false },
      ],
    },
  };
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true as const,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'task.start'
          ? {
              runId: 'mock-turn-retry',
              requestId: command.task.requestId,
              prompt: command.task.prompt,
              phase: 'completed',
              running: false,
              result: 'SYNTHETIC DONE',
              error: '',
              files: [],
              chatRevision: command.task.chatRevision,
            }
          : command.type === 'frame'
            ? 'data:image/jpeg;base64,c3ludGhldGlj'
            : {},
  }));
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '继续处理' }));
  const command = invoke.mock.calls
    .map(([value]) => value)
    .find((value) => value.type === 'task.start');
  expect(command).toMatchObject({
    type: 'task.start',
    bot: 'a',
    task: { prompt: '合成失败的插话', retryOf: 'mock-turn-run', retryTurn: 'mock-turn-inserted' },
  });
  // Accepted inserts stay with the backend continuation, even if its receipt is already terminal.
  expect(await screen.findByText('合成待执行插话')).toBeInTheDocument();
});
it('keeps the draft editable after an explicit task validation rejection', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 1;
  snapshot.model.configured = true;
  const invoke = vi.fn(async (command: RuntimeCommand) =>
    command.type === 'task.start'
      ? { ok: false as const, error: 'INVALID_TASK' }
      : { ok: true as const, value: command.type === 'status' ? snapshot : {} },
  );
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, '需要修改的合成任务');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(input).toBeEnabled();
  expect(input).toHaveValue('需要修改的合成任务');
  expect(screen.queryByText('正在确认任务是否启动')).not.toBeInTheDocument();
});
it('retries an ambiguous task result with the same request ID instead of duplicating it', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 1;
  snapshot.model.configured = true;
  const invoke = vi.fn(async (command: RuntimeCommand) =>
    command.type === 'task.start'
      ? { ok: false as const, error: 'RUNTIME_UNAVAILABLE' }
      : { ok: true as const, value: command.type === 'status' ? snapshot : {} },
  );
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(<App />);
  await userEvent.type(
    await screen.findByRole('textbox', { name: '发送消息' }),
    '合成网络结果未知任务',
  );
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toBeDisabled();
  await userEvent.click(await screen.findByRole('button', { name: '重试发送' }));
  const sends = invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'task.start');
  expect(sends).toHaveLength(2);
  expect(sends[0]).toEqual(sends[1]);
});
it.each([
  { trace: [], count: 0, label: '正在思考' },
  {
    trace: [
      { name: 'read_file', surface: 'workspace', phase: 'settled', at: '2026-01-01T00:00:00Z' },
    ],
    count: 1,
    label: '正在使用工具',
  },
])(
  'shows $label instead of claiming every turn operates a computer',
  async ({ trace, count, label }) => {
    const snapshot = disconnected('ready');
    snapshot.protocolVersion = 1;
    snapshot.model.configured = true;
    snapshot.bots.a = {
      owner: 'agent',
      epoch: 0,
      task: {
        running: true,
        phase: 'running',
        runId: 'mock-general-run',
        requestId: 'mock-general-request',
        prompt: '合成普通请求',
        result: '',
        error: '',
        files: [],
        toolCount: count,
        executedCount: count,
        trace,
        history: [],
      },
    };
    const invoke = vi.fn(async (command: RuntimeCommand) => ({
      ok: true as const,
      value:
        command.type === 'status'
          ? snapshot
          : command.type === 'frame'
            ? 'data:image/jpeg;base64,c3ludGhldGlj'
            : {},
    }));
    Object.defineProperty(window, 'daban', {
      value: {
        platform: 'darwin',
        runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
      },
      configurable: true,
    });
    render(<App />);
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.queryByText('正在操作电脑')).not.toBeInTheDocument();
  },
);
it('lets an unbound Bot chat without allocating a desktop', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 2;
  snapshot.model.configured = true;
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true as const,
    value: command.type === 'status' ? snapshot : {},
  }));
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '小管家' }));
  invoke.mockClear();
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '合成普通问候');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'task.start',
      bot: 'chief',
      task: expect.objectContaining({ prompt: '合成普通问候' }),
    }),
  );
  expect(
    invoke.mock.calls.some(([command]) => command.type === 'control' || command.type === 'frame'),
  ).toBe(false);
});
it('edits the backend Bot persona instead of only changing a client label', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 3;
  snapshot.model.configured = true;
  const profile = {
    id: 'a',
    name: '合成研究助理',
    instructions: '合成职责',
    memory: '合成已保存偏好',
    color: 'violet' as const,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  snapshot.profiles = [profile];
  const invoke = vi.fn(async (command: RuntimeCommand) => ({
    ok: true as const,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'bot.register'
          ? {
              ...command.profile,
              revision: 1,
              createdAt: profile.createdAt,
              updatedAt: profile.updatedAt,
            }
          : command.type === 'bot.update'
            ? { ...profile, ...command.patch, revision: 2 }
            : command.type === 'frame'
              ? 'data:image/jpeg;base64,c3ludGhldGlj'
              : {},
  }));
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  expect(await screen.findByRole('heading', { name: '合成研究助理' })).toBeVisible();
  await appAction(userEvent, '编辑 Bot 资料');
  const dialog = screen.getByRole('dialog');
  const name = within(dialog).getByRole('textbox', { name: '名称' });
  await userEvent.clear(name);
  await userEvent.type(name, '新合成名字');
  await userEvent.click(within(dialog).getByRole('button', { name: '保存资料' }));
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 1,
    patch: { name: '新合成名字', instructions: '合成职责' },
  });
  expect(await screen.findByRole('heading', { name: '新合成名字' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('keeps an unsaved memory draft after a backend conflict and does not show a successful save', async () => {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 3;
  snapshot.model.configured = true;
  const profile = {
    id: 'a',
    name: '合成助理',
    instructions: '合成职责',
    memory: '合成已保存偏好',
    color: 'violet' as const,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  snapshot.profiles = [profile];
  const invoke = vi.fn(async (command: RuntimeCommand) =>
    command.type === 'bot.update'
      ? { ok: false as const, error: 'BOT_PROFILE_CONFLICT' }
      : {
          ok: true as const,
          value:
            command.type === 'status'
              ? snapshot
              : command.type === 'bot.register'
                ? {
                    ...command.profile,
                    revision: 1,
                    createdAt: profile.createdAt,
                    updatedAt: profile.updatedAt,
                  }
                : command.type === 'frame'
                  ? 'data:image/jpeg;base64,c3ludGhldGlj'
                  : {},
        },
  );
  Object.defineProperty(window, 'daban', {
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
    configurable: true,
  });
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
  const memory = screen.getByRole('textbox', { name: '工作偏好' });
  await userEvent.clear(memory);
  await userEvent.type(memory, '合成待保存草稿');
  await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(memory).toHaveValue('合成待保存草稿');
  expect(await screen.findByText(/资料已更新/)).toBeVisible();
});

function profileRuntime() {
  const base: BotProfile = {
    id: 'a',
    name: '合成助理',
    instructions: '合成职责',
    memory: '合成原偏好',
    color: 'mint',
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  let current = base;
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 3;
  snapshot.model.configured = true;
  snapshot.profiles = [base, { ...base, id: 'b', name: '合成写作助理' }];
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'bot.update') {
      if (command.revision !== current.revision)
        return { ok: false as const, error: 'BOT_PROFILE_CONFLICT' };
      const { model, ...fields } = command.patch;
      current = { ...current, ...fields, revision: current.revision + 1 };
      if (model === null) delete current.model;
      else if (model !== undefined) current.model = model;
      return { ok: true as const, value: current };
    }
    return {
      ok: true as const,
      value:
        command.type === 'status'
          ? snapshot
          : command.type === 'bot.register'
            ? { ...base, ...command.profile, ...(command.profile.id === 'a' ? current : {}) }
            : command.type === 'frame'
              ? 'data:image/jpeg;base64,c3ludGhldGlj'
              : {},
    };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return {
    invoke,
    snapshot,
    advance(patch: Partial<BotProfile>) {
      current = { ...current, ...patch, revision: current.revision + 1 };
      snapshot.profiles = [current, snapshot.profiles[1]];
      act(() => {
        for (const listener of listeners) listener({ ...snapshot });
      });
    },
  };
}
it('uses the memory draft base and lets the user review a conflict without losing the draft', async () => {
  const backend = profileRuntime();
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
  const input = screen.getByRole('textbox', { name: '工作偏好' });
  await userEvent.clear(input);
  await userEvent.type(input, '合成待保存偏好');
  backend.advance({ memory: '合成后台新偏好' });
  await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 1,
    patch: { memory: '合成待保存偏好' },
  });
  expect(await screen.findByText('合成后台新偏好')).toBeVisible();
  expect(input).toHaveValue('合成待保存偏好');
  await userEvent.click(screen.getByRole('button', { name: '保留草稿，按此版本重试' }));
  await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 2,
    patch: { memory: '合成待保存偏好' },
  });
  expect(await screen.findByText('记忆已保存到本机运行环境。')).toBeVisible();
});

it('shows a model-saved preference in a clean editor and retains a human draft after a later model update', async () => {
  const backend = profileRuntime();
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
  const input = screen.getByRole('textbox', { name: '工作偏好' });
  backend.advance({ memory: '模型保存的合成偏好' });
  expect(input).toHaveValue('模型保存的合成偏好');
  await userEvent.clear(input);
  await userEvent.type(input, '人类未保存的合成草稿');
  backend.advance({ memory: '模型保存的第二份合成偏好' });
  expect(input).toHaveValue('人类未保存的合成草稿');
  expect(screen.getByText('未保存修改 · 草稿已暂存')).toBeVisible();
});
it('retries a profile conflict in the same form with the original edits intact', async () => {
  const backend = profileRuntime();
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await appAction(userEvent, '编辑 Bot 资料');
  const dialog = screen.getByRole('dialog');
  const name = within(dialog).getByRole('textbox', { name: '名称' });
  await userEvent.clear(name);
  await userEvent.type(name, '合成我的编辑');
  backend.advance({ name: '合成后台改名' });
  await userEvent.click(within(dialog).getByRole('button', { name: '保存资料' }));
  expect(await within(dialog).findByText('合成后台改名')).toBeVisible();
  expect(name).toHaveValue('合成我的编辑');
  await userEvent.click(within(dialog).getByRole('button', { name: '保留编辑，按此版本重试' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '保存资料' }));
  expect(await screen.findByRole('heading', { name: '合成我的编辑' })).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('keeps pending memory saves and errors on the Bot that submitted them', async () => {
  const backend = profileRuntime();
  const original = backend.invoke.getMockImplementation()!;
  let rejectSave: (error: Error) => unknown = (_error) => {
    throw new Error('save was not started');
  };
  backend.invoke.mockImplementation(async (command) => {
    if (command.type === 'bot.update')
      return new Promise((_resolve, reject) => {
        rejectSave = reject;
      });
    return original(command);
  });
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
  await userEvent.type(screen.getByRole('textbox', { name: '工作偏好' }), '合成编辑');
  await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '合成写作助理' }));
  expect(screen.getByRole('button', { name: '保存记忆' })).toBeEnabled();
  await act(async () => rejectSave(new Error('RUNTIME_OFFLINE')));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await userEvent.click(within(nav).getByRole('button', { name: '合成助理' }));
  expect(screen.getByRole('alert')).toHaveTextContent('本地运行环境尚未连接');
});

it('reviews an offline memory draft before writing over the first backend version', async () => {
  const offline = render(<App />);
  await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
  await userEvent.clear(screen.getByRole('textbox', { name: '工作偏好' }));
  await userEvent.type(screen.getByRole('textbox', { name: '工作偏好' }), '合成离线草稿');
  offline.unmount();
  const backend = profileRuntime();
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  expect(await screen.findByText('合成原偏好')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '工作偏好' })).toHaveValue('合成离线草稿');
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'bot.update')).toBe(false);
});
it('does not silently use a new backend version when the profile editor opened before hydration', async () => {
  const backend = profileRuntime();
  backend.snapshot.profiles = [];
  render(<App />);
  await appAction(userEvent, '编辑 Bot 资料');
  const dialog = screen.getByRole('dialog');
  const name = within(dialog).getByRole('textbox', { name: '名称' });
  await userEvent.clear(name);
  await userEvent.type(name, '合成离线编辑');
  await userEvent.click(within(dialog).getByRole('button', { name: '保存资料' }));
  expect(await within(dialog).findByText('合成助理')).toBeVisible();
  expect(name).toHaveValue('合成离线编辑');
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'bot.update')).toBe(false);
});

it('labels native web work as reading a webpage instead of operating the computer', async () => {
  const backend = profileRuntime();
  backend.snapshot.agents.a = {
    running: true,
    phase: 'running',
    runId: 'mock-web-run',
    requestId: 'mock-web-request',
    prompt: '合成网页读取',
    result: '',
    error: '',
    files: [],
    toolCount: 1,
    executedCount: 0,
    trace: [{ name: 'web_fetch', surface: 'web', phase: 'running', at: '2026-01-01T00:00:00Z' }],
    history: [],
  };
  render(<App />);
  expect(await screen.findByText('正在读取网页')).toBeVisible();
  expect(screen.queryByText('正在操作电脑')).not.toBeInTheDocument();
});
it('labels native search independently from webpage reading', async () => {
  const backend = profileRuntime();
  backend.snapshot.agents.a = {
    running: true,
    phase: 'running',
    runId: 'mock-search-run',
    requestId: 'mock-search-request',
    prompt: '合成搜索',
    result: '',
    error: '',
    files: [],
    toolCount: 1,
    executedCount: 0,
    trace: [{ name: 'web_search', surface: 'web', phase: 'running', at: '2026-01-01T00:00:00Z' }],
    history: [],
  };
  render(<App />);
  expect(await screen.findByText('正在搜索')).toBeVisible();
  expect(screen.queryByText('正在读取网页')).not.toBeInTheDocument();
});

it('does not allow another memory submission while refreshing a conflict', async () => {
  const backend = profileRuntime();
  const original = backend.invoke.getMockImplementation()!;
  let registrations = 0;
  let finishRefresh: () => unknown = () => undefined;
  backend.invoke.mockImplementation(async (command) => {
    if (command.type === 'bot.register' && command.profile.id === 'a' && ++registrations === 2)
      return new Promise<Awaited<ReturnType<typeof original>>>((resolve) => {
        finishRefresh = async () => resolve(await original(command));
      });
    return original(command);
  });
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  await userEvent.click(screen.getByRole('tab', { name: '记忆' }));
  await userEvent.type(screen.getByRole('textbox', { name: '工作偏好' }), '合成草稿');
  backend.advance({ memory: '合成后台偏好' });
  await userEvent.click(screen.getByRole('button', { name: '保存记忆' }));
  await screen.findByText(/资料已更新/);
  expect(screen.getByRole('button', { name: /保存记忆|正在保存…/ })).toBeDisabled();
  await act(async () => {
    await finishRefresh();
  });
  expect(await screen.findByRole('button', { name: '保留草稿，按此版本重试' })).toBeVisible();
});
it('uses the acknowledged profile version when editing again before the next runtime poll', async () => {
  const backend = profileRuntime();
  render(<App />);
  await screen.findByRole('heading', { name: '合成助理' });
  for (const value of ['合成编辑甲', '合成编辑乙']) {
    await appAction(userEvent, '编辑 Bot 资料');
    const dialog = screen.getByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: '名称' });
    await userEvent.clear(name);
    await userEvent.type(name, value);
    await userEvent.click(within(dialog).getByRole('button', { name: '保存资料' }));
    expect(await screen.findByRole('heading', { name: value })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
  expect(backend.invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'bot.update',
    bot: 'a',
    revision: 2,
    patch: { name: '合成编辑乙', instructions: '合成职责' },
  });
});

type LiveTask = NonNullable<RuntimeSnapshot['agents']>[string];
function liveQueueRuntime() {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 42;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 1,
  };
  snapshot.chats = { available: true, revision: 0, items: [] };
  snapshot.agents = {
    a: {
      running: true,
      phase: 'running',
      runId: 'mock-queue-current-run',
      requestId: 'mock-queue-current-request',
      prompt: 'SYNTHETIC CURRENT TASK',
      result: '',
      error: '',
      files: [],
      toolCount: 0,
      executedCount: 0,
      trace: [],
      history: [],
    },
  };
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const starts: Extract<RuntimeCommand, { type: 'task.start' }>[] = [];
  let failing = false;
  let insertsFailing = false;
  let insertError: string | undefined;
  let startGate: Promise<undefined> | undefined;
  let releaseStart: (() => unknown) | undefined;
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true as const, value: snapshot };
    if (command.type === 'task.start') {
      starts.push(command);
      if (failing) return { ok: false as const, error: 'INVALID_TASK' };
      if (startGate) await startGate;
      return {
        ok: true as const,
        value: {
          chatRevision: command.task.chatRevision,
          runId: `mock-queue-run-${starts.length}`,
          requestId: command.task.requestId,
          prompt: command.task.prompt,
          result: '',
          error: '',
          files: [],
          phase: 'running',
          running: true,
        },
      };
    }
    if (command.type === 'task.insert') {
      if (insertError) throw new Error(insertError);
      if (insertsFailing) throw new Error('RUNTIME_OFFLINE');
      return { ok: true as const, value: { ok: true, id: command.id } };
    }
    return { ok: true as const, value: {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return {
    starts,
    invoke,
    emit(task: LiveTask) {
      snapshot = { ...snapshot, agents: { a: task } };
      for (const listener of listeners) listener(snapshot);
    },
    fail() {
      failing = true;
    },
    succeed() {
      failing = false;
    },
    failInserts() {
      insertsFailing = true;
    },
    succeedInserts() {
      insertsFailing = false;
    },
    uncertainInserts() {
      insertError = 'MODEL_INSERT_UNCERTAIN';
    },
    holdStarts() {
      startGate = new Promise<undefined>((resolve) => {
        releaseStart = () => resolve(undefined);
      });
    },
    releaseStarts() {
      startGate = undefined;
      const release = releaseStart;
      releaseStart = undefined;
      release?.();
    },
  };
}
function liveTask(
  runId: string,
  requestId: string,
  prompt: string,
  phase: LiveTask['phase'],
  running: boolean,
  result = '',
): LiveTask {
  return {
    running,
    phase,
    runId,
    requestId,
    prompt,
    result,
    error: '',
    files: [],
    toolCount: 0,
    executedCount: 0,
    trace: [],
    history: [],
  };
}

it('queues messages while a Bot is working and sends them in order after the task ends', async () => {
  const runtime = liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  expect(input).toBeEnabled();
  await userEvent.type(input, 'SYNTHETIC QUEUED ONE');
  await userEvent.keyboard('{Enter}');
  await userEvent.type(input, 'SYNTHETIC QUEUED TWO');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  expect(within(queue).getByText('SYNTHETIC QUEUED ONE')).toBeVisible();
  expect(within(queue).getByText('SYNTHETIC QUEUED TWO')).toBeVisible();
  expect(input).toHaveValue('');
  expect(runtime.starts).toHaveLength(0);

  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(1));
  expect(runtime.starts[0].task.prompt).toBe('SYNTHETIC QUEUED ONE');
  await waitFor(() =>
    expect(within(queue).queryByText('SYNTHETIC QUEUED ONE')).not.toBeInTheDocument(),
  );
  expect(runtime.starts).toHaveLength(1);

  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-run-1',
        runtime.starts[0].task.requestId,
        'SYNTHETIC QUEUED ONE',
        'running',
        true,
      ),
    ),
  );
  expect(runtime.starts).toHaveLength(1);
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-run-1',
        runtime.starts[0].task.requestId,
        'SYNTHETIC QUEUED ONE',
        'completed',
        false,
        'SYNTHETIC FIRST DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(2));
  expect(runtime.starts[1].task.prompt).toBe('SYNTHETIC QUEUED TWO');
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: '排队消息' })).not.toBeInTheDocument(),
  );
});

it('marks a queued message as sending and hides its actions until the send is acknowledged', async () => {
  const runtime = liveQueueRuntime();
  runtime.holdStarts();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC SENDING QUEUE');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(1));
  expect(await within(queue).findByText('正在发送…')).toBeVisible();
  expect(
    within(queue).queryByRole('button', { name: '编辑排队消息 SYNTHETIC SENDING QUEUE' }),
  ).not.toBeInTheDocument();
  expect(
    within(queue).queryByRole('button', { name: '移除排队消息 SYNTHETIC SENDING QUEUE' }),
  ).not.toBeInTheDocument();
  await act(async () => runtime.releaseStarts());
  await waitFor(() =>
    expect(within(queue).queryByText('SYNTHETIC SENDING QUEUE')).not.toBeInTheDocument(),
  );
});
it('returns a queued message to the composer for editing', async () => {
  const runtime = liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC EDITABLE QUEUE');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  await userEvent.click(
    within(queue).getByRole('button', { name: '编辑排队消息 SYNTHETIC EDITABLE QUEUE' }),
  );
  expect(input).toHaveValue('SYNTHETIC EDITABLE QUEUE');
  expect(screen.queryByRole('region', { name: '排队消息' })).not.toBeInTheDocument();
  expect(runtime.starts).toHaveLength(0);
});
it('lets the user move a queued message to the front so it is sent next', async () => {
  const runtime = liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC QUEUED ONE');
  await userEvent.keyboard('{Enter}');
  await userEvent.type(input, 'SYNTHETIC QUEUED TWO');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  await userEvent.click(
    within(queue).getByRole('button', { name: '插队发送 SYNTHETIC QUEUED TWO' }),
  );
  const rows = within(queue).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('SYNTHETIC QUEUED TWO');
  expect(rows[1]).toHaveTextContent('SYNTHETIC QUEUED ONE');
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(1));
  expect(runtime.starts[0].task.prompt).toBe('SYNTHETIC QUEUED TWO');
});
it('inserts a queued message into the running task instead of sending it next', async () => {
  const runtime = liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC QUEUED ONE');
  await userEvent.keyboard('{Enter}');
  await userEvent.type(input, 'SYNTHETIC QUEUED TWO');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  await userEvent.click(
    within(queue).getByRole('button', {
      name: '将排队消息 SYNTHETIC QUEUED TWO 插入当前任务',
    }),
  );
  await waitFor(() =>
    expect(
      runtime.invoke.mock.calls.some(
        ([command]) =>
          command.type === 'task.insert' &&
          command.bot === 'a' &&
          command.text === 'SYNTHETIC QUEUED TWO' &&
          command.runId === 'mock-queue-current-run' &&
          command.chatRevision === 0,
      ),
    ).toBe(true),
  );
  expect(within(queue).queryByText('SYNTHETIC QUEUED TWO')).not.toBeInTheDocument();
  expect(within(queue).getByText('SYNTHETIC QUEUED ONE')).toBeVisible();
  expect(await screen.findByText('SYNTHETIC QUEUED TWO')).toBeVisible();
  expect(runtime.starts).toHaveLength(0);
});
it('pauses an unconfirmed steer until the same request is verified', async () => {
  const runtime = liveQueueRuntime();
  runtime.failInserts();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC UNCERTAIN STEER');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  await userEvent.click(
    within(queue).getByRole('button', {
      name: '将排队消息 SYNTHETIC UNCERTAIN STEER 插入当前任务',
    }),
  );
  expect(await within(queue).findByText('正在核实插话是否已送达…')).toBeVisible();
  expect(within(queue).getByText('SYNTHETIC UNCERTAIN STEER')).toBeVisible();
  expect(runtime.starts).toHaveLength(0);

  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'running',
        true,
      ),
    ),
  );
  expect(within(queue).getByText('正在核实插话是否已送达…')).toBeVisible();
  expect(runtime.starts).toHaveLength(0);

  runtime.succeedInserts();
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'running',
        true,
      ),
    ),
  );
  // The in-flight attempt still fails; the paused item is retried on the next reconciliation tick.
  await waitFor(
    () => expect(screen.queryByRole('region', { name: '排队消息' })).not.toBeInTheDocument(),
    { timeout: 5000 },
  );
  expect(await screen.findByText('SYNTHETIC UNCERTAIN STEER')).toBeVisible();
  expect(runtime.starts).toHaveLength(0);
});
it('keeps a begun insert from being resent automatically after an uncertain outcome', async () => {
  const runtime = liveQueueRuntime();
  runtime.uncertainInserts();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC BEGUN INSERT');
  await userEvent.keyboard('{Enter}');
  const queue = await screen.findByRole('region', { name: '排队消息' });
  await userEvent.click(
    within(queue).getByRole('button', {
      name: '将排队消息 SYNTHETIC BEGUN INSERT 插入当前任务',
    }),
  );
  // The message is kept as a failed item so only an explicit retry can run it again.
  expect(await within(queue).findByText('发送失败，可重试或移除。')).toBeVisible();
  expect(within(queue).getByText('SYNTHETIC BEGUN INSERT')).toBeVisible();
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(0));
  expect(within(queue).getByText('SYNTHETIC BEGUN INSERT')).toBeVisible();
});
it('sends the next queued message when a started task ends before it is seen running', async () => {
  const runtime = liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC QUEUED ONE');
  await userEvent.keyboard('{Enter}');
  await userEvent.type(input, 'SYNTHETIC QUEUED TWO');
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('region', { name: '排队消息' });
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(1));
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-run-1',
        runtime.starts[0].task.requestId,
        'SYNTHETIC QUEUED ONE',
        'completed',
        false,
        'SYNTHETIC FIRST DONE',
      ),
    ),
  );
  await waitFor(() => expect(runtime.starts).toHaveLength(2));
  expect(runtime.starts[1].task.prompt).toBe('SYNTHETIC QUEUED TWO');
});
it('returns focus to the composer after queuing a message', async () => {
  liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC FOCUS QUEUE');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByRole('region', { name: '排队消息' })).toBeVisible();
  expect(input).toHaveFocus();
});
it('returns focus to the composer after sending a message', async () => {
  const runtime = liveQueueRuntime();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, 'SYNTHETIC FOCUS SEND');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(runtime.starts).toHaveLength(1));
  await waitFor(() => expect(input).toHaveFocus());
});
it('keeps a queued message that failed to send so it can be retried', async () => {
  const runtime = liveQueueRuntime();
  runtime.fail();
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC FAILED QUEUE');
  await userEvent.keyboard('{Enter}');
  act(() =>
    runtime.emit(
      liveTask(
        'mock-queue-current-run',
        'mock-queue-current-request',
        'SYNTHETIC CURRENT TASK',
        'completed',
        false,
        'SYNTHETIC CURRENT DONE',
      ),
    ),
  );
  const queue = await screen.findByRole('region', { name: '排队消息' });
  expect(await within(queue).findByText('发送失败，可重试或移除。')).toBeVisible();
  expect(runtime.starts).toHaveLength(1);
  runtime.succeed();
  await userEvent.click(within(queue).getByRole('button', { name: '重试发送' }));
  await waitFor(() => expect(runtime.starts).toHaveLength(2));
  expect(runtime.starts[1].task.prompt).toBe('SYNTHETIC FAILED QUEUE');
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: '排队消息' })).not.toBeInTheDocument(),
  );
});
it('shows an error when an ordinary send is definitively rejected', async () => {
  const runtime = liveQueueRuntime();
  runtime.emit(
    liveTask(
      'mock-queue-current-run',
      'mock-queue-current-request',
      'SYNTHETIC CURRENT TASK',
      'completed',
      false,
      'SYNTHETIC CURRENT DONE',
    ),
  );
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  await waitFor(() => expect(input).toBeEnabled());
  runtime.fail();
  await userEvent.type(input, 'SYNTHETIC DIRECT SEND');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByText('任务或附件参数无效，请修改后重新发送。')).toBeVisible();
});

it.each([false, true])(
  'captures a fresh Goal target once and preserves an uncertain request (legacy=%s)',
  async (legacy) => {
    const snapshot = disconnected('ready');
    snapshot.protocolVersion = 1;
    snapshot.model.configured = true;
    const target = {
      owner: { bot: 'a', chatRevision: 0 },
      sessionId: 'mock-goal-session',
      goalId: 'mock-goal',
      goalRevision: 2,
      humanEpoch: 1,
    };
    const invoke = vi.fn(async (command: RuntimeCommand) =>
      command.type === 'task.start'
        ? { ok: false as const, error: 'RUNTIME_UNAVAILABLE' }
        : {
            ok: true as const,
            value:
              command.type === 'status'
                ? snapshot
                : command.type === 'goal.target'
                  ? legacy
                    ? null
                    : target
                  : {},
          },
    );
    Object.defineProperty(window, 'daban', {
      configurable: true,
      value: {
        platform: 'darwin',
        runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
      },
    });
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: '发送消息' }), '/goal resume');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await userEvent.click(await screen.findByRole('button', { name: '重试发送' }));
    const calls = invoke.mock.calls.map(([value]) => value);
    expect(calls.filter((value) => value.type === 'goal.target')).toHaveLength(1);
    const sends = calls.filter((value) => value.type === 'task.start');
    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual(sends[1]);
    if (sends[0]?.type === 'task.start')
      expect(sends[0].task.goalResume).toEqual(legacy ? undefined : target);
  },
);

it('captures the selected project in an explicit Human Goal target without adding automation authority', async () => {
  const state = seedDemoState();
  const project = { projectId: 'mock-project', revision: 1 };
  state.projectScopes = { research: project };
  localStorage.setItem(seedStorageKey, seedSerialize(state));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 45;
  snapshot.model.configured = true;
  const target = {
    owner: { bot: 'a', chatRevision: 0, project },
    sessionId: 'mock-project-session',
    goalId: 'mock-project-goal',
    goalRevision: 1,
    humanEpoch: 0,
  };
  const invoke = vi.fn(async (command: RuntimeCommand) =>
    command.type === 'task.start'
      ? { ok: false as const, error: 'RUNTIME_UNAVAILABLE' }
      : {
          ok: true as const,
          value:
            command.type === 'status'
              ? snapshot
              : command.type === 'goal.target'
                ? target
                : command.type === 'projects.list'
                  ? []
                  : command.type === 'projects.status'
                    ? { available: true, execution: true }
                    : {},
        },
  );
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke, subscribe: () => () => undefined } as unknown as RuntimeBridge,
    },
  });
  render(<App />);
  await userEvent.type(await screen.findByRole('textbox', { name: '发送消息' }), '/goal resume');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  const calls = invoke.mock.calls.map(([command]) => command);
  expect(calls).toContainEqual({ type: 'goal.target', owner: target.owner });
  const send = calls.find((command) => command.type === 'task.start');
  expect(send).toMatchObject({ type: 'task.start', task: { project, goalResume: target } });
  expect(send && 'automation' in send).toBe(false);
});
