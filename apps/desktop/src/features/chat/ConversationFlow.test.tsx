import { agentId, disconnected, type RuntimeCommand, type RuntimeSnapshot } from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { initialState } from '../../app/state';
import { serialize, storageKey } from '../../app/storage';
import { demoState } from '../../test/fixtures';
import { onboardingKey } from '../onboarding/Onboarding';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

function bridge(
  snapshot: RuntimeSnapshot,
  listeners = new Set<(value: RuntimeSnapshot) => unknown>(),
) {
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'bot.register') {
      const profile = {
        ...command.profile,
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      if (!snapshot.profiles.some((entry) => entry.id === profile.id))
        snapshot.profiles.push(profile);
      return { ok: true, value: profile };
    }
    if (command.type === 'chat.history')
      return { ok: true, value: { bot: command.bot, revision: command.revision, items: [] } };
    if (command.type === 'task.start')
      return {
        ok: true,
        value: {
          runId: 'mock-conversation-run',
          requestId: command.task.requestId,
          prompt: command.task.prompt,
          chatRevision: command.task.contextRevision ?? command.task.chatRevision,
          phase: 'completed',
          running: false,
          result: 'SYNTHETIC ANSWER',
          error: '',
          files: [],
        },
      };
    if (command.type === 'chat.new') {
      const chat = {
        bot: command.request.bot,
        revision: command.request.revision + 1,
        updatedAt: '2026-01-03T00:00:00Z',
      };
      snapshot.chats = {
        available: true,
        revision: chat.revision,
        items: [chat],
        conversations: snapshot.chats?.conversations,
      };
      return {
        ok: true,
        value: {
          chat,
          receipt: {
            request: command.request,
            revision: chat.revision,
            completedAt: chat.updatedAt,
          },
        },
      };
    }
    return { ok: true, value: {} };
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
      },
    },
  });
  return invoke;
}
function ready() {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 46;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 1,
  };
  snapshot.chats = { available: true, revision: 0, items: [] };
  return snapshot;
}

it('opens the browser setup from the conversation without launching or authorizing it automatically', async () => {
  localStorage.setItem(storageKey, serialize(demoState()));
  const snapshot = ready();
  snapshot.agent = {
    location: 'host',
    execution: 'local-workspace',
    privilege: 'workspace',
    approvals: 'host',
  };
  snapshot.hostBrowser = { available: true, connections: [] };
  const invoke = bridge(snapshot);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '打开浏览器面板' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: '打开浏览器' })).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => command.type === 'hostBrowser')).toBe(false);
});

it.each(['connecting', 'offline'] as const)(
  'opens local chat drafts while the workspace is %s and keeps sending fenced',
  async (phase) => {
    const state = demoState();
    state.panel = 'computer';
    state.drafts.research = 'SYNTHETIC BOT DRAFT';
    localStorage.setItem(storageKey, serialize(state));
    const snapshot = disconnected(phase);
    const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
    const invoke = bridge(snapshot, listeners);
    render(<App />);
    const create = await screen.findByRole('button', { name: '新对话' });
    expect(create).toBeEnabled();
    await userEvent.click(create);
    expect(screen.getByRole('heading', { name: '今天想聊什么，或做点什么？' })).toBeVisible();
    expect(screen.queryByRole('complementary', { name: 'Bot 工作区' })).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '发送消息' });
    await userEvent.type(input, 'SYNTHETIC LOCAL DRAFT');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(screen.getByText('连接后台后即可发送，当前草稿会保留。')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    expect(
      invoke.mock.calls.some(
        ([command]) =>
          command.type === 'bot.register' ||
          command.type === 'task.start' ||
          command.type === 'chat.new',
      ),
    ).toBe(false);
    expect(screen.getByRole('button', { name: '开启新对话' })).toBeEnabled();
    await act(async () => {
      Object.assign(snapshot, ready());
      for (const listener of listeners) listener({ ...snapshot });
    });
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC LOCAL DRAFT');
    expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() =>
      expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
        expect.objectContaining({
          type: 'task.start',
          task: expect.objectContaining({ prompt: 'SYNTHETIC LOCAL DRAFT', contextRevision: 0 }),
        }),
      ),
    );
  },
);

