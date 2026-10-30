import { beforeEach as seedBeforeEach } from 'vitest';
import { demoState as seedDemoState } from './fixtures';
import { serialize as seedSerialize, storageKey as seedStorageKey } from './storage';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  agentId,
  disconnected,
  type NoteItem,
  type NoteList,
  type NoteQuery,
  type NoteWrite,
  noteKey,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useEffect, useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { demoState as initialState } from './fixtures';
import { Notes } from './Notes';
import { RuntimeProvider } from './Runtime';
import { reduce } from './state';
import { restore, serialize, storageKey } from './storage';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'daban');
});
const at = '2026-01-01T00:00:00Z';
function item(bot: string, id: string, title: string): NoteItem {
  return {
    bot,
    id,
    title,
    body: 'MOCK PRIVATE BODY',
    status: 'open',
    revision: 1,
    deleted: false,
    createdAt: at,
    updatedAt: at,
    createdBy: { kind: 'human' },
    updatedBy: { kind: 'human' },
  };
}
function connect(records: NoteItem[] = [], protocol = 37) {
  const seed = initialState();
  seed.panel = null;
  seed.drafts.research = 'MOCK CHAT DRAFT';
  localStorage.setItem(storageKey, serialize(seed));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.notes = { available: true };
  snapshot.profiles = seed.bots
    .filter((bot) => !bot.members)
    .map((bot) => ({
      id: agentId(bot.id),
      name: bot.name,
      instructions: bot.role,
      memory: '',
      color: bot.color,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }));
  const entries = new Map(records.map((row) => [`${row.bot}/${row.id}`, structuredClone(row)]));
  const operations = new Map<string, NoteWrite>();
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const publish = () => {
    for (const listener of listeners) listener({ ...snapshot });
  };
  const list = vi.fn(
    async (bot: string, query: NoteQuery): Promise<NoteList> => ({
      bot,
      query,
      page: {
        bot,
        revision: [...entries.values()]
          .filter((row) => row.bot === bot)
          .reduce((sum, row) => sum + row.revision, 0),
        items: [...entries.values()]
          .filter(
            (row) =>
              row.bot === bot &&
              row.deleted === (query.filter === 'trash') &&
              (query.filter !== 'active' || row.status !== 'done') &&
              (!['open', 'parked', 'done'].includes(query.filter ?? '') ||
                row.status === query.filter) &&
              (!query.text || `${row.title} ${row.body}`.includes(query.text)),
          )
          .map((row) => ({ ...row, bodyTruncated: false })),
      },
    }),
  );
  const read = vi.fn(async (bot: string, id: string) => {
    const row = entries.get(`${bot}/${id}`);
    if (!row) throw Error('NOTE_NOT_FOUND');
    return structuredClone(row);
  });
  const ack = (bot: string, request: NoteWrite) => ({
    state: 'complete',
    bot,
    request,
    actor: { kind: 'human' },
    acceptedRevision: request.action === 'create' ? 1 : request.revision + 1,
    acceptedAt: at,
    item: structuredClone(entries.get(`${bot}/${request.note}`)!),
  });
  const write = vi.fn(async (bot: string, request: NoteWrite): Promise<unknown> => {
    const localId = seed.bots.find((row) => agentId(row.id) === bot)!.id;
    expect(restore(localStorage.getItem(storageKey)).notes?.[localId]?.pending?.request).toEqual(
      request,
    );
    const key = `${bot}/${request.note}`;
    const old = entries.get(key);
    if (request.action === 'create')
      entries.set(key, { ...item(bot, request.note, request.value.title), ...request.value });
    else {
      if (!old || old.revision !== request.revision) throw Error('NOTE_CONFLICT');
      const next = {
        ...old,
        ...(request.action === 'update' ? request.value : { deleted: request.action === 'trash' }),
        revision: old.revision + 1,
      };
      if (next.status === 'done') next.completedAt ||= at;
      else delete next.completedAt;
      entries.set(key, next);
    }
    const saved = entries.get(key)!;
    if (saved.status === 'done') saved.completedAt ||= at;
    operations.set(noteKey(bot, request, { kind: 'human' }), request);
    return ack(bot, request);
  });
  const receipt = vi.fn(
    async (bot: string, request: NoteWrite): Promise<unknown> =>
      operations.has(noteKey(bot, request, { kind: 'human' }))
        ? ack(bot, request)
        : { state: 'unknown', bot, request, actor: { kind: 'human' } },
  );
  const calls: RuntimeCommand[] = [];
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      calls.push(command);
      try {
        let value: unknown;
        if (command.type === 'status') value = snapshot;
        else if (command.type === 'notes.list') value = await list(command.bot, command.query);
        else if (command.type === 'notes.read') value = await read(command.bot, command.id);
        else if (command.type === 'notes.write') value = await write(command.bot, command.request);
        else if (command.type === 'notes.receipt')
          value = await receipt(command.bot, command.request);
        else throw Error('MOCK_UNEXPECTED_COMMAND');
        return { ok: true, value: value as T };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'MOCK_FAILED' };
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: { platform: 'darwin', runtime: bridge },
  });
  return { entries, list, read, write, receipt, snapshot, calls, publish, ack };
}
function Fixture() {
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    restore(localStorage.getItem(storageKey)),
  );
  useEffect(() => {
    localStorage.setItem(storageKey, serialize(state));
  }, [state]);
  const bot = state.bots.find((row) => row.id === state.selected)!;
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: 'select', bot: 'research' })}>
        合成甲
      </button>
      <button type="button" onClick={() => dispatch({ type: 'select', bot: 'writer' })}>
        合成乙
      </button>
      <Notes key={bot.id} state={state} bot={bot} dispatch={dispatch} notify={() => {}} />
    </>
  );
}
const fixture = () =>
  render(
    <StrictMode>
      <RuntimeProvider>
        <Fixture />
      </RuntimeProvider>
    </StrictMode>,
  );

