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
  type WorkComment,
  type WorkCommentList,
  type WorkCommentQuery,
  type WorkCommentWrite,
  type WorkItem,
  type WorkList,
  type WorkQuery,
  type WorkWrite,
  workCommentKey,
} from '@daban/protocol';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { restore, serialize, storageKey } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';
import { type CommentsState, commentCard } from './comments-state';
import { type WorkState, workDraft } from './work-state';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'daban');
});
const at = '2026-01-01T00:00:00Z';
function item(id: string, title: string): WorkItem {
  return {
    id,
    title,
    description: 'MOCK TASK DETAIL',
    progress: '',
    status: 'todo',
    revision: 1,
    deleted: false,
    createdAt: at,
    updatedAt: at,
    createdBy: { kind: 'human' },
    updatedBy: { kind: 'human' },
  };
}
function connect(options: { protocol?: number; comments?: CommentsState; work?: WorkState } = {}) {
  const seed = initialState();
  seed.panel = null;
  seed.drafts.research = 'MOCK CHAT DRAFT';
  seed.comments = options.comments;
  seed.work = options.work;
  localStorage.setItem(storageKey, serialize(seed));
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = options.protocol ?? 38;
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
  const entries = new Map(
    [item('mock-alpha', '合成任务甲'), item('mock-beta', '合成任务乙')].map((row) => [row.id, row]),
  );
  const comments: { comment: WorkComment; seq: number }[] = [];
  const operations = new Map<
    string,
    { request: WorkCommentWrite; comment: WorkComment; revision: number }
  >();
  const listeners = new Set<(snapshot: RuntimeSnapshot) => unknown>();
  const publish = () => {
    snapshot.work = {
      available: true,
      count: entries.size,
      revision: [...entries.values()].reduce((sum, row) => sum + row.revision, 0),
    };
    for (const listener of listeners) listener({ ...snapshot });
  };
  publish();
  const read = vi.fn(async (id: string) => structuredClone(entries.get(id)!));
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
              (query.filter !== 'done' || row.status === 'done'),
          )
          .map(({ description: _description, ...row }) => ({ ...row, progressTruncated: false })),
      },
    }),
  );
  const discussion = vi.fn(async (query: WorkCommentQuery): Promise<WorkCommentList> => {
    const rows = comments
      .filter(
        (row) =>
          row.comment.item === query.item && (query.before === undefined || row.seq < query.before),
      )
      .sort((a, b) => b.seq - a.seq);
    const selected = rows.slice(0, query.limit ?? 50);
    return {
      query,
      page: {
        item: query.item,
        revision: entries.get(query.item)!.revision,
        comments: selected.map((row) => structuredClone(row.comment)),
        ...(rows.length > selected.length ? { nextBefore: selected.at(-1)!.seq } : {}),
      },
    };
  });
  const acknowledgement = (request: WorkCommentWrite) => {
    const prior = operations.get(workCommentKey(request, { kind: 'human' }));
    return prior
      ? {
          state: 'complete',
          request,
          actor: { kind: 'human' },
          acceptedRevision: prior.revision,
          acceptedAt: at,
          item: structuredClone(entries.get(request.item)!),
          comment: structuredClone(prior.comment),
        }
      : { state: 'unknown', request, actor: { kind: 'human' } };
  };
  const saveComment = (request: WorkCommentWrite) => {
    if (operations.has(workCommentKey(request, { kind: 'human' }))) return acknowledgement(request);
    const current = entries.get(request.item)!;
    if (current.deleted) throw Error('WORK_TRASHED');
    if (current.revision !== request.revision) throw Error('WORK_CONFLICT');
    const comment: WorkComment = {
      id: request.id,
      item: request.item,
      body: request.body,
      createdAt: at,
      createdBy: { kind: 'human' },
    };
    current.revision++;
    current.updatedBy = { kind: 'human' };
    comments.push({ comment, seq: comments.length + 1 });
    operations.set(workCommentKey(request, { kind: 'human' }), {
      request,
      comment,
      revision: current.revision,
    });
    publish();
    return acknowledgement(request);
  };
  const writeComment = vi.fn(async (request: WorkCommentWrite) => {
    expect(
      commentCard(restore(localStorage.getItem(storageKey)).comments, request.item).pending
        ?.request,
    ).toEqual(request);
    return saveComment(request);
  });
  const receipt = vi.fn(async (request: WorkCommentWrite) => acknowledgement(request));
  const write = vi.fn(async (request: WorkWrite) => {
    expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(request);
    const row = entries.get(request.item)!;
    if (request.revision !== row.revision) throw Error('WORK_CONFLICT');
    if (request.action === 'update') Object.assign(row, request.value);
    else if (request.action !== 'create') row.deleted = request.action === 'trash';
    row.revision++;
    publish();
    return {
      state: 'complete',
      request,
      actor: { kind: 'human' },
      acceptedRevision: row.revision,
      acceptedAt: at,
      item: structuredClone(row),
    };
  });
  const calls: RuntimeCommand[] = [];
  const bridge: RuntimeBridge = {
    async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
      calls.push(command);
      try {
        let value: unknown;
        if (command.type === 'status') value = snapshot;
        else if (command.type === 'chat.history')
          value = { bot: command.bot, revision: command.revision, items: [] };
        else if (command.type === 'work.list') value = await list(command.query);
        else if (command.type === 'work.read') value = await read(command.id);
        else if (command.type === 'work.write') value = await write(command.request);
        else if (command.type === 'work.receipt')
          value = { state: 'unknown', request: command.request, actor: { kind: 'human' } };
        else if (command.type === 'work.comments') value = await discussion(command.query);
        else if (command.type === 'work.comment') value = await writeComment(command.request);
        else if (command.type === 'work.comment-receipt') value = await receipt(command.request);
        else throw Error('MOCK_UNEXPECTED_COMMAND');
        return { ok: true, value: value as T };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'MOCK_FAILED' };
      }
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
  const add = (
    id: string,
    body: string,
    author: WorkComment['createdBy'] = { kind: 'bot', bot: 'a' },
  ) => {
    const parent = entries.get(id)!;
    parent.revision++;
    comments.push({
      seq: comments.length + 1,
      comment: {
        id: `mock-comment-${comments.length + 1}`,
        item: id,
        body,
        createdAt: at,
        createdBy: author,
      },
    });
    publish();
  };
  return {
    entries,
    comments,
    calls,
    read,
    write,
    discussion,
    writeComment,
    saveComment,
    receipt,
    acknowledgement,
    snapshot,
    publish,
    add,
  };
}
const fixture = () =>
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
async function open(title = '合成任务甲') {
  await userEvent.click(await screen.findByRole('button', { name: /^任务(?:\s|$)/ }));
  await userEvent.click(await screen.findByRole('button', { name: `查看 ${title}` }));
  return screen.findByRole('textbox', { name: '评论正文' });
}
const cache = () => restore(localStorage.getItem(storageKey)).comments;

