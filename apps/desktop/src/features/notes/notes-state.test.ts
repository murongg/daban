import { agentId, type NoteAck, type NoteItem } from '@daban/protocol';
import { expect, it } from 'vitest';
import { reduce } from '../../app/state';
import { restore, serialize } from '../../app/storage';
import { demoState as initialState } from '../../test/fixtures';
import {
  mergeNote,
  type NotesState,
  noteDirty,
  noteDraft,
  noteInitial,
  noteInput,
  reduceNotes,
  restoreNotes,
} from './notes-state';

const at = '2026-01-01T00:00:00Z';
const item: NoteItem = {
  bot: 'a',
  id: 'mock-note',
  title: '合成便笺',
  body: 'MOCK BODY',
  status: 'open',
  revision: 1,
  deleted: false,
  createdAt: at,
  updatedAt: at,
  createdBy: { kind: 'human' },
  updatedBy: { kind: 'human' },
};

it('builds validated creates/partial edits and keeps over-quota editable drafts', () => {
  const empty = noteDraft('a');
  expect(empty).toHaveProperty('bot', 'a');
  expect(noteDirty(empty)).toBe(false);
  expect(noteInput(empty, 'mock-create', 'mock-new')).toBeUndefined();
  expect(noteInput({ ...empty, title: ' 合成新便笺 ' }, 'mock-create', 'mock-new')).toEqual({
    id: 'mock-create',
    note: 'mock-new',
    action: 'create',
    revision: 0,
    value: { title: '合成新便笺', body: '', status: 'open' },
  });
  const draft = { ...noteDraft('a', item), body: 'MOCK EDIT' };
  expect(noteInput(draft, 'mock-edit')).toEqual({
    id: 'mock-edit',
    note: item.id,
    action: 'update',
    revision: 1,
    value: { body: 'MOCK EDIT' },
  });
  expect(noteInput(noteDraft('a', item), 'mock-noop')).toBeUndefined();
  const retained = restoreNotes(
    { ...noteInitial(), draft: { ...draft, body: 'x'.repeat(5000) } },
    'a',
  );
  expect(retained?.draft?.body).toHaveLength(5000);
  expect(noteInput(retained!.draft!, 'mock-large')).toBeUndefined();
});

it('merges only explicit local changes and never rebases onto another Bot or note', () => {
  const draft = { ...noteDraft('a', item), title: '合成本机标题' };
  const latest = { ...item, revision: 2, body: 'MOCK AGENT EDIT', status: 'parked' as const };
  const merged = mergeNote(draft, latest);
  expect(merged.title).toBe(draft.title);
  expect(merged.body).toBe(latest.body);
  expect(merged.status).toBe('parked');
  expect(noteInput(merged, 'mock-merge')).toMatchObject({
    revision: 2,
    value: { title: draft.title },
  });
  expect(mergeNote(draft, { ...latest, bot: 'b' })).toBe(draft);
  expect(mergeNote(draft, { ...latest, id: 'mock-other' })).toBe(draft);
});

it('binds pending receipt, author, full request and revision to one Bot and one editor', () => {
  const draft = { ...noteDraft('a', item), body: 'MOCK SAVE' };
  const request = noteInput(draft, 'mock-save')!;
  const pending = { request, draft };
  const current = reduceNotes({ ...noteInitial(), draft }, 'a', {
    type: 'notes-pending',
    bot: 'research',
    pending,
  });
  expect(current.pending).toEqual(pending);
  expect(
    reduceNotes(current, 'a', {
      type: 'notes-change',
      bot: 'research',
      key: draft.key,
      patch: { title: 'MOCK SEALED' },
    }),
  ).toBe(current);
  const receipt: NoteAck = {
    state: 'complete',
    bot: 'a',
    request,
    actor: { kind: 'human' },
    acceptedRevision: 2,
    acceptedAt: at,
    item: { ...item, body: draft.body, revision: 3 },
  };
  expect(
    reduceNotes(current, 'a', {
      type: 'notes-settle',
      bot: 'research',
      receipt: {
        state: 'unknown',
        bot: 'a',
        request,
        actor: { kind: 'human' },
      } as unknown as NoteAck,
    }),
  ).toBe(current);
  for (const foreign of [
    { ...receipt, bot: 'b', item: { ...receipt.item, bot: 'b' } },
    { ...receipt, actor: { kind: 'bot' as const, bot: 'a' } },
    { ...receipt, request: { ...request, id: 'mock-foreign' } },
  ])
    expect(
      reduceNotes(current, 'a', { type: 'notes-settle', bot: 'research', receipt: foreign }),
    ).toBe(current);
  const settled = reduceNotes(current, 'a', { type: 'notes-settle', bot: 'research', receipt });
  expect(settled.pending).toBeUndefined();
  expect(settled.draft?.base?.revision).toBe(3);
  expect(noteDirty(settled.draft)).toBe(false);
  const other = { ...noteDraft('a'), title: '合成另一个编辑器' };
  const changed = reduceNotes(current, 'a', {
    type: 'notes-draft',
    bot: 'research',
    previous: draft,
    draft: other,
  });
  expect(
    reduceNotes(changed, 'a', { type: 'notes-settle', bot: 'research', receipt }).draft,
  ).toEqual(other);
});

