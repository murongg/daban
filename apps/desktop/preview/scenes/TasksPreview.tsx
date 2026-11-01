import {
  agentId,
  isWorkCompleted,
  type RuntimeBridge,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  type WorkComment,
  type WorkCommentWrite,
  type WorkItem,
  type WorkWrite,
  workCommentKey,
  workKey,
} from '@daban/protocol';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { clientCache } from '../../src/cache';
import { demoState as initialState } from '../../src/fixtures';
import { storageKey } from '../../src/storage';
import { workDraft, workInitial, workInput } from '../../src/work-state';
import { previewSnapshot } from '../runtime';
import '../../src/tokens.css';
import '../../src/styles.css';

// Private production-component fixture: every record is synthetic; no host, VM, model or external service is connected.
const query = new URLSearchParams(location.search),
  mode = query.get('mode') ?? 'list';
const discussing = mode.startsWith('discussion');
const at = '2026-10-30T01:20:00Z';
const titles = [
  '合成：核对活动报名表',
  '合成：整理三份产品反馈',
  '合成：准备下周内容清单',
  '合成：比较两版合同条款',
  '合成：补充月度复盘说明',
  '合成：整理已确认的问题',
];
const items = new Map<string, WorkItem>();
if (mode !== 'empty')
  for (let index = 0; index < (mode === 'many' ? 56 : 6); index++) {
    const status = (['todo', 'doing', 'done'] as const)[index % 3];
    const id = `mock-task-${index + 1}`;
    items.set(id, {
      id,
      title: titles[index % titles.length] + (index > 5 ? ` ${index + 1}` : ''),
      status,
      description:
        '合成验收说明：核对本次提供的材料，保留来源和需要进一步确认的问题。这些是界面测试数据。',
      progress:
        index % 3 === 0
          ? ''
          : index % 3 === 1
            ? '已整理现有材料，还需要确认两处信息。'
            : '合成结果已核对，说明与来源均已保留。',
      revision: 1,
      deleted: false,
      createdAt: at,
      updatedAt: at,
      createdBy: { kind: 'human' },
      updatedBy: index % 3 === 0 ? { kind: 'human' } : { kind: 'bot', bot: index % 2 ? 'a' : 'b' },
      ...(status === 'done' ? { completedAt: at } : {}),
    });
  }
const discussionRows: { comment: WorkComment; seq: number }[] = [];
if (discussing) {
  const bodies = [
    '合成确认：这轮只核对已提供的材料，保留需要进一步确认的问题。',
    '合成反馈：已核对三份材料，第二份的来源仍需确认。',
    '合成补充：先在讨论里保留边界，确认后再修改任务。',
    '合成备注：发表评论不会启动其他任务。',
  ];
  for (const [index, body] of bodies.entries())
    discussionRows.push({
      seq: index + 1,
      comment: {
        id: `mock-discussion-${index + 1}`,
        item: 'mock-task-1',
        body:
          mode === 'discussion-long' && index === 3
            ? '合成长文本：保留原始段落与完整的核对说明。\n'.repeat(120)
            : body,
        createdAt: at,
        createdBy: index % 2 ? { kind: 'bot', bot: index === 1 ? 'a' : 'b' } : { kind: 'human' },
      },
    });
  items.get('mock-task-1')!.revision = discussionRows.length + 1;
}
const first = items.get('mock-task-1');
const seed = initialState();
seed.panel = null;
seed.view = 'tasks';
seed.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
for (const bot of seed.bots) {
  bot.name = `合成${bot.name}`;
  seed.messages[bot.id] = [
    { id: `mock-tasks-${bot.id}`, role: 'notice', text: '合成任务界面验收 · 未连接模型或电脑' },
  ];
}
seed.drafts.research = '合成未发送聊天草稿：切换任务后请保留。';
seed.work = { ...workInitial(), mode: mode === 'board' ? 'board' : 'list' };
if (first && (mode === 'editor' || mode === 'conflict' || discussing)) {
  seed.work.draft = workDraft(first);
  if (mode === 'conflict') {
    seed.work.draft.title = '合成：我保留的活动核对标题';
    items.set(first.id, {
      ...first,
      title: '合成：Bot 更新后的活动核对标题',
      progress: '后台合成进展：已核对新增材料，保留本次更新。',
      revision: 2,
      updatedBy: { kind: 'bot', bot: 'b' },
    });
  }
}
if (discussing && first) {
  const draft = {
    key: 'mock-discussion-draft',
    body: '合成评论草稿：补充本次核对的边界，保留来源。',
  };
  seed.comments = { cards: { [first.id]: { draft } } };
  if (mode === 'discussion-pending')
    seed.comments.cards[first.id].pending = {
      draft,
      request: {
        id: 'mock-discussion-op',
        item: first.id,
        revision: first.revision,
        body: draft.body,
      },
    };
  if (mode === 'discussion-conflict') {
    seed.work!.draft!.title = '合成：保留本机未保存的任务标题';
    items.set(first.id, {
      ...first,
      description: '合成外部更新：新增一份材料，保留本次来源和未确认的问题。',
      revision: first.revision + 1,
      updatedBy: { kind: 'bot', bot: 'b' },
    });
  }
}
if (mode === 'pending') {
  const draft = {
    ...workDraft(),
    title: '合成：准备月度复盘',
    description: '合成待确认操作。提交内容已保留，重开仅核对回执。',
  };
  seed.work.draft = draft;
  seed.work.pending = { draft, request: workInput(draft, 'mock-pending-op', 'mock-pending-card')! };
}
if (query.get('keep') !== '1' || !clientCache().getItem(storageKey))
  clientCache().setItem(storageKey, JSON.stringify({ version: 1, state: seed }));
