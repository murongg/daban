import {
  isWorkComment,
  isWorkCommentPage,
  isWorkCommentQuery,
  isWorkCommentReceipt,
  isWorkCommentWrite,
  type WorkItem,
  workCommentKey,
  workKey,
} from '@daban/protocol';
import { expect, it } from 'vitest';

const actor = { kind: 'human' as const };
const request = {
  id: 'mock-comment',
  item: 'mock-card',
  revision: 1,
  body: 'MOCK COMMENT\n保留缩进。',
};
const at = '2026-01-02T00:00:00Z';
const comment = {
  id: request.id,
  item: request.item,
  body: request.body,
  createdAt: at,
  createdBy: actor,
};
const item: WorkItem = {
  id: request.item,
  title: '合成共享任务',
  description: '',
  progress: '',
  status: 'todo',
  revision: 3,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: at,
  createdBy: actor,
  updatedBy: { kind: 'bot', bot: 'mock-alpha' },
};

it('closes comment inputs while preserving literal text and binding actor/item/revision/intent', () => {
  expect(isWorkCommentWrite(request)).toBe(true);
  expect(
    workCommentKey({ body: request.body, revision: 1, item: request.item, id: request.id }, actor),
  ).toBe(workCommentKey(request, actor));
  expect(
    new Set([
      workCommentKey(request, actor),
      workCommentKey({ ...request, item: 'mock-other' }, actor),
      workCommentKey({ ...request, id: 'mock-other' }, actor),
      workCommentKey({ ...request, revision: 2 }, actor),
      workCommentKey({ ...request, body: request.body + ' ' }, actor),
      workCommentKey(request, { kind: 'bot', bot: 'mock-alpha' }),
    ]).size,
  ).toBe(6);
  for (const bad of [
    { ...request, actor },
    { ...request, createdBy: actor },
    { ...request, body: '  ' },
    { ...request, body: 'x'.repeat(10001) },
    { ...request, body: 'MOCK\0' },
    { ...request, revision: 0 },
    { ...request, item: '../mock' },
    Object.assign(Object.create({ inherited: true }), request),
  ])
    expect(isWorkCommentWrite(bad)).toBe(false);
  expect(
    workKey(
      {
        id: 'mock-legacy',
        item: 'mock-card',
        revision: 1,
        action: 'update',
        value: { progress: 'MOCK' },
      },
      actor,
    ),
  ).toBe(
    '["daban.work.v1","mock-legacy","mock-card",1,"update","human",null,["title"],["description"],["progress","MOCK"],["status"]]',
  );
});

it('validates item-bound bounded immutable comment pages and closed cursors', () => {
  expect(isWorkComment(comment)).toBe(true);
  expect(isWorkCommentQuery({ item: request.item, limit: 50, before: 2 })).toBe(true);
  for (const bad of [
    {},
    { item: request.item, limit: 51 },
    { item: request.item, before: 0 },
    { item: request.item, text: 'MOCK' },
  ])
    expect(isWorkCommentQuery(bad)).toBe(false);
  const page = { item: request.item, revision: 3, comments: [comment], nextBefore: 2 };
  expect(isWorkCommentPage(page)).toBe(true);
  for (const bad of [
    { ...page, item: 'mock-other' },
    { ...page, comments: [comment, comment] },
    { ...page, comments: [] },
    { ...page, nextBefore: 0 },
    { ...page, revision: 0 },
    { ...page, comments: [{ ...comment, updatedAt: at }] },
    { ...page, revision: 1 },
    { ...page, comments: Array(2) },
    {
      ...page,
      revision: 4,
      comments: [0, 1, 2].map((i) => ({
        ...comment,
        id: `mock-large-${i}`,
        body: '\u0001'.repeat(10000),
      })),
    },
  ])
    expect(isWorkCommentPage(bad)).toBe(false);
});

it('binds accepted/current receipts to exact request, body, author and item without claiming unknown success', () => {
  const receipt = {
    state: 'complete',
    request,
    actor,
    acceptedRevision: 2,
    acceptedAt: at,
    item,
    comment,
  };
  expect(isWorkCommentReceipt(receipt)).toBe(true);
  expect(isWorkCommentReceipt({ state: 'unknown', request, actor })).toBe(true);
  for (const bad of [
    { ...receipt, acceptedRevision: 1 },
    { ...receipt, item: { ...item, revision: 1 } },
    { ...receipt, comment: { ...comment, body: 'MOCK OTHER' } },
    { ...receipt, comment: { ...comment, createdBy: { kind: 'bot', bot: 'mock-alpha' } } },
    { ...receipt, comment: { ...comment, item: 'mock-other' } },
    { ...receipt, comment: { ...comment, id: 'mock-other' } },
    { ...receipt, acceptedAt: '2025-01-01T00:00:00Z' },
    { state: 'unknown', request, actor, comment },
  ])
    expect(isWorkCommentReceipt(bad)).toBe(false);
});
