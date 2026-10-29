import { expect, it } from 'vitest';
import { initialState, reduce } from './state';
import { restore, serialize } from './storage';

const request = { id: 'mock-copy-target', bot: 'a', revision: 1, name: '合成副本', memory: true };

it('seals one copy request without creating a target placeholder or changing source drafts and controls', () => {
  let state = initialState();
  state.drafts.research = 'MOCK-SOURCE-DRAFT';
  const before = structuredClone(state);
  state = reduce(state, { type: 'bot-copy-pending', request });
  expect(state.botCopy).toEqual(request);
  expect(state.bots).toEqual(before.bots);
  expect(state.drafts).toEqual(before.drafts);
  expect(state.controls).toEqual(before.controls);
  state = reduce(state, {
    type: 'bot-copy-pending',
    request: { ...request, name: '合成后续输入' },
  });
  expect(state.botCopy).toEqual(request);
  expect(restore(serialize(state)).botCopy).toEqual(request);
  state = reduce(state, { type: 'bot-copy-clear', request: { ...request, memory: false } });
  expect(state.botCopy).toEqual(request);
  state = reduce(state, { type: 'bot-copy-clear', request });
  expect(state.botCopy).toBeUndefined();
});

it('drops only damaged optional copy metadata, preserving other workspace data and valid legacy snapshots', () => {
  const state = initialState();
  state.drafts.writer = 'MOCK-OTHER-DRAFT';
  const raw = JSON.parse(serialize(state));
  raw.state.botCopy = { ...request, id: 'research' };
  const repaired = restore(JSON.stringify(raw));
  expect(repaired.botCopy).toBeUndefined();
  expect(repaired.messages).toEqual(state.messages);
  expect(repaired.drafts.writer).toBe('MOCK-OTHER-DRAFT');
  expect(restore(serialize(repaired))).toEqual(repaired);
});

it('seals and restores a group copy independently of personal copy and preserves all drafts without a placeholder', () => {
  const request = { id: 'mock-group-copy', group: 'crew', revision: 1, name: '合成群聊副本' };
  let state = initialState();
  state.drafts.crew = 'MOCK GROUP DRAFT';
  state.botCopy = {
    id: 'mock-personal-pending',
    bot: 'a',
    revision: 1,
    name: '合成个人副本',
    memory: true,
  };
  const before = structuredClone(state);
  state = reduce(state, { type: 'group-copy-pending', request });
  expect(state.groupCopy).toEqual(request);
  expect(state.bots).toEqual(before.bots);
  expect(state.drafts).toEqual(before.drafts);
  expect(restore(serialize(state)).groupCopy).toEqual(request);
  state = reduce(state, {
    type: 'group-copy-clear',
    request: { ...request, name: '合成不同请求' },
  });
  expect(state.groupCopy).toEqual(request);
  state = reduce(state, { type: 'group-copy-clear', request });
  expect(state.groupCopy).toBeUndefined();
  expect(state.botCopy).toEqual(before.botCopy);
  const raw = JSON.parse(serialize(before));
  raw.state.groupCopy = { ...request, id: 'research' };
  const repaired = restore(JSON.stringify(raw));
  expect(repaired.groupCopy).toBeUndefined();
  expect(repaired.drafts.crew).toBe('MOCK GROUP DRAFT');
});
