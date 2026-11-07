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
async function trash() {
  const recent = await screen.findByRole('navigation', { name: '最近对话列表' });
  await userEvent.click(within(recent).getByRole('button', { name: `整理对话 ${topic}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: '移到回收站' }));
}
it('trashes from the sidebar, undoes, and restores through settings while preserving the old editor', async () => {
  const { invoke } = setup();
  render(<App />);
  await trash();
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
  await trash();
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
  await trash();
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
  const { invoke } = setup({ running: true, selectedRevision: 1 });
  render(<App />);
  await trash();
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
