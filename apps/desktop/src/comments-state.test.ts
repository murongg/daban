import type { WorkCommentAck, WorkCommentWrite, WorkItem } from '@daban/protocol';
import { expect, it } from 'vitest';
import {
  type CommentPending,
  commentCard,
  reduceComments,
  restoreComments,
} from './comments-state';
import { initialState, reduce } from './state';
import { restore, serialize, storageKey } from './storage';
import { workDraft } from './work-state';

const item = (id = 'mock-task', revision = 1): WorkItem => ({
  id,
  revision,
  title: '合成任务',
  description: 'MOCK DETAIL',
  progress: '',
  status: 'todo',
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: { kind: 'human' },
  updatedBy: { kind: 'human' },
});
const request: WorkCommentWrite = {
  id: 'mock-op',
  item: 'mock-task',
  revision: 1,
  body: ' 合成评论\n保持原文 ',
};
const pending: CommentPending = { request, draft: { key: 'mock-draft', body: request.body } };
const ack = (): WorkCommentAck => ({
  state: 'complete',
  request,
  actor: { kind: 'human' },
  acceptedRevision: 2,
  acceptedAt: '2026-01-01T00:00:00Z',
  item: item('mock-task', 2),
  comment: {
    id: request.id,
    item: request.item,
    body: request.body,
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: { kind: 'human' },
  },
});

it('keeps independent literal comment drafts and stable pending intent across workspace restore', () => {
  let state = initialState();
  state = reduce(state, { type: 'comment-draft', item: request.item, draft: pending.draft });
  state = reduce(state, {
    type: 'comment-draft',
    item: 'mock-other',
    draft: { key: 'mock-other-draft', body: '合成另一张任务草稿' },
  });
  state = reduce(state, { type: 'comment-pending', pending });
  const loaded = restore(serialize(state));
  expect(commentCard(loaded.comments, request.item)).toEqual({ draft: pending.draft, pending });
  expect(commentCard(loaded.comments, 'mock-other').draft?.body).toBe('合成另一张任务草稿');
  expect(loaded.messages).toEqual(state.messages);
  expect(storageKey).toBe('daban.workspace.v1');
  expect(commentCard(undefined, '__proto__')).toEqual({});
});

it('seals only the pending card and settles only the exact Human intent', () => {
  let state = reduceComments(undefined, {
    type: 'comment-draft',
    item: request.item,
    draft: pending.draft,
  });
  state = reduceComments(state, { type: 'comment-pending', pending });
  expect(
    reduceComments(state, {
      type: 'comment-draft',
      item: request.item,
      draft: { key: 'mock-replaced', body: 'MOCK LATE CHANGE' },
    }),
  ).toEqual(state);
  for (const bad of [
    { ...ack(), request: { ...request, item: 'mock-other' } },
    { ...ack(), request: { ...request, body: 'MOCK FORGED BODY' } },
    { ...ack(), actor: { kind: 'bot', bot: 'mock-forged' } },
    { state: 'unknown', request, actor: { kind: 'human' } },
  ])
    expect(
      reduceComments(state, { type: 'comment-settle', receipt: bad as WorkCommentAck }),
    ).toEqual(state);
  expect(
    reduceComments(state, {
      type: 'comment-release',
      request: { ...request, id: 'mock-other-op' },
    }),
  ).toEqual(state);
  const released = reduceComments(state, { type: 'comment-release', request });
  expect(commentCard(released, request.item)).toEqual({ draft: pending.draft });
  const settled = reduceComments(state, { type: 'comment-settle', receipt: ack() });
  expect(commentCard(settled, request.item)).toEqual({});
});