it('keeps private lists, unsent drafts and search separate across Bots without starting tasks', async () => {
  const live = connect([item('a', 'mock-a', '合成甲便笺'), item('b', 'mock-b', '合成乙便笺')]);
  fixture();
  expect(await screen.findByRole('button', { name: '查看便笺 合成甲便笺' })).toBeVisible();
  expect(screen.queryByText('合成乙便笺')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '新建便笺' }));
  expect(screen.getByText('尚未填写')).toBeVisible();
  await userEvent.type(screen.getByRole('textbox', { name: '便笺标题' }), 'MOCK ALPHA DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '合成乙' }));
  await userEvent.click(await screen.findByRole('button', { name: '查看便笺 合成乙便笺' }));
  await userEvent.type(
    await screen.findByRole('textbox', { name: '便笺正文' }),
    ' MOCK BETA DRAFT',
  );
  await userEvent.click(screen.getByRole('button', { name: '合成甲' }));
  expect(await screen.findByRole('textbox', { name: '便笺标题' })).toHaveValue('MOCK ALPHA DRAFT');
  expect(restore(localStorage.getItem(storageKey)).notes?.writer?.draft?.body).toBe(
    'MOCK PRIVATE BODY MOCK BETA DRAFT',
  );
  expect(live.write).not.toHaveBeenCalled();
  expect(live.calls.every((call) => call.type === 'status' || call.type.startsWith('notes.'))).toBe(
    true,
  );
});

it('saves exact durable intent, completes, confirms trash and restores without discarding local edits', async () => {
  const live = connect();
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '新建便笺' }));
  await userEvent.type(screen.getByRole('textbox', { name: '便笺标题' }), '合成保存便笺');
  await userEvent.type(screen.getByRole('textbox', { name: '便笺正文' }), 'MOCK SAVED BODY');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '便笺状态' }), 'done');
  await userEvent.click(screen.getByRole('button', { name: '保存便笺' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)).notes?.research?.pending).toBeUndefined(),
  );
  await userEvent.click(screen.getByRole('button', { name: '移入回收站' }));
  expect(live.write).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: '确认移入' }));
  await waitFor(() => expect([...live.entries.values()][0].deleted).toBe(true));
  await userEvent.type(screen.getByRole('textbox', { name: '便笺正文' }), ' MOCK RESTORE EDIT');
  await userEvent.click(screen.getByRole('button', { name: '恢复便笺' }));
  await waitFor(() => expect([...live.entries.values()][0].deleted).toBe(false));
  expect(screen.getByRole('textbox', { name: '便笺正文' })).toHaveValue(
    'MOCK SAVED BODY MOCK RESTORE EDIT',
  );
  expect(live.write.mock.calls.map(([, request]) => request.action)).toEqual([
    'create',
    'trash',
    'restore',
  ]);
  expect(screen.queryByRole('button', { name: '确认移入' })).not.toBeInTheDocument();
});