it('refuses stale detail/merge and retains local edits through confirmed restore', () => {
  const base = { ...item, revision: 3, deleted: true };
  const draft = { ...noteDraft('a', base), body: 'MOCK RETAINED EDIT' };
  let current: NotesState = { ...noteInitial(), draft };
  expect(
    reduceNotes(current, 'a', {
      type: 'notes-draft',
      bot: 'research',
      previous: draft,
      draft: noteDraft('a', item),
    }),
  ).toBe(current);
  expect(
    reduceNotes(current, 'a', {
      type: 'notes-merge',
      bot: 'research',
      key: draft.key,
      latest: { ...base, bot: 'b' },
      keep: true,
    }),
  ).toBe(current);
  const request = { id: 'mock-restore', note: item.id, revision: 3, action: 'restore' as const };
  current = reduceNotes(current, 'a', {
    type: 'notes-pending',
    bot: 'research',
    pending: { request, draft },
  });
  const next = reduceNotes(current, 'a', {
    type: 'notes-settle',
    bot: 'research',
    receipt: {
      state: 'complete',
      bot: 'a',
      request,
      actor: { kind: 'human' },
      acceptedRevision: 4,
      acceptedAt: at,
      item: { ...base, deleted: false, revision: 4 },
    },
  });
  expect(next.draft?.body).toBe(draft.body);
  expect(next.draft?.base?.deleted).toBe(false);
});

it('persists independent Bot drafts/intents without breaking legacy navigation or other workspace data', () => {
  const seed = initialState();
  seed.drafts.research = 'MOCK CHAT KEPT';
  const alpha = { ...noteDraft('a', item), title: 'MOCK ALPHA DRAFT' };
  const beta = {
    ...noteDraft(agentId('writer'), { ...item, bot: agentId('writer') }),
    title: 'MOCK BETA DRAFT',
  };
  let state = reduce(seed, { type: 'notes-draft', bot: 'research', draft: alpha });
  state = reduce(state, { type: 'notes-draft', bot: 'writer', draft: beta });
  state = reduce(state, { type: 'panel', panel: 'notes' });
  const request = noteInput(alpha, 'mock-pending')!;
  state = reduce(state, {
    type: 'notes-pending',
    bot: 'research',
    pending: { request, draft: alpha },
  });
  const raw = serialize(state);
  expect(JSON.parse(raw).state.panel).toBeNull();
  const restored = restore(raw);
  expect(restored.drafts.research).toBe(seed.drafts.research);
  expect(restored.notes?.research?.pending?.request).toEqual(request);
  expect(restored.notes?.writer?.draft).toEqual(beta);
  const foreign = reduce(state, {
    type: 'notes-draft',
    bot: 'research',
    previous: alpha,
    draft: beta,
  });
  expect(foreign.notes?.research?.draft).toEqual(alpha);
  const damaged = JSON.parse(raw);
  damaged.state.notes.research.pending.request.note = 'mock-tampered';
  const repaired = restore(JSON.stringify(damaged));
  expect(repaired.notes?.research?.pending).toBeUndefined();
  expect(repaired.notes?.research?.damaged).toBe(true);
  expect(repaired.notes?.writer?.draft).toEqual(beta);
  expect(repaired.drafts.research).toBe(seed.drafts.research);
  expect(restoreNotes({ ...noteInitial(), draft: noteDraft('b') }, 'a')?.damaged).toBe(true);
});
