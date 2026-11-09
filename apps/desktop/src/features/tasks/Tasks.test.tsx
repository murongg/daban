import { beforeEach as seedBeforeEach } from 'vitest';
import { serialize as seedSerialize, storageKey as seedStorageKey } from '../../app/storage';
import { demoState as seedDemoState } from '../../test/fixtures';

seedBeforeEach(() => localStorage.setItem(seedStorageKey, seedSerialize(seedDemoState())));

import {
  agentId,
  disconnected,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  type WorkItem,
  type WorkList,
  type WorkQuery,
  type WorkWrite,
  workKey,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { restore, serialize, storageKey } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';
import { workDraft, workInitial, workInput } from './work-state';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'daban');
});
const at = '2026-01-01T00:00:00Z';
function item(id: string, title: string, status: WorkItem['status'] = 'todo'): WorkItem {
  return {
    id,
    title,
    status,
    description: 'MOCK SHARED DETAIL',
    progress: '',
    revision: 1,
    deleted: false,
    createdAt: at,
    updatedAt: at,
    createdBy: { kind: 'human' },
    updatedBy: { kind: 'human' },
    ...(status === 'done' ? { completedAt: at } : {}),
  };
}
function connect(records: WorkItem[] = [], protocol = 36) {
  const seed = initialState();
  seed.panel = null;
  seed.drafts.research = 'MOCK-CHAT-DRAFT';
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
      createdAt: at,
      updatedAt: at,
    }));
  snapshot.work = { available: true, count: records.length, revision: records.length };
  const entries = new Map(records.map((record) => [record.id, structuredClone(record)]));
  const operations = new Map<string, WorkWrite>();
  const listeners = new Set<(state: RuntimeSnapshot) => unknown>();
  const publish = () => {
    for (const listener of listeners) listener({ ...snapshot });
  };
  const list = vi.fn(
    async (query: WorkQuery): Promise<WorkList> => ({
      query,
      page: {
        revision: snapshot.work?.revision ?? 0,
        items: [...entries.values()]
          .filter(
            (row) =>
              row.deleted === (query.filter === 'trash') &&
              (query.filter !== 'open' || row.status !== 'done') &&
              (query.filter !== 'done' || row.status === 'done') &&
              (!query.text ||
                `${row.title} ${row.description} ${row.progress}`.includes(query.text)),
          )
          .map(({ description: _description, ...row }) => ({ ...row, progressTruncated: false })),
      },
    }),
  );
  const read = vi.fn(async (id: string) => {
    const record = entries.get(id);
    if (!record) throw Error('WORK_NOT_FOUND');
    return structuredClone(record);
  });
  const ack = (request: WorkWrite) => ({
    state: 'complete',
    request,
    actor: { kind: 'human' },
    acceptedRevision: request.action === 'create' ? 1 : request.revision + 1,
    acceptedAt: at,
    item: structuredClone(entries.get(request.item)!),
  });
  const write = vi.fn(async (request: WorkWrite): Promise<unknown> => {
    expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(request);
    const previous = entries.get(request.item);
    if (request.action === 'create')
      entries.set(request.item, {
        ...item(request.item, request.value.title.trim()),
        ...request.value,
        title: request.value.title.trim(),
      });
    else {
      if (previous?.revision !== request.revision) throw Error('WORK_CONFLICT');
      const next = {
        ...previous,
        ...(request.action === 'update' ? request.value : { deleted: request.action === 'trash' }),
        revision: previous.revision + 1,
      };
      if (next.status === 'done') next.completedAt ||= at;
      else delete next.completedAt;
      entries.set(request.item, next);
    }
    operations.set(workKey(request, { kind: 'human' }), request);
    snapshot.work = {
      available: true,
      count: entries.size,
      revision: (snapshot.work?.revision ?? 0) + 1,
    };
    publish();
    return ack(request);
  });
  const receipt = vi.fn(
    async (request: WorkWrite): Promise<unknown> =>
      operations.has(workKey(request, { kind: 'human' }))
        ? ack(request)
        : { state: 'unknown', request, actor: { kind: 'human' } },
  );
  const calls: RuntimeCommand[] = [];
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      calls.push(command);
      try {
        let value: unknown;
        if (command.type === 'status') value = snapshot;
        else if (command.type === 'work.list') value = await list(command.query);
        else if (command.type === 'work.read') value = await read(command.id);
        else if (command.type === 'work.write') value = await write(command.request);
        else if (command.type === 'work.receipt') value = await receipt(command.request);
        else return { ok: false, error: 'MOCK_UNEXPECTED_COMMAND' };
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
const tasks = async () =>
  userEvent.click(await screen.findByRole('button', { name: /^任务(?:\s|$)/ }));

it('groups the task detail actions as named icon buttons', async () => {
  const live = connect([item('mock-actions', '合成操作任务')]);
  render(<App />);
  await tasks();
  await userEvent.click(await screen.findByRole('button', { name: '查看 合成操作任务' }));
  const description = await screen.findByRole('textbox', { name: '任务说明' });

  const pane = within(screen.getByRole('complementary', { name: '任务详情' }));
  const expand = pane.getByRole('button', { name: '展开任务详情' });
  const discussion = pane.getByRole('button', { name: '查看讨论' });
  const discard = pane.getByRole('button', { name: '放弃修改' });
  const save = pane.getByRole('button', { name: '保存任务' });
  const close = pane.getByRole('button', { name: '关闭任务详情' });
  for (const button of [expand, discussion, discard, save, close]) {
    expect(button).toHaveTextContent(/^$/);
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button.parentElement).toBe(expand.parentElement);
  }
  expect(expand.parentElement).not.toContainElement(
    pane.getByRole('heading', { name: '任务详情' }),
  );
  expect(save).toBeDisabled();
  expect(discard).toBeDisabled();
  await userEvent.type(description, ' MOCK UNSAVED EDIT');
  await userEvent.click(discard);
  expect(description).toHaveValue('MOCK SHARED DETAIL');
  expect(live.write).not.toHaveBeenCalled();
  await userEvent.click(close);
  expect(screen.queryByRole('complementary', { name: '任务详情' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看 合成操作任务' })).toBeVisible();
});

it('expands task details without losing the current edits or changing the saved layout', async () => {
  const live = connect([item('mock-expand', '合成展开任务')]);
  render(<App />);
  await tasks();
  await userEvent.click(await screen.findByRole('button', { name: '查看 合成展开任务' }));
  const description = await screen.findByRole('textbox', { name: '任务说明' });
  await userEvent.type(description, ' MOCK UNSAVED EXPANSION');
  await userEvent.click(screen.getByRole('button', { name: '展开任务详情' }));
  expect(screen.getByRole('button', { name: '收起任务详情' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(description.closest('.work-layout')).toHaveClass('editor-expanded');
  expect(description).toHaveValue('MOCK SHARED DETAIL MOCK UNSAVED EXPANSION');
  expect(restore(localStorage.getItem(storageKey)).work?.mode).toBe('list');
  await userEvent.click(screen.getByRole('button', { name: '收起任务详情' }));
  expect(description.closest('.work-layout')).not.toHaveClass('editor-expanded');
  expect(description).toHaveValue('MOCK SHARED DETAIL MOCK UNSAVED EXPANSION');
  expect(live.write).not.toHaveBeenCalled();
});

it('browses shared tasks in list and board without starting work or changing a conversation draft', async () => {
  const live = connect([
    item('mock-todo', '合成待办甲'),
    item('mock-doing', '合成待办乙', 'doing'),
    item('mock-done', '合成待办丙', 'done'),
  ]);
  render(<App />);
  await tasks();
  expect(await screen.findByText('合成待办甲')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '看板' }));
  expect(screen.getByRole('region', { name: '待处理' })).toBeVisible();
  expect(
    within(screen.getByRole('region', { name: '进行中' })).getByText('合成待办乙'),
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '回收站' }));
  expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(screen.getByRole('button', { name: '研究员' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('MOCK-CHAT-DRAFT');
  expect(live.write).not.toHaveBeenCalled();
  expect(live.calls.some((call) => ['task.start', 'computer.action'].includes(call.type))).toBe(
    false,
  );
});

it('persists an exact create intent before effect and retains task edits across navigation and client reconstruction', async () => {
  const live = connect();
  const mounted = render(<App />);
  await tasks();
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成新任务');
  await userEvent.type(screen.getByRole('textbox', { name: '任务说明' }), 'MOCK OWNED DESCRIPTION');
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)).work?.pending).toBeUndefined(),
  );
  await userEvent.type(screen.getByRole('textbox', { name: '最新进展' }), 'MOCK UNSAVED PROGRESS');
  await userEvent.click(screen.getByRole('button', { name: '研究员' }));
  expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('MOCK-CHAT-DRAFT');
  mounted.unmount();
  render(<App />);
  await tasks();
  expect(await screen.findByRole('textbox', { name: '最新进展' })).toHaveValue(
    'MOCK UNSAVED PROGRESS',
  );
  expect(live.write).toHaveBeenCalledTimes(1);
});

it('keeps ambiguous saves sealed and reopens with read-only receipt checks until explicit exact retry', async () => {
  const live = connect();
  live.write.mockRejectedValue(Error('RUNTIME_REQUEST_FAILED'));
  const mounted = render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await tasks();
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成待确认任务');
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  expect(await screen.findByRole('button', { name: '重试同一次操作' })).toBeVisible();
  const pending = restore(localStorage.getItem(storageKey)).work!.pending!;
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveAttribute('readonly');
  mounted.unmount();
  render(<App />);
  await tasks();
  await waitFor(() => expect(live.receipt).toHaveBeenCalled());
  expect(live.write).toHaveBeenCalledTimes(1);
  live.entries.set(pending.request.item, item(pending.request.item, '合成待确认任务'));
  live.write.mockResolvedValue(live.ack(pending.request));
  await userEvent.click(screen.getByRole('button', { name: '重试同一次操作' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(2));
  expect(live.write.mock.calls[1][0]).toEqual(pending.request);
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)).work?.pending).toBeUndefined(),
  );
});