it('shows literal discussion and keeps independent per-card comment drafts without starting a task', async () => {
  const live = connect();
  live.add('mock-alpha', '合成参考 <script>MOCK()</script>');
  fixture();
  await userEvent.type(await open(), 'MOCK ALPHA DRAFT');
  const history = await screen.findByRole('region', { name: '任务讨论记录' });
  expect(within(history).getByText('合成参考 <script>MOCK()</script>')).toBeVisible();
  expect(history.querySelector('script')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '查看 合成任务乙' }));
  await userEvent.type(await screen.findByRole('textbox', { name: '评论正文' }), 'MOCK BETA DRAFT');
  await userEvent.click(screen.getByRole('button', { name: '查看 合成任务甲' }));
  expect(await screen.findByRole('textbox', { name: '评论正文' })).toHaveValue('MOCK ALPHA DRAFT');
  expect(commentCard(cache(), 'mock-beta').draft?.body).toBe('MOCK BETA DRAFT');
  expect(live.writeComment).not.toHaveBeenCalled();
  expect(live.write).not.toHaveBeenCalled();
  expect(
    live.calls.every(
      (call) => ['status', 'chat.history'].includes(call.type) || call.type.startsWith('work.'),
    ),
  ).toBe(true);
});

it('publishes persisted exact intent and advances parent revision while preserving unsaved task edits', async () => {
  const live = connect();
  fixture();
  await userEvent.type(await open(), ' 合成评论原文 ');
  await userEvent.clear(screen.getByRole('textbox', { name: '任务标题' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成本机未保存任务标题');
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeUndefined());
  expect(live.comments[0].comment.body).toBe(' 合成评论原文 ');
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveValue('合成本机未保存任务标题');
  await userEvent.click(screen.getByRole('button', { name: '保存任务' }));
  await waitFor(() => expect(live.write).toHaveBeenCalledTimes(1));
  expect(live.write.mock.calls[0][0].revision).toBe(2);
});

it('reopens an uncertain accepted comment through receipts only and keeps newer task content', async () => {
  const live = connect();
  live.receipt.mockImplementation(async (request) => ({
    state: 'unknown',
    request,
    actor: { kind: 'human' },
  }));
  live.writeComment.mockImplementation(async (request) => {
    live.saveComment(request);
    throw Error('RUNTIME_OFFLINE');
  });
  const view = fixture();
  await userEvent.type(await open(), '合成结果待确认');
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeDefined());
  view.unmount();
  const current = live.entries.get('mock-alpha')!;
  current.revision++;
  current.description = 'MOCK NEWER HUMAN DETAIL';
  live.receipt.mockImplementation(async (request) => live.acknowledgement(request));
  fixture();
  await userEvent.click(await screen.findByRole('button', { name: '任务' }));
  await waitFor(() => expect(live.receipt).toHaveBeenCalled());
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeUndefined());
  expect(live.writeComment).toHaveBeenCalledTimes(1);
  expect(live.comments).toHaveLength(1);
  expect(await screen.findByRole('textbox', { name: '任务说明' })).toHaveValue(
    'MOCK NEWER HUMAN DETAIL',
  );
});

