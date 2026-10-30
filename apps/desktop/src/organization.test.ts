import { expect, it } from 'vitest';
import { demoState as initialState } from './fixtures';
import { reduce } from './state';
import { restore, serialize } from './storage';

it('pins once, retains membership on unpin and removes a section without changing Bot data', () => {
  let state = initialState();
  const original = structuredClone(state);
  state = reduce(state, { type: 'section-create', id: 'mock-section', name: '合成项目' });
  state = reduce(state, { type: 'bot-section', bot: 'research', section: 'mock-section' });
  state = reduce(state, { type: 'bot-pin', bot: 'research', pinned: true });
  state = reduce(state, { type: 'bot-pin', bot: 'research', pinned: true });
  expect(state.organization.pins).toEqual(['research']);
  expect(state.organization.placements.research).toBe('mock-section');
  state = reduce(state, { type: 'bot-pin', bot: 'research', pinned: false });
  expect(state.organization.placements.research).toBe('mock-section');
  state = reduce(state, { type: 'section-rename', id: 'mock-section', name: '合成重命名' });
  expect(restore(serialize(state)).organization).toEqual(state.organization);
  state = reduce(state, { type: 'section-remove', id: 'mock-section' });
  expect(state.organization.sections).toEqual([]);
  expect(state.organization.placements.research).toBeUndefined();
  expect(state.bots).toEqual(original.bots);
  expect(state.messages).toEqual(original.messages);
  expect(state.drafts).toEqual(original.drafts);
  expect(state.controls).toEqual(original.controls);
});

it('keeps stable section identity, collapse and ordering while refusing invalid operations', () => {
  let state = initialState();
  state = reduce(state, { type: 'section-create', id: 'mock-one', name: '合成一' });
  state = reduce(state, { type: 'section-create', id: 'mock-two', name: '合成二' });
  state = reduce(state, { type: 'section-collapse', id: 'mock-one', collapsed: true });
  state = reduce(state, { type: 'section-move', id: 'mock-two', direction: -1 });
  expect(state.organization.sections).toEqual([
    { id: 'mock-two', name: '合成二', collapsed: false },
    { id: 'mock-one', name: '合成一', collapsed: true },
  ]);
  const stable = state;
  for (const action of [
    { type: 'section-create' as const, id: 'mock-one', name: '合成替换' },
    { type: 'section-rename' as const, id: 'mock-one', name: '   ' },
    { type: 'bot-section' as const, bot: 'writer', section: 'mock-missing' },
    { type: 'bot-pin' as const, bot: 'mock-missing', pinned: true },
  ])
    state = reduce(state, action);
  expect(state).toBe(stable);
});

it('migrates old workspaces and repairs optional organization without resetting unrelated drafts', () => {
  const state = initialState();
  state.drafts.research = 'MOCK-RETAIN-UNSENT';
  const saved = JSON.parse(serialize(state));
  delete saved.state.organization;
  const migrated = restore(JSON.stringify(saved));
  expect(migrated.organization).toEqual({
    pins: [],
    sections: [],
    placements: {},
    attention: { initialized: false, seen: [], unread: [] },
  });
  saved.state.organization = {
    pins: ['writer', 'writer', 'mock-unknown'],
    sections: [
      { id: 'mock-section', name: '合成组', collapsed: false },
      { id: '../bad', name: '', collapsed: false },
    ],
    placements: { writer: 'mock-section', research: 'mock-missing' },
    attention: {
      initialized: true,
      seen: ['mock-key', 'mock-key'],
      unread: ['writer', 'mock-unknown'],
    },
  };
  const repaired = restore(JSON.stringify(saved));
  expect(repaired.organization.pins).toEqual(['writer']);
  expect(repaired.organization.sections).toHaveLength(1);
  expect(repaired.organization.placements).toEqual({ writer: 'mock-section' });
  expect(repaired.organization.attention).toEqual({
    initialized: true,
    seen: ['mock-key'],
    unread: ['writer'],
  });
  expect(repaired.drafts.research).toBe('MOCK-RETAIN-UNSENT');
  expect(repaired.messages).toEqual(state.messages);
  expect(restore(serialize(repaired))).toEqual(repaired);
});

it('baselines old events, scopes unread to their conversation and never replays a read event', () => {
  let state = initialState();
  state = reduce(state, { type: 'attention', events: [{ key: 'mock-old', bot: 'writer' }] });
  expect(state.organization.attention.unread).toEqual([]);
  const events = [
    { key: 'mock-old', bot: 'writer' },
    { key: 'mock-new-private', bot: 'writer' },
    { key: 'mock-new-group', bot: 'crew' },
    { key: 'mock-active', bot: 'research' },
  ];
  state = reduce(state, { type: 'attention', events, visible: 'research' });
  expect(state.organization.attention.unread).toEqual(['writer', 'crew']);
  state = reduce(state, { type: 'select', bot: 'writer' });
  state = reduce(state, { type: 'attention', events });
  expect(state.organization.attention.unread).toEqual(['crew']);
  state = reduce(state, { type: 'bot-read', bot: 'research', unread: true });
  state = reduce(state, { type: 'attention', events, visible: 'research' });
  expect(state.organization.attention.unread).toContain('research');
  state = reduce(state, {
    type: 'attention',
    events: [{ key: 'mock-visible-new', bot: 'research' }],
    visible: 'research',
  });
  expect(state.organization.attention.unread).not.toContain('research');
  expect(restore(serialize(state)).organization).toEqual(state.organization);
});

it('reads only the current conversation when returning from another view', () => {
  let state = initialState();
  state = reduce(state, { type: 'bot-read', bot: 'research', unread: true });
  state = reduce(state, { type: 'bot-read', bot: 'writer', unread: true });
  state = reduce(state, { type: 'view', view: 'settings' });
  state = reduce(state, { type: 'view', view: 'chat' });
  expect(state.organization.attention.unread).toEqual(['writer']);
});

it('retains still-visible group events when newer private-result windows fill the bounded seen cache', () => {
  let state = initialState();
  const group = { key: 'mock-retained-group', bot: 'crew' };
  state = reduce(state, { type: 'attention', events: [group] });
  for (let batch = 0; batch < 6; batch++) {
    const events = Array.from({ length: 1000 }, (_, index) => ({
      key: `mock-private-${batch}-${index}`,
      bot: 'writer',
    }));
    state = reduce(state, { type: 'attention', events: [...events, group] });
    expect(state.organization.attention.unread).not.toContain('crew');
    expect(state.organization.attention.seen.length).toBeLessThanOrEqual(4096);
  }
  state = reduce(state, { type: 'bot-read', bot: 'writer', unread: false });
  expect(restore(serialize(state)).organization.attention.unread).toEqual([]);
});
