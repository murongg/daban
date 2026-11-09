import {
  agentId,
  disconnected,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
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

it('shows a loading icon only on the conversation whose message is processing', async () => {
  const state = demoState();
  const assistant = state.bots.find((bot) => bot.id === 'chief')!;
  const selected = state.bots.find((bot) => bot.id === state.selected)!;
  selected.kind = 'chat';
  selected.assistant = agentId(assistant.id);
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  const bot = agentId(state.selected);
  snapshot.profiles = [
    {
      id: bot,
      name: '合成助手',
      kind: 'chat',
      assistant: selected.assistant,
      instructions: '',
      memory: '',
      color: 'mint',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
  snapshot.chats = {
    available: true,
    revision: 1,
    items: [{ bot, revision: 1, updatedAt: '2026-01-02T00:00:00Z' }],
    conversations: [
      { bot, revision: 0, title: '合成旧对话', updatedAt: '2026-01-01T00:00:00Z' },
      { bot, revision: 1, title: '合成处理中对话', updatedAt: '2026-01-02T00:00:00Z' },
    ],
  };
  const task = {
    runId: 'mock-run',
    prompt: '合成任务',
    running: true,
    phase: 'running' as const,
    result: '',
    error: '',
    files: [],
    history: [],
    trace: [],
    toolCount: 0,
    executedCount: 0,
    chatRevision: 1,
  };
  snapshot.agents[bot] = task;
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  bridge(snapshot, listeners);
  render(<App />);

  const recent = within(await screen.findByRole('navigation', { name: '最近对话列表' }));
  const processing = await recent.findByRole('button', {
    name: /合成处理中对话.*正在处理你的消息/,
  });
  const old = recent.getByRole('button', { name: /^合成旧对话/ });
  expect(processing).toHaveTextContent(assistant.name);
  expect(
    processing.closest('.recent-entry')?.querySelector('.recent-progress'),
  ).toBeInTheDocument();
  expect(old.closest('.recent-entry')?.querySelector('.recent-progress')).not.toBeInTheDocument();

  await act(async () => {
    for (const listener of listeners)
      listener({
        ...snapshot,
        agents: { ...snapshot.agents, [bot]: { ...task, phase: 'waiting' } },
      });
  });
  const waiting = await recent.findByRole('button', { name: /合成处理中对话.*待确认/ });
  expect(
    waiting.closest('.recent-entry')?.querySelector('.recent-progress'),
  ).not.toBeInTheDocument();
});

it.each(['ready', 'offline'] as const)(
  'returns to an empty ordinary chat from the sidebar after selecting a Bot while %s',
  async (phase) => {
    localStorage.setItem(storageKey, serialize(demoState()));
    const invoke = bridge(phase === 'ready' ? ready() : disconnected(phase));
    render(<App />);
    const sidebar = screen.getByRole('complementary', { name: '侧栏' });
    await userEvent.click(await within(sidebar).findByRole('button', { name: '对话' }));
    expect(screen.getByText('普通对话 · 可使用工具')).toBeVisible();

    await userEvent.click(within(sidebar).getByRole('button', { name: '写作搭档' }));
    expect(screen.getByRole('heading', { name: '写作搭档' })).toBeVisible();

    const recent = within(sidebar).getByRole('navigation', { name: '最近对话列表' });
    await userEvent.click(within(recent).getByRole('button', { name: '新对话' }));
    expect(screen.getByText('普通对话 · 可使用工具')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
    expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
  },
);

it('selects a Bot below a new chat without moving the Bot workspace into recent chats', async () => {
  const state = demoState();
  state.messages.writer = [
    { id: 'mock-writer-workspace', role: 'user', text: 'SYNTHETIC WORKSPACE TOPIC' },
  ];
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  snapshot.protocolVersion = 51;
  const invoke = bridge(snapshot);
  render(<App />);
  const bots = screen.getByRole('navigation', { name: 'Bot 列表' });
  const recent = screen.getByRole('region', { name: '最近对话' });

  await userEvent.click(within(bots).getByRole('button', { name: '写作搭档' }));
  expect(screen.getByRole('heading', { name: '写作搭档' })).toBeVisible();

  await userEvent.click(screen.getByRole('button', { name: '新对话' }));
  const input = screen.getByRole('textbox', { name: '发送消息' });
  expect(input).toHaveFocus();
  await userEvent.type(input, 'SYNTHETIC INDEPENDENT TOPIC');
  const responder = screen.getByRole('button', { name: /回复者/ });
  expect(responder).toHaveTextContent('普通助手');
  await userEvent.click(responder);
  await userEvent.click(await screen.findByRole('option', { name: '写作搭档' }));
  expect(input).toHaveValue('SYNTHETIC INDEPENDENT TOPIC');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  const topic = await within(recent).findByRole('button', {
    name: /SYNTHETIC INDEPENDENT TOPIC.*写作搭档/,
  });
  expect(screen.queryByRole('button', { name: /回复者/ })).not.toBeInTheDocument();
  expect(within(recent).queryByText('SYNTHETIC WORKSPACE TOPIC')).not.toBeInTheDocument();

  await userEvent.click(within(bots).getByRole('button', { name: '写作搭档' }));
  expect(screen.getByText('SYNTHETIC WORKSPACE TOPIC')).toBeVisible();
  await userEvent.click(topic);
  expect(screen.getByRole('heading', { name: 'SYNTHETIC INDEPENDENT TOPIC' })).toBeVisible();
  const commands = invoke.mock.calls.map(([command]) => command);
  const registration = commands.flatMap((command) =>
    command.type === 'bot.register' && command.profile.kind === 'chat' ? [command.profile] : [],
  )[0];
  expect(registration).toMatchObject({ id: expect.stringMatching(/^chat_/), assistant: 'b' });
  expect(commands.filter((command) => command.type === 'task.start')).toEqual([
    expect.objectContaining({ bot: registration?.id }),
  ]);
  expect(invoke.mock.calls.some(([command]) => command.type === 'chat.new')).toBe(false);
});

it('opens selected message text as an editable draft for another Bot without sending it', async () => {
  const state = demoState();
  state.selected = 'writer';
  state.drafts.writer = 'SYNTHETIC ORIGINAL DRAFT';
  state.files.push({
    id: 'mock-private-file',
    name: 'synthetic-private.txt',
    kind: 'TXT',
    size: '1 KB',
    modified: '',
    content: 'SYNTHETIC FILE CONTENT',
  });
  state.messages.writer = [
    {
      id: 'mock-source-request',
      role: 'user',
      text: 'SKIP BEFORE SYNTHETIC QUESTION',
      files: ['mock-private-file'],
    },
    { id: 'mock-source-reply', role: 'bot', text: 'SYNTHETIC ANSWER SKIP AFTER' },
  ];
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  snapshot.protocolVersion = 51;
  const invoke = bridge(snapshot);
  render(<App />);
  const question = await screen.findByText('SKIP BEFORE SYNTHETIC QUESTION');
  const answer = screen.getByText('SYNTHETIC ANSWER SKIP AFTER');
  expect(screen.getByRole('button', { name: /synthetic-private.txt/ })).toBeVisible();
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(question.firstChild!, 'SKIP BEFORE '.length);
  range.setEnd(answer.firstChild!, 'SYNTHETIC ANSWER'.length);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event('selectionchange'));

  await userEvent.click(screen.getByRole('button', { name: '用选中内容开启新对话' }));
  const draft = screen.getByRole('textbox', { name: '发送消息' });
  expect(draft).toHaveFocus();
  expect(draft).toHaveValue('引用自上一段对话\n\n> SYNTHETIC QUESTION\n\n> SYNTHETIC ANSWER\n\n');
  expect(screen.queryByRole('button', { name: /synthetic-private.txt/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /普通助手.*回复者/ }));
  await userEvent.click(await screen.findByRole('option', { name: '研究员' }));
  expect(draft).toHaveValue('引用自上一段对话\n\n> SYNTHETIC QUESTION\n\n> SYNTHETIC ANSWER\n\n');
  expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);

  await userEvent.click(
    within(screen.getByRole('navigation', { name: 'Bot 列表' })).getByRole('button', {
      name: '写作搭档',
    }),
  );
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC ORIGINAL DRAFT');
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

it('loads recent messages on open and offers pagination above them only while more exist', async () => {
  const state = demoState();
  state.panel = null;
  state.messages.research = [];
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = ready();
  const invoke = bridge(snapshot);
  invoke.mockImplementation(async (command) => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type !== 'chat.history') return { ok: true, value: {} };
    const record = {
      chatRevision: command.revision,
      runId: 'mock-earlier-run',
      requestId: 'mock-earlier-request',
      prompt: 'SYNTHETIC EARLIER QUESTION',
      result: 'SYNTHETIC EARLIER ANSWER',
      phase: 'completed' as const,
      error: '',
      files: [],
    };
    return {
      ok: true,
      value: {
        bot: command.bot,
        revision: command.revision,
        items: command.before ? [] : [record],
        nextBefore: command.before ? undefined : record.runId,
      },
    };
  });
  render(<App />);

  const transcript = within(await screen.findByRole('log', { name: '对话记录' }));
  const answer = await transcript.findByText('SYNTHETIC EARLIER ANSWER');
  expect(invoke.mock.calls.filter(([command]) => command.type === 'chat.history')).toEqual([
    [{ type: 'chat.history', bot: 'a', revision: 0, before: undefined }],
  ]);
  expect(transcript.queryByRole('button', { name: '安排今天的工作' })).not.toBeInTheDocument();
  const paginate = transcript.getByRole('button', { name: '加载更早消息' });
  expect(paginate.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(paginate);
  expect(transcript.queryByRole('button', { name: '加载更早消息' })).not.toBeInTheDocument();
});

it('shows only welcome content when the initial history page is empty', async () => {
  const state = demoState();
  state.panel = null;
  state.messages.research = [];
  localStorage.setItem(storageKey, serialize(state));
  const invoke = bridge(ready());
  render(<App />);

  await waitFor(() =>
    expect(invoke.mock.calls.filter(([command]) => command.type === 'chat.history')).toHaveLength(
      1,
    ),
  );
  expect(await screen.findByRole('button', { name: '安排今天的工作' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '加载更早消息' })).not.toBeInTheDocument();
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
  async function openTopic(number: string) {
    await userEvent.click(await screen.findByRole('button', { name: '更多操作' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '历史对话' }));
    const dialog = within(screen.getByRole('dialog'));
    await dialog.findByRole('button', { name: '继续此对话' });
    const field = dialog.getByRole('textbox', { name: '对话编号' });
    if ((field as HTMLInputElement).value !== number) {
      await userEvent.clear(field);
      await userEvent.type(field, number);
      await userEvent.click(dialog.getByRole('button', { name: '读取记录' }));
    }
    await userEvent.click(await dialog.findByRole('button', { name: '继续此对话' }));
  }
  await openTopic('1');
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'SYNTHETIC DRAFT');
  await openTopic('2');
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
  await openTopic('1');
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
  await openTopic('1');
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue(
    'SYNTHETIC OLD TOPIC DRAFT',
  );
});