it('keeps a conflicted edit and explicitly merges only changed fields into the latest shared revision', async () => {
  const first = item('mock-conflict', '合成原任务');
  first.progress = 'MOCK OLD PROGRESS';
  const live = connect([first]);
  render(<App />);
  await tasks();
  await userEvent.click(await screen.findByRole('button', { name: '查看 合成原任务' }));
  const title = await screen.findByRole('textbox', { name: '任务标题' });
  await userEvent.clear(title);
  await userEvent.type(title, '合成我的标题');
  live.entries.set(first.id, {
    ...first,
    revision: 2,
    progress: 'MOCK NEWER HUMAN PROGRESS',
    updatedBy: { kind: 'bot', bot: 'mock-beta' },
  });
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  expect(await screen.findByText(/任务已更新/)).toBeVisible();
  expect(title).toHaveValue('合成我的标题');
  await userEvent.click(screen.getByRole('button', { name: '核对最新版本' }));
  await screen.findByRole('button', { name: '保留我的更改' });
  expect(screen.getByRole('button', { name: '保存任务' })).toBeDisabled();
  await userEvent.click(await screen.findByRole('button', { name: '保留我的更改' }));
  expect(screen.getByRole('textbox', { name: '最新进展' })).toHaveValue(
    'MOCK NEWER HUMAN PROGRESS',
  );
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(2));
  expect(live.write.mock.calls[1][0]).toMatchObject({
    revision: 2,
    action: 'update',
    value: { title: '合成我的标题' },
  });
  expect(live.write.mock.calls[1][0]).not.toHaveProperty('value.progress');
});

