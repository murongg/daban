import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';
import { findSelectControl, selectControl, selectOption } from '../../test/select.fixture.ts';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  disconnected,
  type Group,
  type GroupMessage,
  type GroupPage,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { reduce } from '../../app/state';
import { restore, serialize, storageKey } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';

afterEach(() => Reflect.deleteProperty(window, 'daban'));
const group: Group = {
  id: 'crew',
  name: '周报协作',
  members: ['chief', 'a', 'b'],
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
it('retains group history/drafts/members across archived metadata and persists only a scoped unresolved action', () => {
  let state = initialState();
  state.drafts.crew = 'SYNTHETIC RETAINED GROUP DRAFT';
  const messages = structuredClone(state.messages.crew),
    members = state.bots.find((bot) => bot.id === 'crew')!.members;
  state = reduce(state, { type: 'groups', groups: [{ ...group, revision: 2, archived: true }] });
  expect(state.bots.find((bot) => bot.id === 'crew')?.archived).toBe(true);
  expect(state.bots.find((bot) => bot.id === 'crew')?.members).toEqual(members);
  expect(state.messages.crew).toEqual(messages);
  expect(state.drafts.crew).toBe('SYNTHETIC RETAINED GROUP DRAFT');
  const request = {
    id: 'mock-group-restore',
    group: 'crew',
    revision: 2,
    action: 'restore' as const,
  };
  state = reduce(state, { type: 'group-action-pending', request });
  state = reduce(state, {
    type: 'group-action-pending',
    request: { ...request, id: 'mock-unrelated' },
  });
  expect(state.groupActions.crew).toEqual(request);
  state = reduce(state, { type: 'group-action-clear', group: 'crew', id: 'mock-unrelated' });
  const reopened = restore(serialize(state));
  expect(reopened.groupActions.crew).toEqual(request);
  expect(reopened.drafts.crew).toBe('SYNTHETIC RETAINED GROUP DRAFT');
  const saved = JSON.parse(serialize(state));
  saved.state.groupActions.crew = { ...request, eraseFiles: true };
  const damaged = restore(JSON.stringify(saved));
  expect(damaged.groupActions.crew).toBeUndefined();
  expect(damaged.drafts.crew).toBe('SYNTHETIC RETAINED GROUP DRAFT');
});
it('retains group drafts while a global recovery fence blocks new collaboration', async () => {
  const fake = connect(false, true);
  const state = initialState();
  state.selected = 'crew';
  state.panel = null;
  state.drafts.crew = 'SYNTHETIC-QUEUED-DRAFT';
  localStorage.setItem(storageKey, serialize(state));
  render(<App />);
  const input = await screen.findByRole('textbox', { name: '发送消息' });
  expect(input).toHaveValue('SYNTHETIC-QUEUED-DRAFT');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(fake.invoke.mock.calls.some(([command]) => command.type === 'group.send')).toBe(false);
});
function connect(archived = false, recovering = false, protocol = 15) {
  let snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  if (recovering) snapshot.reboot = { available: false, error: 'RECOVERY_HOST_STORE_UNAVAILABLE' };
  snapshot.model = {
    configured: true,
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 0,
  };
  const base = initialState();
  snapshot.profiles = base.bots
    .filter((bot) => !bot.members)
    .map((bot) => ({
      id: bot.id === 'research' ? 'a' : bot.id === 'writer' ? 'b' : bot.id,
      name: bot.name,
      instructions: bot.role,
      memory: '',
      color: bot.color,
      revision: archived && bot.id === 'research' ? 3 : 1,
      ...(archived && bot.id === 'research'
        ? {
            archived: true,
            lifecycle: {
              id: 'mock-group-archived',
              action: 'archive' as const,
              phase: 'complete' as const,
              baseRevision: 1,
            },
          }
        : {}),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
  snapshot.groups = { available: true, revision: 1, items: [group] };
  let page: GroupPage = { group, revision: 1, messages: [], deliveries: [] };
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  let rejectNext = false;
  const publish = () => {
    snapshot = { ...snapshot };
    for (const listener of listeners) listener(snapshot);
  };
  const invoke = vi.fn(async (command: RuntimeCommand): Promise<RuntimeReply> => {
    if (command.type === 'group.action') {
      const current = { ...page.group, revision: command.request.revision + 1 };
      if (command.request.action === 'archive') current.archived = true;
      else delete current.archived;
      page = { ...page, group: current };
      snapshot.groups = { available: true, revision: current.revision, items: [current] };
      publish();
      return {
        ok: true,
        value: {
          group: current,
          receipt: {
            request: command.request,
            revision: current.revision,
            completedAt: group.createdAt,
          },
        },
      };
    }
    if (command.type === 'group.read')
      return {
        ok: true,
        value: command.before
          ? {
              ...page,
              messages: [
                {
                  id: 'mock-old-page',
                  group: group.id,
                  sequence: 1,
                  sourceId: 'mock-old-page',
                  role: 'user',
                  text: '合成更早记录 OLD-31',
                  createdAt: group.createdAt,
                },
              ],
              nextBefore: undefined,
            }
          : page,
      };
    if (command.type === 'group.register')
      return { ok: true, value: { ...group, ...command.group } };
    if (command.type === 'group.update') {
      const updated = { ...group, ...command.input, revision: command.revision + 1 };
      page = { ...page, group: updated };
      snapshot.groups = { available: true, revision: 2, items: [updated] };
      publish();
      return { ok: true, value: updated };
    }
    if (command.type === 'bot.register')
      return {
        ok: true,
        value: {
          ...command.profile,
          revision: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      };
    if (command.type === 'group.send') {
      const existing = page.messages.find((message) => message.id === command.input.id);
      const user: GroupMessage = existing || {
        id: command.input.id,
        group: group.id,
        sequence: page.messages.length + 1,
        sourceId: command.input.id,
        role: 'user',
        text: command.input.prompt,
        createdAt: '2026-01-01T00:00:00Z',
      };
      if (!existing) {
        const reply: GroupMessage = {
          id: `mock-reply-${page.messages.length}`,
          group: group.id,
          sequence: user.sequence + 1,
          sourceId: user.id,
          role: 'bot',
          author: 'a',
          name: '研究员',
          text: '合成群回复 GROUP-47',
          phase: 'completed',
          model: 'deepseek-flash',
          createdAt: '2026-01-01T00:00:00Z',
        };
        page = { ...page, revision: page.revision + 1, messages: [...page.messages, user, reply] };
        snapshot.groups = { ...snapshot.groups!, revision: page.revision };
        snapshot.agents.a = {
          running: false,
          phase: 'completed',
          conversationId: group.id,
          runId: 'mock-group-run',
          requestId: 'mock-group-request',
          prompt: command.input.prompt,
          result: reply.text,
          error: '',
          files: [],
          toolCount: 0,
          executedCount: 0,
          trace: [],
          history: [],
        };
        publish();
      }
      if (rejectNext) {
        rejectNext = false;
        return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
      }
      return { ok: true, value: { ...page, accepted: user } };
    }
    return { ok: true, value: command.type === 'status' ? snapshot : {} };
  });
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      platform: 'darwin',
      runtime: {
        invoke,
        subscribe: (listener: (snapshot: RuntimeSnapshot) => unknown) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as unknown as RuntimeBridge,
    },
  });
  return {
    invoke,
    history: () => {
      page = {
        ...page,
        messages: [
          {
            id: 'mock-current-page',
            group: group.id,
            sequence: 50,
            sourceId: 'mock-current-page',
            role: 'user',
            text: '合成当前记录 NOW-50',
            createdAt: group.createdAt,
          },
        ],
        nextBefore: 50,
      };
      publish();
    },
    update: () => {
      page = { ...page, revision: page.revision + 1 };
      snapshot.groups = { ...snapshot.groups!, revision: page.revision };
      publish();
    },
    failNext: () => {
      rejectNext = true;
    },
  };
}
function seed(draft = '合成未发送群消息') {
  const state = initialState();
  state.selected = 'crew';
  state.panel = null;
  state.drafts.crew = draft;
  localStorage.setItem(storageKey, serialize(state));
}
it('archives a group from its header, keeps history and drafts readable, and restores from settings without sending', async () => {
  seed('SYNTHETIC GROUP DRAFT');
  const backend = connect(false, false, 28);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '归档群聊' }));
  await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
  expect(await screen.findByText('已归档 · 历史只读')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC GROUP DRAFT');
  expect(screen.getByRole('textbox', { name: '发送消息' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '编辑群聊' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '添加附件' })).toBeDisabled();
  expect(screen.getByText('群聊已归档，历史和草稿保留。恢复后可发送新协作。')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('tab', { name: '归档管理' }));
  await userEvent.click(await screen.findByRole('button', { name: '恢复 周报协作' }));
  await userEvent.click(screen.getByRole('button', { name: '确认恢复' }));
  await userEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  await userEvent.click(screen.getByRole('button', { name: '周报协作' }));
  expect(await screen.findByRole('textbox', { name: '发送消息' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('SYNTHETIC GROUP DRAFT');
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'group.send')).toBe(false);
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'group.action'),
  ).toHaveLength(2);
});
it('keeps the existing group draft unsent, routes an explicit receiver and never ingests group output into a DM', async () => {
  seed();
  const backend = connect();
  render(<App />);
  await findSelectControl('发送给');
  expect(screen.getByText('群聊 · 已连接')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('合成未发送群消息');
  expect(backend.invoke.mock.calls.some(([command]) => command.type === 'group.send')).toBe(false);
  await selectOption(userEvent, selectControl('发送给'), 'a');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByText('合成群回复 GROUP-47')).toBeVisible();
  const send = backend.invoke.mock.calls
    .map(([command]) => command)
    .find((command) => command.type === 'group.send');
  expect(send).toMatchObject({
    input: { group: 'crew', prompt: '合成未发送群消息', recipients: ['a'] },
  });
  const nav = screen.getByRole('navigation', { name: 'Bot 列表' });
  await userEvent.click(within(nav).getByRole('button', { name: '研究员' }));
  expect(screen.queryByText('合成群回复 GROUP-47')).not.toBeInTheDocument();
  const stored = JSON.parse(localStorage.getItem(storageKey)!);
  expect(JSON.stringify(stored.state.messages.research)).not.toContain('GROUP-47');
});

