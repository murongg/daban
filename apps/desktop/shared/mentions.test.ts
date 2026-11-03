import { expect, it } from 'vitest';
import {
  insertMention,
  mentionQuery,
  readMentions,
  rebaseMentions,
  resolveMentions,
} from './mentions';

const members = [
  { id: 'mock-a', name: 'Synthetic Alpha' },
  { id: 'mock-b', name: 'Synthetic Beta' },
];

it('finds a caret-local query without treating email addresses or a selected token as a new query', () => {
  expect(mentionQuery('Check @Syn later', 10, [])).toEqual({ start: 6, end: 10, query: 'Syn' });
  expect(mentionQuery('mock@example.test', 17, [])).toBeUndefined();
  expect(mentionQuery('@Synthetic', 0, [])).toBeUndefined();
  const inserted = insertMention('', { start: 0, end: 0 }, members[0], []);
  expect(mentionQuery(inserted.text, inserted.caret, inserted.mentions)).toBeUndefined();
});

it('inserts a selected identity at the caret and rebases mentions after unrelated edits', () => {
  const value = insertMention('Check @Syn later', { start: 6, end: 10 }, members[0], []);
  expect(value.text).toBe('Check @Synthetic Alpha  later');
  const moved = rebaseMentions(value.text, `First ${value.text}`, value.mentions);
  expect(moved[0]).toMatchObject({ id: 'mock-a', start: 12, end: 28 });
  expect(rebaseMentions(value.text, value.text.replace('Alpha', 'Other'), value.mentions)).toEqual(
    [],
  );
});

it('routes explicit mentions in text order, deduplicates identities and preserves the original text', () => {
  const text = '@Synthetic Beta @Synthetic Alpha @Synthetic Beta verify mock records';
  const resolved = resolveMentions(text, members, []);
  expect(resolved.recipients).toEqual(['mock-b', 'mock-a']);
  expect(resolved.ambiguous).toEqual([]);
  expect(
    resolveMentions('mail mock@example.test and discuss @unrelated', members, []).recipients,
  ).toEqual([]);
});

it('matches full names before a shorter name and requires mention boundaries', () => {
  const list = [{ id: 'mock-short', name: 'Synthetic' }, ...members];
  expect(resolveMentions('@Synthetic Alpha verify', list, []).recipients).toEqual(['mock-a']);
  expect(resolveMentions('prefix@Synthetic Alpha verify', list, []).recipients).toEqual([]);
  expect(resolveMentions('@Synthetic Alphabet verify', members, []).recipients).toEqual([]);
});

it('keeps a selected identity across rename or removal, and requires a choice for duplicate names', () => {
  const same = [
    { id: 'mock-a', name: 'Synthetic' },
    { id: 'mock-b', name: 'Synthetic' },
  ];
  expect(resolveMentions('@Synthetic verify', same, []).ambiguous).toEqual(['Synthetic']);
  const selected = insertMention('', { start: 0, end: 0 }, same[1], []);
  expect(resolveMentions(selected.text, same, selected.mentions).recipients).toEqual(['mock-b']);
  expect(
    resolveMentions(selected.text, [{ id: 'mock-a', name: 'Renamed' }], selected.mentions)
      .recipients,
  ).toEqual(['mock-b']);
});

it('accepts only bounded metadata that still matches its exact draft token', () => {
  const selected = insertMention('', { start: 0, end: 0 }, members[0], []);
  expect(readMentions(selected.mentions, selected.text)).toEqual(selected.mentions);
  expect(readMentions([{ ...selected.mentions[0], start: -1 }], selected.text)).toEqual([]);
  expect(readMentions(selected.mentions, 'a different synthetic draft')).toEqual([]);
  expect(readMentions({ injected: true }, selected.text)).toEqual([]);
});
