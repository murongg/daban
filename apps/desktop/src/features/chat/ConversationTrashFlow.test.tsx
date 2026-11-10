import {
  agentId,
  type ConversationAck,
  type ConversationRequest,
  disconnected,
  type RuntimeCommand,
} from '@daban/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { restore, serialize, storageKey } from '../../app/storage';
import { demoState } from '../../test/fixtures';

const topic = 'SYNTHETIC RECOVERABLE TOPIC';
afterEach(() => Reflect.deleteProperty(window, 'daban'));
function setup(
  options: {
    uncertain?: boolean;
    running?: boolean;
    local?: boolean;
    selectedRevision?: number;
  } = {},
) {
  const state = demoState();
  state.panel = null;
  state.messages.research = [
    { id: 'synthetic-topic-message', role: 'user', text: topic, chatRevision: 0 },
  ];
  state.drafts.research = 'SYNTHETIC RETAINED DRAFT';
  if (options.selectedRevision !== undefined)
    state.conversationSelections = { research: options.selectedRevision };
  if (options.local)
    state.bots = state.bots.map((bot) =>
      bot.id === 'research' ? { ...bot, kind: 'chat' as const } : bot,
    );
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 47;
  snapshot.chats = {
    available: true,
    revision: 0,
    items:
      options.selectedRevision === undefined
        ? []
        : [{ bot: agentId('research'), revision: options.selectedRevision }],
    conversations: [],
    lifecycle: [],
  };
  snapshot.profiles = state.bots
    .filter((bot) => !bot.members && !(options.local && bot.id === 'research'))
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
  if (options.running)
    snapshot.agents.a = {
      running: true,
      phase: 'running',
      runId: 'synthetic-running-task',
      requestId: 'synthetic-request',
      prompt: topic,
      chatRevision: 0,
      result: '',
      error: '',
      files: [],
      history: [],
      trace: [],
      toolCount: 0,
      executedCount: 0,
    };
  const receipts = new Map<string, ConversationAck>();
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'bot.register') {
      const profile = {
        ...command.profile,
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      snapshot.profiles.push(profile);
      return { ok: true, value: profile };
    }
    if (command.type === 'chat.history')
      return { ok: true, value: { bot: command.bot, revision: command.revision, items: [] } };
    if (command.type === 'conversation.receipt') {
      const receipt = receipts.get(command.request.id);
      return receipt
        ? { ok: true, value: receipt }
        : { ok: false, error: 'CONVERSATION_RECEIPT_NOT_FOUND' };
    }
    if (command.type === 'conversation.action') {
      // The intent must survive a process exit before the first write leaves the client.
      const saved = restore(localStorage.getItem(storageKey)!);
      expect(Object.values(saved.conversationRequests ?? {})).toContainEqual(command.request);
      const request = command.request;
      const conversation = {
        bot: request.bot,
        revision: request.revision,
        version: request.version + 1,
        trashed: request.action === 'trash',
        title: request.title,
        updatedAt: '2026-01-02T00:00:00Z',
      };
      const chat = { bot: request.bot, revision: 1, updatedAt: conversation.updatedAt };
      const ack = {
        chat,
        conversation,
        receipt: { request, version: conversation.version, completedAt: conversation.updatedAt },
      };
      receipts.set(request.id, ack);
      if (options.uncertain) return { ok: false, error: 'RUNTIME_OFFLINE' };
      snapshot.chats = {
        ...snapshot.chats!,
        revision: conversation.version,
        items: [chat],
        lifecycle: [conversation],
      };
      return { ok: true, value: ack };
    }
    return { ok: true, value: {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: { invoke, subscribe: () => () => {} } },
  });
  return { invoke, snapshot, state };
}
async function trash(from: 'chat' | 'bot' = 'bot') {
  if (from === 'chat') {
    const recent = await screen.findByRole('navigation', { name: '最近对话列表' });
    const row = await within(recent).findByRole('button', { name: new RegExp(`^${topic}`) });
    row.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  } else await userEvent.click(await screen.findByRole('button', { name: '更多操作' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: '移到回收站' }));
}