it('excludes archived members from an explicit all-available send while keeping historical identity', async () => {
  const f = connect(true);
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: group.name }));
  await findSelectControl('发送给');
  await selectOption(userEvent, selectControl('发送给'), '*');
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '合成只发给可用成员');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  const command = f.invoke.mock.calls
    .map(([command]) => command)
    .find((command) => command.type === 'group.send');
  expect(command).toMatchObject({
    input: { recipients: group.members.filter((id) => id !== 'a') },
  });
});

it('keeps an archived explicit recipient unresolved instead of silently retargeting the draft', async () => {
  connect(true);
  const state = initialState();
  state.selected = group.id;
  state.groupTargets[group.id] = 'a';
  state.drafts[group.id] = 'SYNTHETIC-KEEP-RECIPIENT-DRAFT';
  localStorage.setItem(storageKey, serialize(state));
  render(<App />);
  const target = await findSelectControl('发送给');
  expect(target).toHaveAttribute('data-value', 'a');
  expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue(state.drafts[group.id]);
});

it('leaves archived identities out of new group member selection', async () => {
  connect(true);
  render(<App />);
  await screen.findByText('此 Bot 已归档，历史和未发送草稿保留。');
  await userEvent.click(screen.getByRole('button', { name: '创建 Bot 群聊' }));
  const dialog = await screen.findByRole('dialog', { name: '创建群聊' });
  const name = initialState().bots.find((bot) => bot.id === 'research')!.name;
  expect(
    within(dialog).queryByRole('checkbox', { name: new RegExp(name) }),
  ).not.toBeInTheDocument();
});
it('retains an ambiguous group send across relaunch for an exact manual retry while preserving a new draft', async () => {
  seed('合成原请求');
  const backend = connect();
  backend.failNext();
  let view = render(<App />);
  await findSelectControl('发送给');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByRole('button', { name: '重试发送' });
  await userEvent.clear(screen.getByRole('textbox', { name: '发送消息' }));
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), '合成新草稿');
  view.unmount();
  view = render(<App />);
  await screen.findByRole('button', { name: '重试发送' });
  expect(
    backend.invoke.mock.calls.filter(([command]) => command.type === 'group.send'),
  ).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '重试发送' }));
  const sends = backend.invoke.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'group.send');
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('合成新草稿');
});