const snapshot = previewSnapshot(['old', 'legacy'].includes(mode) ? 35 : undefined);
snapshot.work =
  mode === 'unavailable'
    ? { available: false, error: 'WORK_CORRUPT' }
    : {
        available: true,
        revision: [...items.values()].reduce((sum, row) => sum + row.revision, 0),
        count: items.size,
      };
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
snapshot.groups = {
  available: true,
  revision: 1,
  items: seed.bots
    .filter((bot) => bot.members)
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      members: bot.members!.map(agentId),
      revision: 1,
      createdAt: at,
      updatedAt: at,
    })),
};
const listeners = new Set<(value: RuntimeSnapshot) => unknown>();
const operations = new Map<string, { request: WorkWrite; acceptedRevision: number }>();
const commentOperations = new Map<
  string,
  { request: WorkCommentWrite; comment: WorkComment; revision: number }
>();
const commentReceipt = (request: WorkCommentWrite) => {
  const saved = commentOperations.get(workCommentKey(request, { kind: 'human' }));
  return saved
    ? {
        state: 'complete',
        request,
        actor: { kind: 'human' },
        comment: saved.comment,
        acceptedRevision: saved.revision,
        acceptedAt: at,
        item: items.get(request.item),
      }
    : { state: 'unknown', request, actor: { kind: 'human' } };
};
const receipt = (saved: { request: WorkWrite; acceptedRevision: number }) => ({
  state: 'complete',
  actor: { kind: 'human' },
  request: saved.request,
  acceptedRevision: saved.acceptedRevision,
  acceptedAt: at,
  item: items.get(saved.request.item),
});
const bridge: RuntimeBridge = {
  async invoke<T>(command: RuntimeCommand): Promise<RuntimeReply<T>> {
    try {
      let value: unknown;
      if (command.type === 'status') value = snapshot;
      else if (command.type === 'work.list') {
        if (mode === 'load-error') throw Error('RUNTIME_REQUEST_FAILED');
        const selected = [...items.values()]
          .reverse()
          .filter(
            (item) =>
              item.deleted === (command.query.filter === 'trash') &&
              (command.query.filter !== 'open' || !isWorkCompleted(item.status)) &&
              (command.query.filter !== 'done' || isWorkCompleted(item.status)) &&
              (command.query.status === undefined || item.status === command.query.status) &&
              (command.query.priority === undefined ||
                (item.priority ?? 'normal') === command.query.priority) &&
              (!Object.hasOwn(command.query, 'assignee') ||
                (item.assignee ?? null) === command.query.assignee) &&
              (!command.query.text ||
                `${item.title} ${item.description} ${item.progress}`.includes(
                  command.query.text,
                )) &&
              (command.query.before === undefined ||
                Number(item.id.split('-').at(-1)) < command.query.before),
          );
        const rows = selected.slice(0, command.query.limit ?? 50);
        value = {
          query: command.query,
          page: {
            revision: snapshot.work?.revision ?? 0,
            items: rows.map(({ description: _description, progress, ...item }) => ({
              ...item,
              progress: Array.from(progress).slice(0, 200).join(''),
              progressTruncated: Array.from(progress).length > 200,
            })),
            ...(selected.length > rows.length
              ? { nextBefore: Number(rows.at(-1)!.id.split('-').at(-1)) }
              : {}),
          },
        };
      } else if (command.type === 'work.read') {
        value = items.get(command.id);
        if (!value) throw Error('WORK_NOT_FOUND');
      } else if (command.type === 'work.receipt') {
        const saved = operations.get(workKey(command.request, { kind: 'human' }));
        value = saved
          ? receipt(saved)
          : { state: 'unknown', actor: { kind: 'human' }, request: command.request };
      } else if (command.type === 'work.comments') {
        if (mode === 'discussion-error') throw Error('RUNTIME_REQUEST_FAILED');
        const rows = discussionRows
          .filter(
            (row) =>
              row.comment.item === command.query.item &&
              (command.query.before === undefined || row.seq < command.query.before),
          )
          .sort((left, right) => right.seq - left.seq);
        const selected = rows.slice(0, command.query.limit ?? 50);
        value = {
          query: command.query,
          page: {
            item: command.query.item,
            revision: items.get(command.query.item)!.revision,
            comments: selected.map((row) => row.comment),
            ...(selected.length < rows.length ? { nextBefore: selected.at(-1)!.seq } : {}),
          },
        };
      } else if (command.type === 'work.comment-receipt') value = commentReceipt(command.request);
      else if (command.type === 'work.comment') {
        if (mode === 'discussion-pending') throw Error('RUNTIME_REQUEST_FAILED');
        const request = command.request,
          key = workCommentKey(request, { kind: 'human' });
        if (commentOperations.has(key)) value = commentReceipt(request);
        else {
          const current = items.get(request.item)!;
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
          discussionRows.push({ comment, seq: discussionRows.length + 1 });
          commentOperations.set(key, { request, comment, revision: current.revision });
          value = commentReceipt(request);
          snapshot.work = {
            available: true,
            revision: [...items.values()].reduce((sum, row) => sum + row.revision, 0),
            count: items.size,
          };
          for (const listener of listeners) listener({ ...snapshot });
        }
      } else if (command.type === 'work.write') {
        if (mode === 'pending') throw Error('RUNTIME_REQUEST_FAILED');
        const request = command.request,
          key = workKey(request, { kind: 'human' });
        const saved = operations.get(key);
        if (saved) return { ok: true, value: receipt(saved) as T };
        const current = items.get(request.item);
        if (request.action === 'create')
          items.set(request.item, {
            id: request.item,
            ...request.value,
            revision: 1,
            deleted: false,
            createdAt: at,
            updatedAt: at,
            createdBy: { kind: 'human' },
            updatedBy: { kind: 'human' },
            ...(isWorkCompleted(request.value.status) ? { completedAt: at } : {}),
          });
        else {
          if (!current) throw Error('WORK_NOT_FOUND');
          if (current.revision !== request.revision) throw Error('WORK_CONFLICT');
          const next = {
            ...current,
            ...(request.action === 'update'
              ? request.value
              : request.action === 'reopen'
                ? { status: 'todo' as const }
                : { deleted: request.action === 'trash' }),
            revision: current.revision + 1,
            updatedBy: { kind: 'human' as const },
          };
          if (isWorkCompleted(next.status)) next.completedAt ||= at;
          else delete next.completedAt;
          items.set(request.item, next);
        }
        const accepted = { request, acceptedRevision: items.get(request.item)!.revision };
        operations.set(key, accepted);
        value = receipt(accepted);
        snapshot.work = {
          available: true,
          count: items.size,
          revision: (snapshot.work?.revision ?? 0) + 1,
        };
        for (const listener of listeners) listener({ ...snapshot });
      } else return { ok: false, error: 'SYNTHETIC_PREVIEW_ONLY' };
      return { ok: true, value: structuredClone(value) as T };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'MOCK_PREVIEW_FAILURE' };
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
createRoot(document.getElementById('root')!).render(<App />);