it('confirms trash and restores the same card while preserving a locally edited description', async () => {
  const live = connect([item('mock-trash', '合成可恢复任务')]);
  render(<App />);
  await tasks();
  await userEvent.click(await screen.findByRole('button', { name: '查看 合成可恢复任务' }));
  const trash = await screen.findByRole('button', { name: '移入回收站' });
  expect(trash).toHaveTextContent(/^$/);
  expect(trash.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  await userEvent.click(trash);
  expect(live.write).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '确认移入' }));
  await waitFor(() => expect(live.entries.get('mock-trash')?.deleted).toBe(true));
  await userEvent.type(screen.getByRole('textbox', { name: '任务说明' }), ' MOCK RESTORE DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '恢复任务' }));
  await waitFor(() => expect(live.entries.get('mock-trash')?.deleted).toBe(false));
  expect(screen.queryByRole('button', { name: '确认移入' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '任务说明' })).toHaveValue(
    'MOCK SHARED DETAIL MOCK RESTORE DRAFT',
  );
  expect(live.write.mock.calls.map(([request]) => request.action)).toEqual(['trash', 'restore']);
});

it('keeps the draft editable when durable local request storage fails and sends no mutation', async () => {
  const live = connect();
  render(<App />);
  await tasks();
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成存储失败草稿');
  const save = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === storageKey && JSON.parse(value).state.work?.pending) throw Error('MOCK_DISK_FULL');
    save.call(this, key, value);
  });
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  expect(await screen.findByText(/本机无法保存操作记录/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '任务标题' })).not.toHaveAttribute('readonly');
  expect(live.write).not.toHaveBeenCalled();
});

