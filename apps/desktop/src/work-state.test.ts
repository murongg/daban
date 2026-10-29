import type { WorkAck, WorkItem } from '@daban/protocol';
import { expect, it } from 'vitest';
import { initialState, reduce } from './state';
import { restore, serialize, storageKey } from './storage';
import {
  mergeWork,
  reduceWork,
  restoreWork,
  workDirty,
  workDraft,
  workInitial,
  workInput,
} from './work-state';

const item: WorkItem = {
  id: 'mock-card',
  title: '合成标题',
  description: 'MOCK DETAIL',
  progress: 'MOCK ORIGINAL',
  status: 'todo',
  revision: 1,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: { kind: 'human' },
  updatedBy: { kind: 'human' },
};

it('builds create/partial update intents while retaining draft text outside server quotas', () => {
  const fresh = workDraft();
  expect(workDirty(fresh)).toBe(false);
  expect(workInput(fresh, 'mock-op', 'mock-new')).toBeUndefined();
  const filled = { ...fresh, title: ' 合成新卡片 ' };
  expect(workInput(filled, 'mock-op', 'mock-new')).toMatchObject({
    action: 'create',
    revision: 0,
    item: 'mock-new',
    value: { title: '合成新卡片', description: '', progress: '', status: 'todo' },
  });
  const draft = { ...workDraft(item), title: '合成新标题' };
  expect(workInput(draft, 'mock-edit')).toEqual({
    id: 'mock-edit',
    item: item.id,
    action: 'update',
    revision: 1,
    value: { title: draft.title },
  });
  expect(workInput(workDraft(item), 'mock-noop')).toBeUndefined();
  const restored = restoreWork({
    ...workInitial(),
    draft: { ...draft, description: 'x'.repeat(5000) },
  });
  expect(restored?.draft?.description).toHaveLength(5000);
  expect(workInput(restored!.draft!, 'mock-too-long')).toBeUndefined();
});

it('merges explicit local changes into latest data without reverting untouched fields', () => {
  const draft = { ...workDraft(item), title: '合成我的更改' };
  const latest = { ...item, revision: 2, progress: 'MOCK OTHER BOT PROGRESS' };
  const merged = mergeWork(draft, latest);
  expect(merged.key).toBe(draft.key);
  expect(merged.title).toBe(draft.title);
  expect(merged.progress).toBe(latest.progress);
  expect(merged.base?.revision).toBe(2);
  expect(workInput(merged, 'mock-merge')).toMatchObject({
    revision: 2,
    value: { title: draft.title },
  });
});

it('rejects an older detail response for the same card after a newer base was observed', () => {
  const draft = workDraft({ ...item, revision: 3 });
  const current = { ...workInitial(), draft };
  expect(reduceWork(current, { type: 'work-draft', previous: draft, draft: workDraft(item) })).toBe(
    current,
  );
});

it('binds pending settlement to the original request and editor, without reopening or clearing another draft', () => {
  const draft = { ...workDraft(item), title: '合成待保存标题' };
  const request = workInput(draft, 'mock-save')!;
  const pending = { request, draft };
  let current = reduceWork({ ...workInitial(), draft }, { type: 'work-pending', pending });
  expect(current.pending).toEqual(pending);
  expect(
    reduceWork(current, { type: 'work-change', key: draft.key, patch: { title: 'MOCK SEALED' } }),
  ).toBe(current);
  const next = { ...workDraft(), title: 'MOCK NEW EDITOR' };
  current = reduceWork(current, { type: 'work-draft', previous: draft, draft: next });
  const receipt: WorkAck = {
    request,
    actor: { kind: 'human' },
    state: 'complete',
    acceptedRevision: 2,
    acceptedAt: item.updatedAt,
    item: { ...item, title: draft.title, revision: 2 },
  };
  expect(
    reduceWork(current, {
      type: 'work-settle',
      receipt: { ...receipt, request: { ...request, id: 'mock-foreign' } },
    }),
  ).toBe(current);
  current = reduceWork(current, { type: 'work-settle', receipt });
  expect(current.pending).toBeUndefined();
  expect(current.draft).toEqual(next);
  expect(reduceWork(current, { type: 'work-draft', previous: draft, draft: workDraft(item) })).toBe(
    current,
  );
});

it('preserves edited fields through a confirmed restore rather than replacing them with saved content', () => {
  const trashed = { ...item, deleted: true };
  const draft = { ...workDraft(trashed), description: 'MOCK RETAINED EDIT' };
  const request = { id: 'mock-restore', item: item.id, revision: 1, action: 'restore' as const };
  const current = reduceWork(
    { ...workInitial(), draft },
    { type: 'work-pending', pending: { request, draft } },
  );
  const next = reduceWork(current, {
    type: 'work-settle',
    receipt: {
      state: 'complete',
      request,
      actor: { kind: 'human' },
      acceptedAt: item.updatedAt,
      acceptedRevision: 2,
      item: { ...item, revision: 2 },
    },
  });
  expect(next.draft?.description).toBe(draft.description);
  expect(next.draft?.base?.deleted).toBe(false);
});

it('isolates damaged optional work state and serializes Tasks navigation for legacy workspace readers', () => {
  const seed = initialState();
  seed.drafts.research = 'MOCK EXISTING CHAT';
  const draft = { ...workDraft(), title: 'MOCK WORK DRAFT' };
  const next = reduce(
    { ...seed, work: { ...workInitial(), draft } },
    { type: 'view', view: 'tasks' },
  );
  const raw = serialize(next);
  expect(JSON.parse(raw).state.view).toBe('chat');
  expect(restore(raw).work?.draft).toEqual(draft);
  const damaged = JSON.parse(raw);
  damaged.state.work.pending = { request: { id: 'mock-corrupt' } };
  const recovered = restore(JSON.stringify(damaged));
  expect(recovered.drafts.research).toBe(seed.drafts.research);
  expect(recovered.work?.draft).toEqual(draft);
  expect(recovered.work?.pending).toBeUndefined();
  expect(recovered.work?.damaged).toBe(true);
  localStorage.setItem(storageKey, raw);
});
