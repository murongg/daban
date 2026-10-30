import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from './fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  agentId,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { demoState as initialState } from './fixtures';
import { restore, serialize, storageKey } from './storage';

afterEach(() => {
  Reflect.deleteProperty(window, 'daban');
  vi.restoreAllMocks();
});

function connect() {
  const state = initialState();
  state.panel = null;
  localStorage.setItem(storageKey, serialize(state));
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = 33;
  snapshot.notices = {
    available: true,
    items: [{ kind: 'task', id: 'mock-old', bot: 'b', chatRevision: 0, phase: 'completed' }],
  };
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
  let listener: (value: RuntimeSnapshot) => unknown = () => {};
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      if (command.type === 'status' || command.type === 'connect')
        return { ok: true, value: snapshot as T };
      return { ok: false, error: 'MOCK_UNEXPECTED_COMMAND' };
    },
    subscribe: (callback) => {
      listener = callback;
      return () => {};
    },
  };
  const invoke = vi.spyOn(bridge, 'invoke');
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  return {
    invoke,
    snapshot: () => snapshot,
    emit: (next: RuntimeSnapshot) => {
      snapshot = next;
      listener(next);
    },
  };
}

it('does not mark initial history unread, marks fresh private/group work and clears only the selected conversation', async () => {
  const fake = connect();
  render(<App />);
  await waitFor(() => expect(fake.invoke).toHaveBeenCalled());
  expect(screen.queryByRole('status', { name: '写作搭档有未读消息' })).not.toBeInTheDocument();
  const next: RuntimeSnapshot = {
    ...fake.snapshot(),
    notices: {
      available: true,
      items: [
        ...fake.snapshot().notices!.items,
        { kind: 'task', id: 'mock-private-new', bot: 'b', chatRevision: 0, phase: 'completed' },
        { kind: 'group', id: 'mock-group-new', group: 'crew', phase: 'completed' },
      ],
    },
  };
  await act(() => fake.emit(next));
  expect(await screen.findByRole('status', { name: '写作搭档有未读消息' })).toBeVisible();
  expect(screen.getByRole('status', { name: '周报协作有未读消息' })).toBeVisible();
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '写作搭档' }));
  await act(() => fake.emit({ ...next }));
  expect(screen.queryByRole('status', { name: '写作搭档有未读消息' })).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: '周报协作有未读消息' })).toBeVisible();
  expect(fake.invoke.mock.calls.map(([command]) => command.type)).toEqual(['status']);
});

it('keeps manual unread across reconstruction and unavailable feeds, and treats group questions as group attention', async () => {
  const fake = connect();
  const { unmount } = render(<App />);
  await waitFor(() => expect(fake.invoke).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: '整理 写作搭档' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '标为未读' }));
  await act(() => fake.emit({ ...fake.snapshot(), phase: 'offline', notices: undefined }));
  unmount();
  render(<App />);
  expect(await screen.findByRole('status', { name: '写作搭档有未读消息' })).toBeVisible();
  await act(() =>
    fake.emit({
      ...fake.snapshot(),
      phase: 'ready',
      notices: { available: true, items: [] },
      interactions: [
        {
          id: 'mock-group-question',
          sessionId: 'mock-session',
          bot: 'a',
          runId: 'mock-group-run',
          conversationId: 'crew',
          kind: 'question',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          questions: [{ id: 'mock-choice', question: '选择合成格式？' }],
        },
      ],
    }),
  );
  expect(await screen.findByRole('status', { name: '周报协作有未读消息' })).toBeVisible();
  expect(screen.queryByRole('status', { name: '研究员有未读消息' })).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: '写作搭档有未读消息' })).toBeVisible();
  expect(fake.invoke.mock.calls.every(([command]) => command.type === 'status')).toBe(true);
});

it('does not read a new result hidden behind an editor, and reads the visible conversation on focus', async () => {
  const fake = connect();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  const view = render(<App />, { container: root });
  try {
    await waitFor(() =>
      expect(restore(localStorage.getItem(storageKey)).organization.attention.initialized).toBe(
        true,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: '新建分组' }));
    const next: RuntimeSnapshot = {
      ...fake.snapshot(),
      notices: {
        available: true,
        items: [
          { kind: 'task', id: 'mock-obscured', bot: 'a', chatRevision: 0, phase: 'completed' },
        ],
      },
    };
    await act(() => fake.emit(next));
    fireEvent(window, new Event('focus'));
    expect(restore(localStorage.getItem(storageKey)).organization.attention.unread).toContain(
      'research',
    );
    await userEvent.click(
      within(screen.getByRole('dialog', { name: '新建分组' })).getByRole('button', {
        name: '取消',
      }),
    );
    fireEvent(window, new Event('focus'));
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: '研究员有未读消息' })).not.toBeInTheDocument(),
    );
    await act(() =>
      fake.emit({
        ...next,
        notices: {
          available: true,
          items: [
            ...next.notices!.items,
            { kind: 'task', id: 'mock-visible', bot: 'a', chatRevision: 0, phase: 'completed' },
          ],
        },
      }),
    );
    expect(screen.queryByRole('status', { name: '研究员有未读消息' })).not.toBeInTheDocument();
    expect(fake.invoke.mock.calls.every(([command]) => command.type === 'status')).toBe(true);
  } finally {
    view.unmount();
    root.remove();
  }
});

it('searches genuine cached conversation text without presenting shipped demonstration previews as runtime history', async () => {
  const fake = connect();
  const state = restore(localStorage.getItem(storageKey));
  state.bots.find((bot) => bot.id === 'research')!.preview = 'MOCK-DEMO-PREVIEW';
  state.messages.research[0].text = 'MOCK-DEMO-BODY';
  state.messages.writer.push({
    id: 'mock-genuine-result',
    role: 'bot',
    text: 'MOCK-GENUINE-SEARCH',
  });
  localStorage.setItem(storageKey, serialize(state));
  render(<App />);
  await waitFor(() => expect(fake.invoke).toHaveBeenCalled());
  const search = screen.getByRole('searchbox', { name: '搜索 Bot 和对话' });
  await userEvent.type(search, 'MOCK-DEMO');
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  expect(within(nav).queryByRole('button', { name: '研究员' })).not.toBeInTheDocument();
  await userEvent.clear(search);
  await userEvent.type(search, 'MOCK-GENUINE');
  expect(within(nav).getByRole('button', { name: '写作搭档' })).toBeVisible();
});
