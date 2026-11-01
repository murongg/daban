import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from './fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  agentId,
  disconnected,
  type GroupCopyRequest,
  isGroupCopyReceipt,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { demoState as initialState } from './fixtures';
import { restore, serialize, storageKey } from './storage';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'daban');
});
const request: GroupCopyRequest = {
  id: 'mock-group-copy',
  group: 'crew',
  revision: 1,
  name: '合成待确认群聊',
};
const result = (input: GroupCopyRequest) => ({
  request: input,
  state: 'complete',
  group: {
    id: input.id,
    name: input.name,
    members: ['chief', 'a', 'b'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
});
function connect(protocol = 35, pending = false) {
  const seed = initialState();
  seed.panel = null;
  seed.selected = 'crew';
  seed.drafts.crew = 'MOCK-SOURCE-GROUP-DRAFT';
  if (pending) seed.groupCopy = request;
  localStorage.setItem(storageKey, serialize(seed));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.profiles = seed.bots
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
  snapshot.groups = {
    available: true,
    revision: 1,
    items: [
      {
        id: 'crew',
        name: '周报协作',
        members: ['chief', 'a', 'b'],
        revision: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  };
  const copy = vi.fn<(value: GroupCopyRequest) => Promise<unknown>>(async (value) => ({
    ...result(value),
    group: { ...result(value).group, members: [...snapshot.groups!.items[0].members] },
  }));
  const read = vi.fn<(value: GroupCopyRequest) => Promise<unknown>>(async (value) => ({
    request: value,
    state: 'unknown',
  }));
  const calls: RuntimeCommand[] = [],
    listeners = new Set<(value: RuntimeSnapshot) => unknown>();
  const pages = new Map([['crew', snapshot.groups.items[0]]]);
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      calls.push(command);
      if (command.type === 'status') return { ok: true, value: snapshot as T };
      if (command.type === 'group.read')
        return {
          ok: true,
          value: {
            group: pages.get(command.group),
            revision: 1,
            messages: [],
            deliveries: [],
          } as T,
        };
      if (command.type === 'group.copy') {
        const value = await copy(command.request);
        if (isGroupCopyReceipt(value) && value.state === 'complete')
          pages.set(value.group.id, value.group);
        return { ok: true, value: value as T };
      }
      if (command.type === 'group.copy.receipt') {
        const value = await read(command.request);
        if (isGroupCopyReceipt(value) && value.state === 'complete')
          pages.set(value.group.id, value.group);
        return { ok: true, value: value as T };
      }
      return { ok: false, error: 'MOCK_UNEXPECTED_COMMAND' };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  return {
    copy,
    read,
    calls,
    snapshot,
    publish: () => {
      for (const listener of listeners) listener({ ...snapshot });
    },
  };
}
async function openCopy() {
  await userEvent.click(await screen.findByRole('button', { name: '整理 周报协作' }));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '复制群聊' })).toBeEnabled());
  await userEvent.click(screen.getByRole('menuitem', { name: '复制群聊' }));
  return screen.getByRole('dialog', { name: '复制群聊' });
}

it('previews existing members and creates only an independent group while retaining the source draft', async () => {
  const fake = connect();
  render(<App />);
  const dialog = await openCopy();
  const members = within(dialog).getByRole('list', { name: '群聊成员' });
  for (const name of ['小管家', '研究员', '写作搭档'])
    expect(within(members).getByText(name)).toBeVisible();
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  await userEvent.clear(within(dialog).getByRole('textbox', { name: '新群聊名称' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: '新群聊名称' }), '合成空群聊');
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  expect(await screen.findByRole('heading', { name: '合成空群聊' })).toBeVisible();
  expect(fake.copy).toHaveBeenCalledTimes(1);
  const sent = fake.copy.mock.calls[0][0];
  expect(sent).toMatchObject({ group: 'crew', revision: 1, name: '合成空群聊' });
  const saved = restore(localStorage.getItem(storageKey));
  expect(saved.bots.filter((bot) => !bot.members)).toHaveLength(6);
  expect(saved.bots.find((bot) => bot.id === sent.id)?.members).toEqual([
    'chief',
    'research',
    'writer',
  ]);
  expect(saved.drafts.crew).toBe('MOCK-SOURCE-GROUP-DRAFT');
  expect(saved.groupCopy).toBeUndefined();
  expect(
    fake.calls.every((command) =>
      ['status', 'group.read', 'group.copy', 'group.copy.receipt'].includes(command.type),
    ),
  ).toBe(true);
});