it('retains ambiguous operation across reopen, only reads receipts and retries the identical request explicitly', async () => {
  const live = connect();
  live.write.mockRejectedValue(Error('RUNTIME_REQUEST_FAILED'));
  const mounted = fixture();
  await userEvent.click(await screen.findByRole('button', { name: '新建便笺' }));
  await userEvent.type(screen.getByRole('textbox', { name: '便笺标题' }), '合成待确认便笺');
  await userEvent.click(screen.getByRole('button', { name: '保存便笺' }));
  expect(await screen.findByRole('button', { name: '重试同一次操作' })).toBeVisible();
  expect(screen.getByRole('button', { name: '新建便笺' })).toBeDisabled();
  const pending = restore(localStorage.getItem(storageKey)).notes!.research!.pending!;
  mounted.unmount();
  fixture();
  await waitFor(() => expect(live.receipt).toHaveBeenCalled());
  expect(live.write).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox', { name: '便笺标题' })).toHaveAttribute('readonly');
  live.entries.set(`a/${pending.request.note}`, item('a', pending.request.note, '合成待确认便笺'));
  live.write.mockResolvedValue(live.ack('a', pending.request));
  await userEvent.click(screen.getByRole('button', { name: '重试同一次操作' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(2));
  expect(live.write.mock.calls[1]).toEqual(['a', pending.request]);
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)).notes?.research?.pending).toBeUndefined(),
  );
});

it('shows three-way conflict data and keeps only locally edited fields on explicit merge', async () => {
  const first = item('a', 'mock-conflict', '合成原标题');
  const live = connect([first]);
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '查看便笺 合成原标题' }));
  const title = await screen.findByRole('textbox', { name: '便笺标题' });
  await userEvent.clear(title);
  await userEvent.type(title, '合成本机标题');
  live.entries.set(`a/${first.id}`, {
    ...first,
    revision: 2,
    body: 'MOCK AGENT BODY',
    status: 'parked',
  });
  await userEvent.click(screen.getByRole('button', { name: '保存便笺' }));
  expect(await screen.findByText(/便笺已更新/)).toBeVisible();
  expect(title).toHaveValue('合成本机标题');
  await userEvent.click(screen.getByRole('button', { name: '核对最新版本' }));
  expect(await screen.findByText('MOCK AGENT BODY')).toBeVisible();
  expect(screen.getByRole('button', { name: '保存便笺' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '保留我的更改' }));
  expect(screen.getByRole('textbox', { name: '便笺正文' })).toHaveValue('MOCK AGENT BODY');
  await userEvent.click(screen.getByRole('button', { name: '保存便笺' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(2));
  expect(live.write.mock.calls[1][1]).toMatchObject({
    revision: 2,
    value: { title: '合成本机标题' },
  });
  expect(live.write.mock.calls[1][1]).not.toHaveProperty('value.body');
});

it('rejects cross-Bot/stale detail and does not let a late acknowledgement touch the selected Bot', async () => {
  const first = item('a', 'mock-late', '合成延迟便笺');
  const live = connect([first]);
  let finish!: (row: NoteItem) => unknown;
  live.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '查看便笺 合成延迟便笺' }));
  await userEvent.click(screen.getByRole('button', { name: '新建便笺' }));
  await userEvent.type(screen.getByRole('textbox', { name: '便笺标题' }), 'MOCK NEW EDITOR');
  await act(async () => finish(first));
  expect(screen.getByRole('textbox', { name: '便笺标题' })).toHaveValue('MOCK NEW EDITOR');
  let finishWrite!: (value: unknown) => unknown;
  live.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
  );
  await userEvent.click(screen.getByRole('button', { name: '保存便笺' }));
  const pending = restore(localStorage.getItem(storageKey)).notes!.research!.pending!;
  await userEvent.click(screen.getByRole('button', { name: '合成乙' }));
  await userEvent.click(screen.getByRole('button', { name: '新建便笺' }));
  await userEvent.type(screen.getByRole('textbox', { name: '便笺标题' }), 'MOCK BETA KEPT');
  live.entries.set(`a/${pending.request.note}`, item('a', pending.request.note, 'MOCK NEW EDITOR'));
  await act(async () => finishWrite(live.ack('a', pending.request)));
  expect(screen.getByRole('textbox', { name: '便笺标题' })).toHaveValue('MOCK BETA KEPT');
  expect(restore(localStorage.getItem(storageKey)).notes?.research?.pending?.request).toEqual(
    pending.request,
  );
  expect(live.write).toHaveBeenCalledTimes(1);
});

it('sends nothing when durable intent cannot be stored and keeps the draft editable', async () => {
  const live = connect();
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '新建便笺' }));
  await userEvent.type(screen.getByRole('textbox', { name: '便笺标题' }), '合成磁盘满草稿');
  const save = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === storageKey && JSON.parse(value).state.notes?.research?.pending)
      throw Error('MOCK_DISK_FULL');
    save.call(this, key, value);
  });
  await userEvent.click(screen.getByRole('button', { name: '保存便笺' }));
  expect(await screen.findByText(/本机无法保存操作记录/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '便笺标题' })).not.toHaveAttribute('readonly');
  expect(live.write).not.toHaveBeenCalled();
});