it('opens another local conversation from the header while connecting and retains both drafts', async () => {
  localStorage.setItem(onboardingKey, 'complete');
  localStorage.setItem(storageKey, serialize(initialState()));
  const snapshot = disconnected('connecting');
  snapshot.protocolVersion = 46;
  const invoke = bridge(snapshot);
  render(<App />);
  await userEvent.click((await screen.findAllByRole('button', { name: '新对话' }))[0]);
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'SYNTHETIC FIRST DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '开启新对话' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'SYNTHETIC SECOND DRAFT');
  const recent = screen.getByRole('navigation', { name: '最近对话列表' });
  await userEvent.click(within(recent).getByRole('button', { name: '新对话', current: false }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC FIRST DRAFT');
  await userEvent.click(within(recent).getByRole('button', { name: '新对话', current: false }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC SECOND DRAFT');
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command.type === 'bot.register' ||
        command.type === 'task.start' ||
        command.type === 'chat.new',
    ),
  ).toBe(false);
});

it('opens ordinary chats from the chats entry and preserves the Bot draft and running task', async () => {
  const state = demoState();
  state.panel = null;
  state.drafts.research = 'SYNTHETIC BOT DRAFT';
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  snapshot.profiles = state.bots
    .filter((bot) => !bot.members)
    .map((bot) => ({
      id: agentId(bot.id),
      name: bot.name,
      instructions: bot.role,
      color: bot.color,
      memory: '',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
  snapshot.agents.a = {
    runId: 'mock-bot-running',
    requestId: 'mock-bot-request',
    prompt: 'SYNTHETIC BOT TASK',
    running: true,
    phase: 'running',
    result: '',
    error: '',
    files: [],
    history: [],
    trace: [],
    toolCount: 0,
    executedCount: 0,
    chatRevision: 0,
  };
  const invoke = bridge(snapshot);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '对话' }));
  expect(screen.getByRole('heading', { name: '今天想聊什么，或做点什么？' })).toBeVisible();
  await userEvent.type(
    screen.getByRole('textbox', { name: '发送消息' }),
    'SYNTHETIC ORDINARY DRAFT',
  );
  await userEvent.click(screen.getByRole('button', { name: '研究员' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC BOT DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '对话' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC ORDINARY DRAFT');
  expect(snapshot.agents.a.running).toBe(true);
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command.type === 'task.stop' ||
        command.type === 'task.start' ||
        command.type === 'chat.new',
    ),
  ).toBe(false);
});

it('allows a local draft with an older backend and explains why it cannot be sent', async () => {
  const state = demoState();
  state.panel = null;
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  snapshot.protocolVersion = 45;
  const invoke = bridge(snapshot);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '新对话' }));
  await userEvent.type(
    screen.getByRole('textbox', { name: '发送消息' }),
    'SYNTHETIC RETAINED DRAFT',
  );
  expect(screen.getByText('请更新后台运行组件后发送，当前草稿会保留。')).toBeVisible();
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await userEvent.keyboard('{Enter}');
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command.type === 'task.start' ||
        (command.type === 'bot.register' && command.profile.kind === 'chat'),
    ),
  ).toBe(false);
});

it('starts an ordinary tool-capable conversation directly without a Bot setup form', async () => {
  localStorage.setItem(storageKey, serialize(initialState()));
  const invoke = bridge(ready());
  render(<App />);
  await userEvent.click((await screen.findAllByRole('button', { name: '新对话' }))[0]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command.type === 'bot.register')).toBe(false);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  expect(screen.queryByRole('button', { name: '加载更早消息' })).not.toBeInTheDocument();
  expect(input).toHaveFocus();
  await userEvent.type(input, 'SYNTHETIC ORDINARY TASK');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() =>
    expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
      expect.objectContaining({
        type: 'task.start',
        task: expect.objectContaining({ prompt: 'SYNTHETIC ORDINARY TASK', contextRevision: 0 }),
      }),
    ),
  );
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'bot.register',
      profile: expect.objectContaining({ kind: 'chat', instructions: '', memory: '' }),
    }),
  );
  expect(await screen.findByText('SYNTHETIC ANSWER')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '更多操作' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: '重命名对话' }));
  const name = screen.getByRole('textbox', { name: '名称' });
  await userEvent.clear(name);
  await userEvent.type(name, 'SYNTHETIC RENAMED TOPIC');
  await userEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(screen.getByRole('heading', { name: 'SYNTHETIC RENAMED TOPIC' })).toBeVisible();
});

it('switches Bot topics without executing anything and explicitly continues the selected historical context', async () => {
  const state = demoState();
  state.panel = null;
  state.messages.research = [];
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  snapshot.profiles = state.bots
    .filter((bot) => !bot.members)
    .map((bot) => ({
      id: agentId(bot.id),
      name: bot.name,
      instructions: bot.role,
      memory: '',
      color: bot.color,
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
  snapshot.chats = {
    available: true,
    revision: 1,
    items: [{ bot: 'a', revision: 1, updatedAt: '2026-01-02T00:00:00Z' }],
    conversations: [
      { bot: 'a', revision: 0, title: 'SYNTHETIC OLD TOPIC', updatedAt: '2026-01-01T00:00:00Z' },
      { bot: 'a', revision: 1, title: 'SYNTHETIC NEW TOPIC', updatedAt: '2026-01-02T00:00:00Z' },
    ],
  };
  const invoke = bridge(snapshot);
  render(<App />);
  const recent = await screen.findByRole('navigation', { name: '最近对话列表' });
  await userEvent.click(within(recent).getByRole('button', { name: /^SYNTHETIC OLD TOPIC/ }));
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'SYNTHETIC DRAFT');
  await userEvent.click(within(recent).getByRole('button', { name: /^SYNTHETIC NEW TOPIC/ }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
  await userEvent.click(within(recent).getByRole('button', { name: /^SYNTHETIC OLD TOPIC/ }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC DRAFT');
  expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() =>
    expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
      type: 'task.start',
      bot: 'a',
      task: expect.objectContaining({
        prompt: 'SYNTHETIC DRAFT',
        chatRevision: 1,
        contextRevision: 0,
      }),
    }),
  );
  const input = screen.getByRole('textbox', { name: '发送消息' });
  await userEvent.type(input, 'SYNTHETIC OLD TOPIC DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '开启新对话' }));
  await userEvent.click(screen.getByRole('button', { name: '确认开启' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'chat.new',
    request: expect.objectContaining({ bot: 'a', revision: 1 }),
  });
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
  await userEvent.click(within(recent).getByRole('button', { name: /^SYNTHETIC OLD TOPIC/ }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue(
    'SYNTHETIC OLD TOPIC DRAFT',
  );
});