it('pins and archives the exact conversation locally, and restores it after reopening', async () => {
  const { invoke, snapshot } = setup({ local: true, selectedRevision: 1 });
  const current = 'SYNTHETIC CURRENT TOPIC';
  const bot = agentId('research');
  snapshot.chats!.conversations = [
    { bot, revision: 1, title: current, updatedAt: '2026-01-02T00:00:00Z' },
    { bot, revision: 0, title: topic, updatedAt: '2026-01-01T00:00:00Z' },
  ];
  const view = render(<App />);
  const recent = async () =>
    within(await screen.findByRole('navigation', { name: '最近对话列表' }));
  const title = new RegExp(`^${topic}`);
  const pin = await (await recent()).findByRole('button', {
    name: `置顶 ${topic}`,
    pressed: false,
  });
  await userEvent.click(pin);
  const rows = () => screen.getByRole('navigation', { name: '最近对话列表' });
  expect(rows().querySelector('.recent-conversation')).toHaveTextContent(topic);
  expect(
    (await recent()).getByRole('button', { name: `置顶 ${topic}`, pressed: true }),
  ).toHaveFocus();

  await userEvent.click((await recent()).getByRole('button', { name: `归档 ${topic}` }));
  expect((await recent()).queryByRole('button', { name: title })).not.toBeInTheDocument();
  expect(
    (await recent()).getByRole('button', { name: new RegExp(`^${current}`), current: 'page' }),
  ).toBeInTheDocument();
  view.unmount();
  render(<App />);
  expect((await recent()).queryByRole('button', { name: title })).not.toBeInTheDocument();

  const search = screen.getByRole('searchbox', { name: '搜索 Bot 和对话' });
  await userEvent.type(search, topic);
  expect(await (await recent()).findByRole('button', { name: title })).toBeVisible();
  await userEvent.click((await recent()).getByRole('button', { name: `恢复 ${topic}` }));
  await userEvent.clear(search);
  expect((await recent()).getByRole('button', { name: title })).toBeVisible();
  expect(invoke.mock.calls.some(([command]) => command.type === 'conversation.action')).toBe(false);
});

it('trashes from the sidebar, undoes, and restores through settings while preserving the old editor', async () => {
  const { invoke } = setup({ local: true });
  render(<App />);
  await trash('chat');
  expect(await screen.findByText('对话已移到回收站')).toBeVisible();
  expect(
    within(screen.getByRole('navigation', { name: '最近对话列表' })).queryByText(topic),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: '撤销' }));
  await screen.findByText('对话已恢复');
  expect(
    invoke.mock.calls
      .filter(([command]) => command.type === 'conversation.action')
      .map(([command]) => (command.type === 'conversation.action' ? command.request.action : '')),
  ).toEqual(['trash', 'restore']);
  await userEvent.click(
    within(screen.getByRole('navigation', { name: '最近对话列表' })).getByRole('button', {
      name: new RegExp(`^${topic}`),
    }),
  );
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC RETAINED DRAFT');
  await trash('chat');
  await screen.findByText('对话已移到回收站');
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '对话回收站' }));
  const panel = screen.getByRole('tabpanel', { name: '对话回收站' });
  expect(within(panel).getByText(topic)).toBeVisible();
  await userEvent.click(within(panel).getByRole('button', { name: '恢复对话' }));
  await screen.findByText('对话已恢复');
  expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
});
it('retains an uncertain exact request across reopening and only reads its receipt on explicit verification', async () => {
  const { invoke } = setup({ uncertain: true });
  const view = render(<App />);
  await trash();
  await screen.findByRole('button', { name: '核对操作结果' });
  const pending = Object.values(
    restore(localStorage.getItem(storageKey)!).conversationRequests ?? {},
  )[0] as ConversationRequest;
  expect(pending.action).toBe('trash');
  view.unmount();
  render(<App />);
  await screen.findByRole('button', { name: '新增对话' });
  expect(
    invoke.mock.calls.filter(([command]) => command.type === 'conversation.action'),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '对话回收站' }));
  await userEvent.click(screen.getByRole('button', { name: '核对操作结果' }));
  await screen.findByText('对话已移到回收站');
  expect(
    invoke.mock.calls.filter(([command]) => command.type === 'conversation.action'),
  ).toHaveLength(1);
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'conversation.receipt',
    request: pending,
  });
});
it('protects a running conversation and offers its task without stopping or trashing it', async () => {
  const { invoke } = setup({ running: true });
  render(<App />);
  await trash();
  expect(
    await screen.findByText('这段对话还有任务在运行或等待确认，请在任务结束后整理。'),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '查看任务' }));
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'conversation.action' || command.type === 'task.stop',
    ),
  ).toBe(false);
});
it('registers a local ordinary chat only for the explicit trash action and never starts a task', async () => {
  const { invoke } = setup({ local: true });
  render(<App />);
  await trash('chat');
  await screen.findByText('对话已移到回收站');
  expect(invoke.mock.calls.map(([command]) => command)).toContainEqual(
    expect.objectContaining({
      type: 'bot.register',
      profile: expect.objectContaining({ id: 'a', kind: 'chat' }),
    }),
  );
  expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
});

it('opens the running task conversation when a different topic is selected', async () => {
  const { invoke } = setup({ running: true, selectedRevision: 1, local: true });
  render(<App />);
  await trash('chat');
  await userEvent.click(await screen.findByRole('button', { name: '查看任务' }));
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)!).conversationSelections?.research).toBe(0),
  );
  expect(
    invoke.mock.calls.some(
      ([command]) => command.type === 'conversation.action' || command.type === 'task.stop',
    ),
  ).toBe(false);
});
