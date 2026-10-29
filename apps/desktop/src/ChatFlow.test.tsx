import {
  agentId,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { initialState } from './state';
import { serialize, storageKey } from './storage';

afterEach(() => Reflect.deleteProperty(window, 'daban'));

it('starts a new model conversation, retains and reads the old transcript, and sends the preserved draft only on explicit submit', async () => {
  const state = initialState();
  state.panel = null;
  state.drafts.research = 'SYNTHETIC FUTURE DRAFT';
  state.messages.research = [
    { id: 'mock-local-only', role: 'user', text: 'SYNTHETIC LOCAL ONLY' },
    { id: 'mock-old-question', role: 'user', text: 'SYNTHETIC OLD QUESTION' },
    { id: 'mock-old-answer', role: 'bot', text: 'SYNTHETIC CACHED ANSWER' },
  ];
  localStorage.setItem(storageKey, serialize(state));
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 29;
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 1,
  };
  snapshot.chats = { available: true, revision: 0, items: [] };
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
  const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const invoke = vi.fn(async (command: RuntimeCommand) => {
    if (command.type === 'status') return { ok: true, value: snapshot };
    if (command.type === 'chat.new') {
      const chat = { bot: command.request.bot, revision: 1, updatedAt: '2026-01-01T00:00:00Z' };
      snapshot = { ...snapshot, chats: { available: true, revision: 1, items: [chat] } };
      for (const listener of listeners) listener(snapshot);
      return {
        ok: true,
        value: {
          chat,
          receipt: { request: command.request, revision: 1, completedAt: chat.updatedAt },
        },
      };
    }
    if (command.type === 'chat.history')
      return {
        ok: true,
        value: {
          bot: command.bot,
          revision: command.revision,
          items: [
            {
              chatRevision: 0,
              runId: 'mock-old-run',
              requestId: 'mock-old-question',
              prompt: 'SYNTHETIC OLD QUESTION',
              result: 'SYNTHETIC OLD ANSWER',
              phase: 'completed',
              error: '',
            },
          ],
        },
      };
    if (command.type === 'task.start')
      return {
        ok: true,
        value: {
          runId: 'mock-new-run',
          requestId: command.task.requestId,
          prompt: command.task.prompt,
          chatRevision: command.task.chatRevision,
          phase: 'completed',
          running: false,
          result: 'SYNTHETIC NEW ANSWER',
          error: '',
          files: [],
        },
      };
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
      } as unknown as RuntimeBridge,
    },
  });
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '开启新对话' }));
  await userEvent.click(screen.getByRole('button', { name: '确认开启' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByText('SYNTHETIC CACHED ANSWER')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC FUTURE DRAFT');
  expect(invoke.mock.calls.some(([command]) => command.type === 'task.start')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '历史对话' }));
  expect(await screen.findByText('SYNTHETIC OLD ANSWER')).toBeVisible();
  await userEvent.click(screen.getByText('本机旧缓存（可能与后端记录重复）'));
  expect(screen.getByText('SYNTHETIC LOCAL ONLY')).toBeVisible();
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: '关闭对话框' }),
  );
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() =>
    expect(invoke.mock.calls.map(([command]) => command)).toContainEqual({
      type: 'task.start',
      bot: 'a',
      task: expect.objectContaining({ prompt: 'SYNTHETIC FUTURE DRAFT', chatRevision: 1 }),
    }),
  );
});
