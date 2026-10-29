import { groupCopyKey, isGroupCopyReceipt, isGroupCopyRequest } from '@daban/protocol';
import { expect, it } from 'vitest';

const request = {
  id: 'mock-copy-group',
  group: 'mock-source-group',
  revision: 1,
  name: '合成群聊副本',
};
const group = {
  id: request.id,
  name: '合成后续编辑',
  members: ['mock-alpha', 'mock-beta'],
  revision: 3,
  archived: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

it('binds every material request field while refusing legacy personal aliases, self-copy and extra authority', () => {
  expect(isGroupCopyRequest(request)).toBe(true);
  const variants = [
    { ...request, id: 'mock-other-target' },
    { ...request, group: 'mock-other-source' },
    { ...request, revision: 2 },
    { ...request, name: '合成不同名称' },
  ];
  expect(new Set([request, ...variants].map(groupCopyKey)).size).toBe(5);
  for (const value of [
    { ...request, id: 'research' },
    { ...request, id: 'writer' },
    { ...request, id: request.group },
    { ...request, members: group.members },
  ])
    expect(isGroupCopyRequest(value)).toBe(false);
});

it('accepts exact closed receipts with current target edits and keeps private origins or foreign targets out of the DTO', () => {
  expect(isGroupCopyReceipt({ request, state: 'unknown' })).toBe(true);
  expect(isGroupCopyReceipt({ request, state: 'complete', group })).toBe(true);
  for (const value of [
    { request, state: 'unknown', group },
    { request, state: 'complete' },
    { request, state: 'complete', group: { ...group, id: 'mock-foreign-target' } },
    { request, state: 'complete', group: { ...group, copy_origin: 'MOCK PRIVATE ORIGIN' } },
    { request, state: 'complete', group, extra: true },
  ])
    expect(isGroupCopyReceipt(value)).toBe(false);
});