it('never registers a placeholder and a closed late completion cannot navigate away or erase a newer private draft', async () => {
  const fake = connect();
  let finish: ((value: unknown) => unknown) | undefined;
  fake.copy.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  const sent = fake.copy.mock.calls[0][0];
  expect(restore(localStorage.getItem(storageKey)).bots.some((bot) => bot.id === sent.id)).toBe(
    false,
  );
  expect(restore(localStorage.getItem(storageKey)).groupCopy).toEqual(sent);
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await userEvent.click(screen.getByRole('button', { name: '写作搭档' }));
  await userEvent.type(screen.getByRole('textbox', { name: '发送消息' }), 'MOCK-NEW-PRIVATE-DRAFT');
  await act(() => finish!(result(sent)));
  expect(screen.getByRole('heading', { name: '写作搭档' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('MOCK-NEW-PRIVATE-DRAFT');
  expect(restore(localStorage.getItem(storageKey)).bots.some((bot) => bot.id === sent.id)).toBe(
    true,
  );
});

it('reopens a durable sealed request through readonly inspection and retries only the exact human-selected operation', async () => {
  const fake = connect(35, true);
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await waitFor(() => expect(fake.read).toHaveBeenCalled());
  expect(fake.copy).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '群聊复制 · 核对进度' }));
  const dialog = screen.getByRole('dialog', { name: '复制群聊' });
  expect(within(dialog).getByText(request.name)).toBeVisible();
  expect(within(dialog).queryByRole('textbox', { name: '新群聊名称' })).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: '重试同一次复制' }));
  expect(fake.copy).toHaveBeenCalledWith(request);
  expect(await screen.findByRole('heading', { name: request.name })).toBeVisible();
});

it('keeps the typed name after a source conflict and refreshes members only on explicit action', async () => {
  const fake = connect();
  fake.copy.mockRejectedValueOnce(new Error('GROUP_CONFLICT'));
  render(<App />);
  const dialog = await openCopy();
  await userEvent.clear(within(dialog).getByRole('textbox', { name: '新群聊名称' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: '新群聊名称' }), '合成保留名称');
  fake.snapshot.groups!.items[0] = {
    ...fake.snapshot.groups!.items[0],
    members: ['chief', 'a'],
    revision: 2,
  };
  await act(() => fake.publish());
  expect(
    within(within(dialog).getByRole('list', { name: '群聊成员' })).getByText('写作搭档'),
  ).toBeVisible();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('textbox', { name: '新群聊名称' })).toHaveValue('合成保留名称'),
  );
  expect(restore(localStorage.getItem(storageKey)).groupCopy).toBeUndefined();
  await userEvent.click(within(dialog).getByRole('button', { name: '载入最新来源' }));
  expect(
    within(within(dialog).getByRole('list', { name: '群聊成员' })).queryByText('写作搭档'),
  ).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  expect(fake.copy.mock.calls[1][0]).toMatchObject({ revision: 2, name: '合成保留名称' });
});

it('does not silently omit unavailable members and does not offer mutation on older runtimes', async () => {
  const fake = connect();
  fake.snapshot.profiles.find((profile) => profile.id === 'b')!.archived = true;
  render(<App />);
  const dialog = await openCopy();
  expect(within(dialog).getByText(/已归档/)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: '创建副本' })).toBeDisabled();
  expect(fake.copy).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  fake.snapshot.protocolVersion = 34;
  await act(() => fake.publish());
  await userEvent.click(screen.getByRole('button', { name: '整理 周报协作' }));
  expect(screen.getByRole('menuitem', { name: '复制群聊' })).toBeDisabled();
});

it('retains a pending request after a temporary member failure or a downgraded command reader', async () => {
  const fake = connect(35, true);
  fake.copy
    .mockRejectedValueOnce(new Error('BOT_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('RUNTIME_TOO_OLD'));
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '群聊复制 · 核对进度' }));
  const dialog = screen.getByRole('dialog', { name: '复制群聊' });
  for (let index = 0; index < 2; index++) {
    await userEvent.click(within(dialog).getByRole('button', { name: '重试同一次复制' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '重试同一次复制' })).toBeEnabled(),
    );
    expect(restore(localStorage.getItem(storageKey)).groupCopy).toEqual(request);
  }
  expect(fake.copy.mock.calls.map(([value]) => value)).toEqual([request, request]);
});

it('refuses creation when local request persistence fails', async () => {
  const fake = connect();
  render(<App />);
  const dialog = await openCopy();
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('MOCK_FULL');
  });
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  expect(fake.copy).not.toHaveBeenCalled();
  expect(within(dialog).getByRole('alert')).toHaveTextContent('无法保存复制请求');
  save.mockRestore();
});