it('allows archived/recovery reads and retains editors while blocking all writes', async () => {
  const live = connect([item('a', 'mock-history', '合成历史便笺')]);
  live.snapshot.profiles.find((row) => row.id === 'a')!.archived = true;
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '查看便笺 合成历史便笺' }));
  expect(await screen.findByRole('textbox', { name: '便笺正文' })).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '保存便笺' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '新建便笺' })).toBeDisabled();
  live.snapshot.profiles.find((row) => row.id === 'a')!.archived = false;
  live.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
  act(() => live.publish());
  await userEvent.type(screen.getByRole('textbox', { name: '便笺正文' }), ' MOCK RECOVERY DRAFT');
  expect(screen.getByRole('button', { name: '保存便笺' })).toBeDisabled();
  expect(live.write).not.toHaveBeenCalled();
});

it('gates old runtimes and exposes the panel only for an individual Bot', async () => {
  const live = connect([], 36);
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: '便笺面板' }));
  expect(await screen.findByText('需要更新运行环境')).toBeVisible();
  expect(live.calls.some((call) => call.type.startsWith('notes.'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '周报协作' }));
  expect(screen.queryByRole('button', { name: '便笺面板' })).not.toBeInTheDocument();
  expect(screen.queryByRole('tab', { name: '便笺' })).not.toBeInTheDocument();
});

it('rejects a foreign Bot page or detail instead of displaying it', async () => {
  const first = item('a', 'mock-scope', '合成本 Bot 便笺');
  const live = connect([first]);
  live.list.mockImplementationOnce(async (_bot, query) => ({
    bot: 'b',
    query,
    page: {
      bot: 'b',
      revision: 1,
      items: [{ ...item('b', 'mock-foreign', 'MOCK FOREIGN SECRET'), bodyTruncated: false }],
    },
  }));
  fixture();
  expect(await screen.findByText(/便笺列表返回不匹配/)).toBeVisible();
  expect(screen.queryByText('MOCK FOREIGN SECRET')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '刷新便笺' }));
  live.read.mockResolvedValueOnce({ ...first, bot: 'b', body: 'MOCK FOREIGN DETAIL' });
  await userEvent.click(await screen.findByRole('button', { name: '查看便笺 合成本 Bot 便笺' }));
  expect(await screen.findByText(/便笺详情返回不匹配/)).toBeVisible();
  expect(screen.queryByDisplayValue('MOCK FOREIGN DETAIL')).not.toBeInTheDocument();
  expect(live.write).not.toHaveBeenCalled();
});

it('searches/filters without overwriting an editor and ignores a late superseded query', async () => {
  const first = item('a', 'mock-search', '合成搜索结果');
  const live = connect([first]);
  fixture();
  await screen.findByRole('button', { name: '查看便笺 合成搜索结果' });
  const response = await live.list('a', { filter: 'active', text: '', limit: 50 });
  let finish!: (page: NoteList) => unknown;
  live.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await userEvent.click(screen.getByRole('button', { name: '刷新便笺' }));
  await userEvent.type(screen.getByRole('textbox', { name: '搜索便笺' }), 'MOCK MISSING');
  await act(async () => finish(response));
  expect(screen.queryByRole('button', { name: '查看便笺 合成搜索结果' })).not.toBeInTheDocument();
  expect(await screen.findByText('没有匹配的便笺')).toBeVisible();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: '便笺筛选' }), 'parked');
  expect(restore(localStorage.getItem(storageKey)).notes?.research).toMatchObject({
    filter: 'parked',
    text: 'MOCK MISSING',
  });
  await userEvent.click(screen.getByRole('button', { name: '合成乙' }));
  expect(screen.getByRole('textbox', { name: '搜索便笺' })).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: '合成甲' }));
  expect(screen.getByRole('textbox', { name: '搜索便笺' })).toHaveValue('MOCK MISSING');
});

it('shows loading until the first page is actually known and never flashes a false empty list', async () => {
  vi.useFakeTimers();
  const live = connect();
  let finish!: (value: NoteList) => unknown;
  live.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fixture();
  await act(async () => {});
  expect(screen.queryByText('这里还没有便笺')).not.toBeInTheDocument();
  expect(screen.getByText('正在读取便笺…')).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  await act(async () =>
    finish({
      bot: 'a',
      query: { filter: 'active', text: '', limit: 50 },
      page: { bot: 'a', revision: 0, items: [] },
    }),
  );
  expect(screen.getByText('这里还没有便笺')).toBeVisible();
});

it('describes a failed list read as a read failure with refresh guidance', async () => {
  const live = connect();
  live.list.mockRejectedValueOnce(Error('RUNTIME_REQUEST_FAILED'));
  fixture();
  expect(await screen.findByText(/便笺列表暂时无法读取/)).toBeVisible();
  expect(screen.queryByText('这里还没有便笺')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刷新便笺' })).toBeEnabled();
});
