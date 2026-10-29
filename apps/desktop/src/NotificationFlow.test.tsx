import {
  agentId,
  disconnected,
  type Interaction,
  type RuntimeBridge,
  type RuntimeCommand,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  NoticeActivation,
  NoticeBridge,
  NoticeCommand,
  NoticeMessage,
} from '../notifications';
import { App } from './App';
import { initialState } from './state';
import { serialize, storageKey } from './storage';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
function connect(interactions: Interaction[] = [], withGroup = false) {
  const state = initialState();
  state.panel = null;
  state.drafts.research = 'SYNTHETIC RESEARCH DRAFT';
  state.drafts.writer = 'SYNTHETIC WRITER DRAFT';
  localStorage.setItem(storageKey, serialize(state));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 30;
  snapshot.chats = { available: true, revision: 0, items: [] };
  snapshot.notices = { available: true, items: [] };
  snapshot.interactions = interactions;
  const group = {
    id: 'crew',
    name: '周报协作',
    members: ['chief', 'a', 'b'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  if (withGroup) snapshot.groups = { available: true, revision: 1, items: [group] };
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
  const runtime = vi.fn(async (command: RuntimeCommand) => ({
    ok: true,
    value:
      command.type === 'status'
        ? snapshot
        : command.type === 'chat.history'
          ? {
              bot: command.bot,
              revision: command.revision,
              items: [
                {
                  chatRevision: command.revision,
                  runId: 'mock-result-run',
                  requestId: 'mock-result-request',
                  prompt: 'SYNTHETIC QUESTION',
                  phase: 'completed',
                  result: 'SYNTHETIC NOTIFICATION RESULT',
                  error: '',
                },
              ],
            }
          : command.type === 'group.read'
            ? { group, revision: 1, messages: [], deliveries: [] }
            : {},
  }));
  const listeners = new Set<(value: NoticeMessage) => unknown>();
  const native = vi.fn(async (command: NoticeCommand) => ({
    ok: true,
    value:
      command.type === 'status'
        ? {
            available: true,
            supported: true,
            enabled: false,
            revision: 0,
            delivery: 'untried',
            runtime: 'ready',
          }
        : undefined,
  }));
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: { invoke: runtime, subscribe: () => () => {} } as unknown as RuntimeBridge,
      notifications: {
        invoke: native,
        subscribe: (listener: (value: NoticeMessage) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as NoticeBridge,
    },
  });
  return {
    runtime,
    native,
    emit: (activation: NoticeActivation) => {
      for (const listener of listeners) listener({ type: 'navigate', activation });
    },
  };
}
it('opens the exact read-only task result and never submits a model task or approval', async () => {
  const backend = connect();
  render(<App />);
  await screen.findByRole('heading', { name: '研究员' });
  await act(async () =>
    backend.emit({
      id: 'mock-notification',
      scope: 'a'.repeat(64),
      target: {
        kind: 'task',
        id: 'mock-result-run',
        bot: 'b',
        chatRevision: 0,
        phase: 'completed',
      },
    }),
  );
  expect(await screen.findByText('SYNTHETIC NOTIFICATION RESULT')).toBeVisible();
  expect(backend.runtime.mock.calls.map(([command]) => command)).toContainEqual({
    type: 'chat.history',
    bot: 'b',
    revision: 0,
    before: undefined,
    runId: 'mock-result-run',
  });
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: '关闭对话框' }),
  );
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC WRITER DRAFT');
  expect(
    backend.runtime.mock.calls.some(([command]) =>
      ['task.start', 'interaction.reply'].includes(command.type),
    ),
  ).toBe(false);
  await waitFor(() =>
    expect(backend.native).toHaveBeenCalledWith({ type: 'ack', id: 'mock-notification' }),
  );
});
it('defers notification navigation while an editor dialog owns unsaved input', async () => {
  const backend = connect();
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '编辑 Bot 资料' }));
  const dialog = screen.getByRole('dialog'),
    name = within(dialog).getByRole('textbox', { name: '名称' });
  await userEvent.clear(name);
  await userEvent.type(name, 'SYNTHETIC EDIT NOT SAVED');
  await act(async () =>
    backend.emit({
      id: 'mock-settings-notice',
      scope: 'a'.repeat(64),
      target: { kind: 'settings' },
    }),
  );
  expect(name).toHaveValue('SYNTHETIC EDIT NOT SAVED');
  expect(dialog).toBeVisible();
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭对话框' }));
  expect(await screen.findByRole('heading', { name: '设置', level: 1 })).toBeVisible();
});
it('opens exactly the requested attention card without approving anything', async () => {
  const base = {
    bot: 'b',
    runId: 'mock-attention-run',
    sessionId: 'mock-session',
    status: 'pending' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const backend = connect([
    {
      ...base,
      id: 'mock-needed',
      kind: 'question',
      questions: [{ id: 'mock-q', question: 'SYNTHETIC TARGET QUESTION' }],
    },
    {
      ...base,
      id: 'mock-other',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/not-target',
    },
  ]);
  render(<App />);
  await screen.findByRole('heading', { name: '研究员' });
  await act(async () =>
    backend.emit({
      id: 'mock-question-notice',
      scope: 'a'.repeat(64),
      target: { kind: 'question', id: 'mock-needed', bot: 'b', runId: 'mock-attention-run' },
    }),
  );
  expect(await screen.findByText('SYNTHETIC TARGET QUESTION')).toBeVisible();
  expect(screen.queryByRole('button', { name: '仅允许这一次' })).not.toBeInTheDocument();
  expect(backend.runtime.mock.calls.some(([command]) => command.type === 'interaction.reply')).toBe(
    false,
  );
});
it('opens a group outcome in that group without sending another collaboration', async () => {
  const backend = connect([], true);
  render(<App />);
  await screen.findByRole('heading', { name: '研究员' });
  await act(async () =>
    backend.emit({
      id: 'mock-group-notice',
      scope: 'a'.repeat(64),
      target: { kind: 'group', id: 'mock-turn', group: 'crew', phase: 'completed' },
    }),
  );
  expect(await screen.findByRole('heading', { name: '周报协作', level: 1 })).toBeVisible();
  expect(
    backend.runtime.mock.calls.some(
      ([command]) => command.type === 'group.send' || command.type === 'task.start',
    ),
  ).toBe(false);
});