it('creates a real group before selecting it and saves member edits against the authoritative revision', async () => {
  seed();
  const backend = connect();
  render(<App />);
  await findSelectControl('发送给');
  await userEvent.click(screen.getByRole('button', { name: '编辑群聊' }));
  let dialog = screen.getByRole('dialog', { name: '编辑群聊' });
  await userEvent.clear(within(dialog).getByRole('textbox', { name: '群聊名称' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: '群聊名称' }), '合成双人协作');
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择 小管家' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '保存群聊' }));
  await screen.findByRole('heading', { name: '合成双人协作' });
  expect(backend.invoke.mock.calls.map(([c]) => c)).toContainEqual({
    type: 'group.update',
    group: 'crew',
    revision: 1,
    input: { name: '合成双人协作', members: ['a', 'b'] },
  });
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('合成未发送群消息');
  await userEvent.click(screen.getByRole('button', { name: '创建 Bot 群聊' }));
  dialog = screen.getByRole('dialog', { name: '创建群聊' });
  await userEvent.type(within(dialog).getByRole('textbox', { name: '名称' }), '合成新群');
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择 研究员' }));
  await userEvent.click(within(dialog).getByRole('checkbox', { name: '选择 写作搭档' }));
  await userEvent.click(within(dialog).getByRole('button', { name: '创建群聊' }));
  await screen.findByRole('heading', { name: '合成新群' });
  expect(
    backend.invoke.mock.calls.map(([c]) => c).filter((c) => c.type === 'group.register'),
  ).toContainEqual(
    expect.objectContaining({
      group: expect.objectContaining({ name: '合成新群', members: ['a', 'b'] }),
    }),
  );
});

it('keeps loaded older messages visible when a later group poll arrives', async () => {
  seed();
  const backend = connect();
  backend.history();
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '加载更早的消息' }));
  expect(await screen.findByText('合成更早记录 OLD-31')).toBeVisible();
  backend.update();
  await screen.findByText('合成当前记录 NOW-50');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText('合成更早记录 OLD-31')).toBeVisible();
});