it('retains unknown results and explicitly retries only the original comment request', async () => {
  const live = connect();
  live.writeComment.mockRejectedValueOnce(Error('RUNTIME_OFFLINE'));
  fixture();
  await userEvent.type(await open(), '合成原请求重试');
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(1));
  const original = structuredClone(live.writeComment.mock.calls[0][0]);
  await userEvent.click(await screen.findByRole('button', { name: '核对发表结果' }));
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '保存任务' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: '重试同一条评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(2));
  expect(live.writeComment.mock.calls[1][0]).toEqual(original);
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeUndefined());
});

it('late acknowledgements cannot clear another card draft or redirect the task editor', async () => {
  const live = connect();
  let release!: () => unknown;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  live.writeComment.mockImplementationOnce(async (request) => {
    const value = live.saveComment(request);
    await gate;
    return value;
  });
  fixture();
  await userEvent.type(await open(), '合成评论甲');
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole('button', { name: '查看 合成任务乙' }));
  await userEvent.type(
    await screen.findByRole('textbox', { name: '评论正文' }),
    'MOCK BETA UNSENT',
  );
  await act(async () => {
    release();
  });
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue('MOCK BETA UNSENT');
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveValue('合成任务乙');
  await userEvent.click(screen.getByRole('button', { name: '查看 合成任务甲' }));
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeUndefined());
  expect(commentCard(cache(), 'mock-beta').draft?.body).toBe('MOCK BETA UNSENT');
});

it('allows draft editing during recovery but fences publish and keeps old-runtime drafts without new commands', async () => {
  const live = connect();
  live.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
  const view = fixture();
  await userEvent.type(await open(), 'MOCK RECOVERY DRAFT');
  expect(screen.getByRole('button', { name: '发表评论' })).toBeDisabled();
  expect(live.writeComment).not.toHaveBeenCalled();
  view.unmount();
  const old = connect({ protocol: 37, comments: cache() });
  fixture();
  expect(await open()).toHaveValue('MOCK RECOVERY DRAFT');
  expect(screen.getByRole('button', { name: '发表评论' })).toBeDisabled();
  expect(
    old.calls.some(
      (call) =>
        call.type === 'work.comments' ||
        call.type === 'work.comment' ||
        call.type === 'work.comment-receipt',
    ),
  ).toBe(false);
});

it('reviews material parent changes before sending and keeps comment body on a concurrent conflict', async () => {
  const live = connect();
  fixture();
  await userEvent.type(await open(), '合成保留的评论正文');
  live.entries.get('mock-alpha')!.description = 'MOCK EXTERNAL TASK CHANGE';
  live.entries.get('mock-alpha')!.revision++;
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '任务说明' })).toHaveValue(
      'MOCK EXTERNAL TASK CHANGE',
    ),
  );
  expect(live.writeComment).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue('合成保留的评论正文');
  live.writeComment.mockImplementationOnce(async () => {
    live.entries.get('mock-alpha')!.revision++;
    throw Error('WORK_CONFLICT');
  });
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeUndefined());
  expect(screen.getByRole('textbox', { name: '评论正文' })).not.toHaveAttribute('readonly');
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue('合成保留的评论正文');
});

it('keeps failed discussion loads distinct from empty history and never accepts a foreign receipt', async () => {
  const live = connect();
  const readDiscussion = live.discussion.getMockImplementation()!;
  live.discussion.mockRejectedValue(Error('WORK_UNAVAILABLE'));
  fixture();
  await open();
  expect(await screen.findByText(/讨论暂时无法读取/)).toBeVisible();
  expect(screen.queryByText('还没有讨论')).not.toBeInTheDocument();
  live.discussion.mockImplementation(readDiscussion);
  live.add('mock-alpha', '合成可恢复历史');
  const refresh = screen.getByRole('button', { name: '刷新讨论' });
  expect(refresh).toHaveTextContent(/^$/);
  expect(refresh.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  await userEvent.click(refresh);
  expect(await screen.findByText('合成可恢复历史')).toBeVisible();
  live.writeComment.mockImplementationOnce(async (request) => ({
    ...live.saveComment(request),
    actor: { kind: 'bot', bot: 'mock-forged' },
  }));
  live.receipt.mockImplementation(async (request) => ({
    state: 'unknown',
    request,
    actor: { kind: 'human' },
  }));
  await userEvent.type(screen.getByRole('textbox', { name: '评论正文' }), '合成不接受伪造回执');
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeDefined());
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue('合成不接受伪造回执');
});