it('rejects foreign or damaged pending snapshots while retaining editable body and other cards', () => {
  const loaded = restoreComments({
    cards: {
      [request.item]: {
        draft: pending.draft,
        pending: { ...pending, request: { ...request, item: 'mock-foreign' } },
      },
      'mock-other': { draft: { key: 'mock-draft-b', body: '合成保留正文' } },
      'mock-broken-key': { draft: { key: '../mock-invalid', body: '合成可恢复正文' } },
    },
  });
  expect(loaded?.damaged).toBe(true);
  expect(commentCard(loaded, request.item)).toEqual({ draft: pending.draft });
  expect(commentCard(loaded, 'mock-other').draft?.body).toBe('合成保留正文');
  expect(commentCard(loaded, 'mock-broken-key').draft?.body).toBe('合成可恢复正文');
  const original = initialState();
  const restored = restore(
    JSON.stringify({
      version: 1,
      state: {
        ...original,
        comments: {
          cards: {
            'mock-task': {
              draft: pending.draft,
              pending: { ...pending, request: { ...request, body: 'MOCK MISMATCH' } },
            },
          },
        },
      },
    }),
  );
  expect(restored.messages).toEqual(original.messages);
  expect(restored.comments?.damaged).toBe(true);
  expect(commentCard(restored.comments, request.item).draft?.body).toBe(request.body);
});

it('adopts comment-only parent revisions without discarding task edits and refuses silent content merges', () => {
  const state = initialState();
  state.work = {
    mode: 'list',
    filter: 'all',
    text: '',
    draft: { ...workDraft(item(), 'mock-editor'), title: '合成本机未保存标题' },
  };
  const observed = reduce(state, {
    type: 'work-observe',
    key: 'mock-editor',
    item: item('mock-task', 2),
  });
  expect(observed.work?.draft?.title).toBe('合成本机未保存标题');
  expect(observed.work?.draft?.base?.revision).toBe(2);
  const changed = { ...item('mock-task', 3), description: 'MOCK EXTERNAL DETAIL' };
  expect(reduce(observed, { type: 'work-observe', key: 'mock-editor', item: changed })).toEqual(
    observed,
  );
  const clean = { ...state, work: { ...state.work!, draft: workDraft(item(), 'mock-editor') } };
  expect(
    reduce(clean, { type: 'work-observe', key: 'mock-editor', item: changed }).work?.draft
      ?.description,
  ).toBe('MOCK EXTERNAL DETAIL');
  expect(
    reduce(observed, { type: 'work-observe', key: 'mock-other-editor', item: changed }),
  ).toEqual(observed);
});

it('recovers valid pending intent from its own snapshot and preserves a distinct later draft', () => {
  const missing = restoreComments({ cards: { [request.item]: { pending } } });
  expect(commentCard(missing, request.item)).toEqual({ draft: pending.draft, pending });
  const later = { key: 'mock-later-draft', body: '合成后续未发送正文' };
  const recovered = restoreComments({ cards: { [request.item]: { draft: later, pending } } });
  expect(commentCard(recovered, request.item)).toEqual({ draft: later, pending });
  const accepted = reduceComments(recovered, { type: 'comment-settle', receipt: ack() });
  expect(commentCard(accepted, request.item)).toEqual({ draft: later });
});

it('observes a different task while an independent task write remains pending', () => {
  const state = initialState();
  const other = { ...workDraft(item('mock-other'), 'mock-other-editor'), title: 'MOCK OTHER EDIT' };
  state.work = {
    mode: 'list',
    filter: 'all',
    text: '',
    draft: { ...workDraft(item(), 'mock-editor'), title: '合成本机标题' },
    pending: {
      draft: other,
      request: {
        id: 'mock-other-operation',
        item: 'mock-other',
        revision: 1,
        action: 'update',
        value: { title: other.title },
      },
    },
  };
  const next = reduce(state, {
    type: 'work-observe',
    key: 'mock-editor',
    item: item('mock-task', 2),
  });
  expect(next.work?.draft?.base?.revision).toBe(2);
  expect(next.work?.draft?.title).toBe('合成本机标题');
  expect(next.work?.pending).toEqual(state.work.pending);
});
