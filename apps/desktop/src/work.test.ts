import {
  isWorkAuthor,
  isWorkItem,
  isWorkQuery,
  isWorkReceipt,
  isWorkWrite,
  workKey,
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