it('gates an older runtime without dropping its retained pending operation or issuing Work calls', async () => {
  const live = connect([], 35);
  const seed = restore(localStorage.getItem(storageKey));
  const draft = { ...workDraft(), title: '合成旧环境待核对' };
  const request = workInput(draft, 'mock-old-op', 'mock-old-card')!;
  seed.work = { ...workInitial(), draft, pending: { draft, request } };
  localStorage.setItem(storageKey, serialize(seed));
  render(<App />);
  await tasks();
  expect(screen.getByText('需要更新运行环境')).toBeVisible();
  expect(screen.getByRole('button', { name: '重试同一次操作' })).toBeDisabled();
  expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(request);
  expect(live.calls.some((call) => call.type.startsWith('work.'))).toBe(false);
});

it('allows reads during recovery but blocks saving, and labels backend updates without replacing a dirty editor', async () => {
  const live = connect([item('mock-recovery', '合成恢复期间任务')]);
  render(<App />);
  await tasks();
  await userEvent.click(await screen.findByRole('button', { name: '查看 合成恢复期间任务' }));
  await userEvent.type(
    await screen.findByRole('textbox', { name: '最新进展' }),
    'MOCK LOCAL PROGRESS',
  );
  live.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
  live.snapshot.work = { available: true, revision: 2, count: 1 };
  act(() => live.publish());
  expect(screen.getByRole('button', { name: '保存任务' })).toBeDisabled();
  expect(screen.getByText(/任务有新更改/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: '最新进展' })).toHaveValue('MOCK LOCAL PROGRESS');
  expect(live.write).not.toHaveBeenCalled();
});

it('does not let a late card read overwrite a new editor', async () => {
  const record = item('mock-read', '合成延迟详情');
  const live = connect([record]);
  let finish!: (item: WorkItem) => unknown;
  live.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  await tasks();
  await userEvent.click(await screen.findByRole('button', { name: '查看 合成延迟详情' }));
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), 'MOCK NEW EDITOR');
  await act(async () => finish(record));
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveValue('MOCK NEW EDITOR');
  expect(restore(localStorage.getItem(storageKey)).work?.draft?.base).toBeUndefined();
});

it('keeps a later pending operation owned when an earlier mutation finishes after receipt settlement', async () => {
  const live = connect();
  let finishFirst!: (value: unknown) => unknown, finishSecond!: (value: unknown) => unknown;
  live.write
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
  render(<App />);
  await tasks();
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成第一次操作');
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(1));
  const first = live.write.mock.calls[0][0];
  live.entries.set(first.item, item(first.item, '合成第一次操作'));
  live.receipt.mockResolvedValue(live.ack(first));
  await waitFor(() => expect(screen.getByRole('button', { name: '核对操作结果' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: '核对操作结果' }));
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)).work?.pending).toBeUndefined(),
  );
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成第二次操作');
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(2));
  const second = live.write.mock.calls[1][0];
  await act(async () => finishFirst(live.ack(first)));
  expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(second);
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveValue('合成第二次操作');
  live.entries.set(second.item, item(second.item, '合成第二次操作'));
  await act(async () => finishSecond(live.ack(second)));
});