it('does not publish when persisting the pending comment fails', async () => {
  const live = connect();
  fixture();
  await userEvent.type(await open(), 'MOCK STORAGE DRAFT');
  const set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, raw) {
    if (key === storageKey && JSON.parse(raw).state.comments?.cards['mock-alpha']?.pending)
      throw Error('MOCK_QUOTA');
    return set.call(this, key, raw);
  });
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  expect(await screen.findByText(/评论尚未发送/)).toBeVisible();
  expect(live.writeComment).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue('MOCK STORAGE DRAFT');
});

it('pages older literal comments and reviews external task edits without losing either draft', async () => {
  const live = connect();
  for (let i = 1; i <= 12; i++) live.add('mock-alpha', `合成讨论第 ${i} 条`);
  fixture();
  await open();
  expect(await screen.findByText('合成讨论第 12 条')).toBeVisible();
  expect(screen.queryByText('合成讨论第 1 条')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '加载更早的评论' }));
  expect(await screen.findByText('合成讨论第 1 条')).toBeVisible();
  expect(screen.getAllByText('合成讨论第 12 条')).toHaveLength(1);
  await userEvent.type(screen.getByRole('textbox', { name: '评论正文' }), '合成保留评论');
  await userEvent.clear(screen.getByRole('textbox', { name: '任务标题' }));
  await userEvent.type(screen.getByRole('textbox', { name: '任务标题' }), '合成本机保留标题');
  live.entries.get('mock-alpha')!.description = 'MOCK LATER EXTERNAL DETAIL';
  live.entries.get('mock-alpha')!.revision++;
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  expect(await screen.findByText('后台当前内容')).toBeVisible();
  expect(live.writeComment).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveValue('合成本机保留标题');
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue('合成保留评论');
  await userEvent.click(screen.getByRole('button', { name: '保留我的更改' }));
  expect(screen.getByRole('textbox', { name: '任务说明' })).toHaveValue(
    'MOCK LATER EXTERNAL DETAIL',
  );
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('textbox', { name: '任务标题' })).toHaveValue('合成本机保留标题');
});

it('shows the original uncertain body while preserving a recovered later draft for after confirmation', async () => {
  const original = { key: 'mock-original-draft', body: '合成原评论请求' };
  const request: WorkCommentWrite = {
    id: 'mock-recovered-op',
    item: 'mock-alpha',
    revision: 1,
    body: original.body,
  };
  const later = { key: 'mock-later-draft', body: '合成后续本机草稿' };
  const live = connect({
    comments: { cards: { 'mock-alpha': { draft: later, pending: { draft: original, request } } } },
  });
  fixture();
  expect(await open()).toHaveValue(original.body);
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveAttribute('readonly');
  live.saveComment(request);
  await userEvent.click(screen.getByRole('button', { name: '核对发表结果' }));
  await waitFor(() => expect(commentCard(cache(), 'mock-alpha').pending).toBeUndefined());
  expect(screen.getByRole('textbox', { name: '评论正文' })).toHaveValue(later.body);
  expect(live.writeComment).not.toHaveBeenCalled();
});

it('advances another card after a comment without disturbing a pending task write', async () => {
  const original = {
    ...workDraft(item('mock-alpha', '合成任务甲'), 'mock-alpha-editor'),
    title: '合成任务甲待确认修改',
  };
  const work: WorkState = {
    mode: 'list',
    filter: 'all',
    text: '',
    draft: workDraft(item('mock-beta', '合成任务乙'), 'mock-beta-editor'),
    pending: {
      draft: original,
      request: {
        id: 'mock-alpha-operation',
        item: 'mock-alpha',
        revision: 1,
        action: 'update',
        value: { title: original.title },
      },
    },
  };
  const live = connect({ work });
  fixture();
  await userEvent.type(await open('合成任务乙'), '合成乙评论独立保存');
  await userEvent.click(screen.getByRole('button', { name: '发表评论' }));
  await waitFor(() => expect(live.writeComment).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(commentCard(cache(), 'mock-beta').pending).toBeUndefined());
  expect(restore(localStorage.getItem(storageKey)).work?.draft?.base?.revision).toBe(2);
  expect(restore(localStorage.getItem(storageKey)).work?.pending?.request).toEqual(
    work.pending!.request,
  );
});