it('keeps a mismatched acknowledgement sealed rather than adopting a foreign copy', async () => {
  const fake = connect();
  fake.copy.mockImplementation(async (input) => ({
    ...result(input),
    request: { ...input, name: '合成不同请求' },
  }));
  render(<App />);
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('alert')).toHaveTextContent('复制回执不匹配'),
  );
  const sent = fake.copy.mock.calls[0][0];
  expect(restore(localStorage.getItem(storageKey)).groupCopy).toEqual(sent);
  expect(restore(localStorage.getItem(storageKey)).bots.some((bot) => bot.id === sent.id)).toBe(
    false,
  );
});

it('can inspect an archived result during recovery without reopening or registering that group', async () => {
  const fake = connect(35, true);
  fake.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
  render(<App />);
  await waitFor(() => expect(fake.read).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: '群聊复制 · 核对进度' }));
  const dialog = screen.getByRole('dialog', { name: '复制群聊' });
  expect(within(dialog).getByRole('button', { name: '重试同一次复制' })).toBeDisabled();
  fake.read.mockImplementation(async (input) => ({
    ...result(input),
    group: { ...result(input).group, archived: true, revision: 2 },
  }));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '核对复制结果' })).toBeEnabled(),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '核对复制结果' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '复制群聊' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('heading', { name: '周报协作' })).toBeVisible();
  const saved = restore(localStorage.getItem(storageKey));
  expect(saved.bots.find((bot) => bot.id === request.id)?.archived).toBe(true);
  expect(fake.copy).not.toHaveBeenCalled();
  expect(fake.calls.some((command) => command.type === 'group.register')).toBe(false);
});

it('settles a readonly confirmation before a delayed write, then ignores the old write during a newer copy', async () => {
  const fake = connect();
  let finish: ((value: unknown) => unknown) | undefined;
  fake.copy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fake.copy.mockImplementationOnce(() => new Promise(() => {}));
  render(<App />);
  const dialog = await openCopy();
  await userEvent.click(within(dialog).getByRole('button', { name: '创建副本' }));
  const first = fake.copy.mock.calls[0][0];
  fake.read.mockImplementation(async (input) => result(input));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: '核对复制结果' })).toBeEnabled(),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: '核对复制结果' }));
  await screen.findByRole('heading', { name: first.name });
  fake.read.mockImplementation(async (input) => ({ request: input, state: 'unknown' }));
  const next = await openCopy();
  await userEvent.clear(within(next).getByRole('textbox', { name: '新群聊名称' }));
  await userEvent.type(within(next).getByRole('textbox', { name: '新群聊名称' }), '合成第二个副本');
  await userEvent.click(within(next).getByRole('button', { name: '创建副本' }));
  const newer = fake.copy.mock.calls[1][0];
  expect(newer.id).not.toBe(first.id);
  await act(() => finish!(result(first)));
  expect(screen.getByRole('dialog', { name: '复制群聊' })).toBeVisible();
  expect(restore(localStorage.getItem(storageKey)).groupCopy).toEqual(newer);
});

it('retires an obsolete reader after write confirmation and never lets it release a newer reader', async () => {
  const fake = connect();
  let writeFirst: ((value: unknown) => unknown) | undefined;
  let readFirst: ((value: unknown) => unknown) | undefined;
  let readNext: ((value: unknown) => unknown) | undefined;
  fake.copy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        writeFirst = resolve;
      }),
  );
  fake.copy.mockImplementationOnce(() => new Promise(() => {}));
  fake.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        readFirst = resolve;
      }),
  );
  fake.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        readNext = resolve;
      }),
  );
  render(<App />);
  const firstDialog = await openCopy();
  await userEvent.click(within(firstDialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() => expect(fake.read).toHaveBeenCalledTimes(1));
  const first = fake.copy.mock.calls[0][0];
  await act(() => writeFirst!(result(first)));
  await screen.findByRole('heading', { name: first.name });
  const nextDialog = await openCopy();
  await userEvent.clear(within(nextDialog).getByRole('textbox', { name: '新群聊名称' }));
  await userEvent.type(
    within(nextDialog).getByRole('textbox', { name: '新群聊名称' }),
    '合成新的核对',
  );
  await userEvent.click(within(nextDialog).getByRole('button', { name: '创建副本' }));
  await waitFor(() => expect(fake.read).toHaveBeenCalledTimes(2));
  const newer = fake.copy.mock.calls[1][0];
  await act(() => readFirst!(result(first)));
  expect(restore(localStorage.getItem(storageKey)).groupCopy).toEqual(newer);
  expect(within(nextDialog).getByRole('button', { name: '正在核对…' })).toBeDisabled();
  await act(() => readNext!(result(newer)));
  expect(await screen.findByRole('heading', { name: newer.name })).toBeVisible();
});
