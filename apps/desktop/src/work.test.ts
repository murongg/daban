import {
  isWorkAuthor,
  isWorkItem,
  isWorkList,
  isWorkQuery,
  isWorkReceipt,
  isWorkStatus,
  isWorkWrite,
  workKey,
  workQueryKey,
} from '@daban/protocol';
import { expect, it } from 'vitest';

const actor = { kind: 'human' as const };
const request = {
  id: 'mock-op',
  item: 'mock-work',
  revision: 1,
  action: 'update' as const,
  value: { title: '合成共享待办', status: 'done' as const },
};
const item = {
  id: request.item,
  title: '合成后续编辑',
  description: '',
  progress: 'MOCK VERIFIED PROGRESS',
  status: 'done' as const,
  revision: 3,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-03T00:00:00Z',
  completedAt: '2026-01-02T00:00:00Z',
  createdBy: actor,
  updatedBy: { kind: 'bot' as const, bot: 'mock-alpha' },
};

it('keeps operation identity stable across patch key order while binding actor, target, revision and fields', () => {
  expect(isWorkWrite(request)).toBe(true);
  expect(
    workKey({ ...request, value: { status: 'done', title: request.value.title } }, actor),
  ).toBe(workKey(request, actor));
  const keys = [
    workKey(request, actor),
    workKey({ ...request, id: 'mock-other-op' }, actor),
    workKey({ ...request, item: 'mock-other-item' }, actor),
    workKey({ ...request, revision: 2 }, actor),
    workKey({ ...request, value: { title: '合成不同字段' } }, actor),
    workKey(request, { kind: 'bot', bot: 'mock-alpha' }),
  ];
  expect(new Set(keys).size).toBe(keys.length);
  for (const value of [
    { ...request, createdBy: actor },
    { ...request, revision: 0 },
    { ...request, value: {} },
    { ...request, value: { status: 'running' } },
  ])
    expect(isWorkWrite(value)).toBe(false);
  expect(isWorkAuthor({ kind: 'human', bot: 'mock-forged' })).toBe(false);
  expect(isWorkQuery({ filter: ['all'] })).toBe(false);
});

it('validates bounded public availability without publishing private diagnostics', () => {
  expect(isWorkStatus({ available: true, revision: 0, count: 0 })).toBe(true);
  expect(isWorkStatus({ available: false, error: 'WORK_CORRUPT' })).toBe(true);
  for (const value of [
    { available: true, revision: -1, count: 0 },
    { available: true, revision: 10001, count: 1 },
    { available: true, revision: 1, count: 1001 },
    { available: true, revision: 1 },
    { available: false, error: 'MOCK SECRET DETAIL' },
    { available: false, error: 'WORK_CORRUPT', file: '/mock-private' },
  ])
    expect(isWorkStatus(value)).toBe(false);
});

it('validates closed bounded summaries, distinct cards and forward-only query-bound pages', () => {
  const { description: _description, ...summary } = item;
  const query = { filter: 'done' as const, before: 20, limit: 1 };
  const list = {
    query,
    page: { revision: 3, items: [{ ...summary, progressTruncated: false }], nextBefore: 10 },
  };
  expect(isWorkList(list)).toBe(true);
  expect(workQueryKey({ limit: 50, filter: 'all', text: '' })).toBe(workQueryKey({}));
  expect(workQueryKey(query)).toBe(workQueryKey({ limit: 1, before: 20, filter: 'done' }));
  for (const value of [
    { ...list, page: { ...list.page, nextBefore: 20 } },
    { ...list, page: { ...list.page, items: [] } },
    { ...list, page: { ...list.page, items: [item] } },
    { ...list, page: { ...list.page, items: [{ ...summary, progressTruncated: true }] } },
    {
      ...list,
      page: {
        ...list.page,
        items: [{ ...summary, progress: '😀'.repeat(201), progressTruncated: true }],
      },
    },
    { ...list, query: { ...query, filter: 'open' } },
    { ...list, query: { ...query, filter: 'trash' } },
    { ...list, query: {}, page: { ...list.page, items: [list.page.items[0], list.page.items[0]] } },
    { ...list, query: { ...query, bot: 'mock-forged' } },
    { ...list, privateSequence: 1 },
  ])
    expect(isWorkList(value)).toBe(false);
  expect(isWorkList({ query: {}, page: { revision: 0, items: [] } })).toBe(true);
});

it('validates truthful completion and accepted/current receipt revisions without exposing operation authority', () => {
  expect(isWorkItem(item)).toBe(true);
  expect(isWorkItem({ ...item, status: 'todo' })).toBe(false);
  expect(isWorkItem({ ...item, completedAt: undefined })).toBe(false);
  const receipt = {
    state: 'complete',
    request,
    actor,
    acceptedRevision: 2,
    acceptedAt: '2026-01-02T00:00:00Z',
    item,
  };
  expect(isWorkReceipt(receipt)).toBe(true);
  expect(isWorkReceipt({ state: 'unknown', request, actor })).toBe(true);
  for (const value of [
    { ...receipt, acceptedRevision: 3 },
    { ...receipt, item: { ...item, id: 'mock-foreign' } },
    { ...receipt, signature: 'MOCK PRIVATE HASH' },
    { state: 'unknown', request, actor, item },
  ])
    expect(isWorkReceipt(value)).toBe(false);
});
