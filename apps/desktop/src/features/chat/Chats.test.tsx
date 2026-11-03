import type { ChatRequest, ChatState } from '@daban/protocol';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { expect, it, vi } from 'vitest';
import { chatRevision, reduce, type State } from '../../app/state';
import { restore, serialize } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';
import { ChatHistory } from './ChatHistory';
import { NewChat } from './NewChat';

const mock = vi.hoisted(() => ({
  command: vi.fn(),
  snapshot: {
    phase: 'ready',
    protocolVersion: 29,
    agents: {},
    bots: {},
    chats: { available: true, revision: 0, items: [] as ChatState[] },
  },
}));
vi.mock('../../app/Runtime', () => ({
  runtimeError: (error: Error) => error.message,
  useRuntime: () => ({ enabled: true, snapshot: mock.snapshot, command: mock.command }),
}));
let saved: State;
function Harness({
  seed = initialState(),
  close = () => {},
}: {
  seed?: State;
  close?: () => unknown;
}) {
  const [state, dispatch] = useReducer(reduce, seed);
  saved = state;
  return (
    <NewChat
      state={state}
      bot={state.bots.find((bot) => bot.id === 'research')!}
      dispatch={dispatch}
      close={close}
      notify={() => {}}
    />
  );
}
it('preserves draft/history/attachments, stores one unresolved request and reconciles it after reopen without sending', async () => {
  const seed = initialState();
  seed.drafts.research = 'SYNTHETIC RETAINED DRAFT';
  const messages = structuredClone(seed.messages.research),
    attachments = [...seed.attachments.research];
  let request: ChatRequest | undefined;
  mock.command.mockImplementation(async (command) => {
    if (command.type === 'chat.new') {
      request = command.request;
      throw new Error('RUNTIME_TIMEOUT');
    }
    return {
      chat: { bot: 'a', revision: 1, updatedAt: '2026-01-01T00:00:00Z' },
      receipt: { request, revision: 1, completedAt: '2026-01-01T00:00:00Z' },
    };
  });
  const view = render(<Harness seed={seed} />);
  await userEvent.click(screen.getByRole('button', { name: '确认开启' }));
  await screen.findByRole('button', { name: '核对操作结果' });
  const reopened = restore(serialize(saved));
  view.unmount();
  const close = vi.fn();
  render(<Harness seed={reopened} close={close} />);
  await userEvent.click(screen.getByRole('button', { name: '核对操作结果' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(chatRevision(saved, 'research')).toBe(1);
  expect(saved.chatRequests.research).toBeUndefined();
  expect(saved.messages.research).toEqual(messages);
  expect(saved.attachments.research).toEqual(attachments);
  expect(saved.drafts.research).toBe('SYNTHETIC RETAINED DRAFT');
  expect(mock.command.mock.calls.filter(([command]) => command.type === 'chat.new')).toHaveLength(
    1,
  );
  expect(mock.command.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
});
it('keeps acknowledged newer metadata when an older poll returns and never replaces an unresolved action', () => {
  let state = initialState();
  const chat = { bot: 'a', revision: 2, updatedAt: '2026-01-01T00:00:00Z' };
  state = reduce(state, { type: 'chats', items: [chat] });
  state = reduce(state, { type: 'chats', items: [{ ...chat, revision: 1 }] });
  const request = { bot: 'a', id: 'mock-chat', revision: 2 };
  state = reduce(state, { type: 'chat-pending', bot: 'research', request });
  state = reduce(state, {
    type: 'chat-pending',
    bot: 'research',
    request: { ...request, id: 'mock-replacement' },
  });
  state = reduce(state, { type: 'chat-clear', bot: 'research', id: 'mock-wrong' });
  expect(chatRevision(state, 'research', mock.snapshot.chats)).toBe(2);
  expect(restore(serialize(state)).chatRequests.research).toEqual(request);
});
it('reconciles an accepted old request after a new boundary without clearing the current draft or attachments', () => {
  let state = initialState();
  state.drafts.research = 'SYNTHETIC SAME DRAFT';
  state.runtimeRequests.research = {
    requestId: 'mock-old-accepted',
    prompt: 'SYNTHETIC SAME DRAFT',
    chatRevision: 0,
  };
  const attachments = [...state.attachments.research];
  state = reduce(state, {
    type: 'chats',
    items: [{ bot: 'a', revision: 1, updatedAt: '2026-01-01T00:00:00Z' }],
  });
  state = reduce(state, {
    type: 'runtime-task',
    bot: 'research',
    task: {
      runId: 'mock-old-run',
      requestId: 'mock-old-accepted',
      prompt: 'SYNTHETIC SAME DRAFT',
      result: 'SYNTHETIC OLD RESULT',
      error: '',
      phase: 'completed',
      chatRevision: 0,
    },
  });
  expect(state.runtimeRequests.research).toBeUndefined();
  expect(state.drafts.research).toBe('SYNTHETIC SAME DRAFT');
  expect(state.attachments.research).toEqual(attachments);
});
it('reads complete older conversation pages in explicit scope without running or restoring them', async () => {
  mock.command.mockImplementation(async (command) => ({
    bot: command.bot,
    revision: command.revision,
    items: [
      {
        chatRevision: command.revision,
        runId: 'mock-old-run',
        requestId: 'mock-old-request',
        prompt: 'SYNTHETIC OLD QUESTION',
        result: 'SYNTHETIC OLD ANSWER',
        error: '',
        phase: 'completed',
      },
    ],
    nextBefore: command.before ? undefined : 'mock-old-run',
  }));
  const state = initialState();
  render(
    <ChatHistory
      bot={state.bots.find((bot) => bot.id === 'research')!}
      revision={2}
      close={() => {}}
      notify={() => {}}
      preview={() => {}}
    />,
  );
  expect(await screen.findByText('SYNTHETIC OLD ANSWER')).toBeVisible();
  expect(mock.command).toHaveBeenLastCalledWith({
    type: 'chat.history',
    bot: 'a',
    revision: 1,
    before: undefined,
  });
  await userEvent.click(screen.getByRole('button', { name: '更早记录' }));
  await waitFor(() =>
    expect(mock.command).toHaveBeenLastCalledWith({
      type: 'chat.history',
      bot: 'a',
      revision: 1,
      before: 'mock-old-run',
    }),
  );
  expect(
    mock.command.mock.calls.some(([command]) => ['task.start', 'chat.new'].includes(command.type)),
  ).toBe(false);
});
it('previews files linked from earlier inserted turn replies', async () => {
  mock.command.mockResolvedValue({
    bot: 'a',
    revision: 1,
    items: [
      {
        chatRevision: 1,
        runId: 'mock-history-turns',
        requestId: 'mock-history-primary',
        prompt: 'SYNTHETIC FIRST REQUEST',
        result: 'SYNTHETIC SECOND ANSWER',
        error: '',
        phase: 'completed',
        files: [
          {
            path: 'model-runs/mock-history-turns/a/report.md',
            name: 'report.md',
            size: 20,
            modified: '2026-01-01',
          },
        ],
        turns: [
          {
            id: 'mock-history-primary',
            prompt: 'SYNTHETIC FIRST REQUEST',
            result: '已生成 [报告](report.md)',
          },
          {
            id: 'mock-history-inserted',
            prompt: 'SYNTHETIC SECOND REQUEST',
            result: 'SYNTHETIC SECOND ANSWER',
          },
        ],
      },
    ],
  });
  const state = initialState();
  const preview = vi.fn();
  render(
    <ChatHistory
      bot={state.bots.find((bot) => bot.id === 'research')!}
      revision={2}
      close={() => {}}
      notify={() => {}}
      preview={preview}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '报告' }));
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({ runtimePath: 'model-runs/mock-history-turns/a/report.md' }),
  );
});
it('retains local user cache without presenting shipped demo replies as real historical work', async () => {
  const state = initialState();
  mock.command.mockResolvedValue({ bot: 'a', revision: 0, items: [] });
  const cached = [
    ...state.messages.research,
    { id: 'mock-user-cache', role: 'user' as const, text: 'SYNTHETIC LOCAL USER CACHE' },
  ];
  render(
    <ChatHistory
      bot={state.bots.find((bot) => bot.id === 'research')!}
      revision={1}
      cached={cached}
      close={() => {}}
      notify={() => {}}
      preview={() => {}}
    />,
  );
  await screen.findByText('这次对话没有已保存的任务记录。');
  expect(screen.queryByText('SYNTHETIC LOCAL USER CACHE')).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('本机旧缓存（可能与后端记录重复）'));
  expect(screen.getByText('SYNTHETIC LOCAL USER CACHE')).toBeVisible();
  expect(screen.queryByText(state.messages.research[0].text)).not.toBeInTheDocument();
});