it('retains an earlier uncertain operation after a refused retry or a foreign receipt', async () => {
  const live = connect();
  const seed = restore(localStorage.getItem(storageKey));
  const draft = { ...workDraft(), title: '合成精确待确认' },
    request = workInput(draft, 'mock-held-op', 'mock-held-item')!;
  seed.work = { ...workInitial(), draft, pending: { request, draft } };
  localStorage.setItem(storageKey, serialize(seed));
  live.write.mockRejectedValue(Error('RUNTIME_TOO_OLD'));
  render(<App />);
  await tasks();
  await userEvent.click(screen.getByRole('button', { name: '重试同一次操作' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(1));
  expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(request);
  live.receipt.mockResolvedValue({
    state: 'unknown',
    actor: { kind: 'human' },
    request: { ...request, id: 'mock-foreign-op' },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: '核对操作结果' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: '核对操作结果' }));
  expect(await screen.findByText(/任务回执不匹配/)).toBeVisible();
  expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(request);
});

it('loads bounded pages with an exclusive cursor and applies new search without retaining unrelated rows', async () => {
  const first = item('mock-page-first', '合成第一页'),
    second = item('mock-page-second', '合成第二页');
  const live = connect([first, second]);
  const row = (record: WorkItem) => {
    const { description: _description, ...summary } = record;
    return { ...summary, progressTruncated: false };
  };
  live.list.mockImplementation(async (query) => ({
    query,
    page: {
      revision: live.snapshot.work?.revision ?? 2,
      items: query.text ? [] : [row(query.before ? second : first)],
      ...(!query.before && !query.text ? { nextBefore: 10 } : {}),
    },
  }));
  render(<App />);
  await tasks();
  expect(await screen.findByText(first.title)).toBeVisible();
  live.snapshot.work = { available: true, revision: 3, count: 2 };
  act(() => live.publish());
  await userEvent.click(screen.getByRole('button', { name: '加载更多任务' }));
  expect(await screen.findByText(second.title)).toBeVisible();
  expect(screen.getByText(/任务有新更改/)).toBeVisible();
  expect(live.list.mock.calls.some(([query]) => query.before === 10)).toBe(true);
  await userEvent.type(screen.getByRole('searchbox', { name: '搜索任务' }), 'MOCK NOMATCH');
  expect(await screen.findByText('没有找到匹配的任务')).toBeVisible();
  expect(screen.queryByText(first.title)).not.toBeInTheDocument();
  expect(live.write).not.toHaveBeenCalled();
});

it('rejects a mismatched list echo without replacing unrelated saved chat data', async () => {
  const live = connect();
  live.list.mockImplementation(async (query) => ({
    query: { ...query, filter: 'trash' },
    page: { revision: 0, items: [] },
  }));
  render(<App />);
  await tasks();
  expect(await screen.findByText(/任务列表返回不匹配/)).toBeVisible();
  expect(screen.queryByText('这里还没有任务')).not.toBeInTheDocument();
  expect(restore(localStorage.getItem(storageKey)).drafts.research).toBe('MOCK-CHAT-DRAFT');
  expect(live.write).not.toHaveBeenCalled();
});

it('shows an initial loading state until the first list result confirms whether the workspace is empty', async () => {
  const live = connect();
  let finish!: (value: WorkList) => unknown;
  live.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  await tasks();
  expect(screen.getByRole('status', { name: '正在读取任务' })).toBeVisible();
  expect(screen.queryByText('这里还没有任务')).not.toBeInTheDocument();
  await waitFor(() => expect(live.list).toHaveBeenCalledTimes(1));
  await act(async () =>
    finish({ query: live.list.mock.calls[0][0], page: { revision: 0, items: [] } }),
  );
  expect(screen.getByText('这里还没有任务')).toBeVisible();
});

it('does not insert a saved card into a search result that SQLite would not match', async () => {
  const live = connect();
  const seed = restore(localStorage.getItem(storageKey));
  seed.work = { ...workInitial(), text: 'é' };
  localStorage.setItem(storageKey, serialize(seed));
  render(<App />);
  await tasks();
  expect(await screen.findByText('没有找到匹配的任务')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '新建任务' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成É');
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(restore(localStorage.getItem(storageKey)).work?.pending).toBeUndefined(),
  );
  expect(screen.queryByRole('button', { name: '查看 合成É' })).not.toBeInTheDocument();
});

it('shows the six workflow columns only when the runtime supports them', async () => {
  connect(
    [
      item('mock-review', '合成待审核', 'review'),
      item('mock-blocked', '合成受阻', 'blocked'),
      { ...item('mock-closed', '合成已关闭', 'closed'), completedAt: at },
    ],
    39,
  );
  render(<App />);
  await tasks();
  await userEvent.click(screen.getByRole('button', { name: '看板' }));
  expect(
    within(await screen.findByRole('region', { name: '待审核' })).getByText('合成待审核'),
  ).toBeVisible();
  expect(within(screen.getByRole('region', { name: '受阻' })).getByText('合成受阻')).toBeVisible();
  expect(
    within(screen.getByRole('region', { name: '已关闭' })).getByText('合成已关闭'),
  ).toBeVisible();
});
