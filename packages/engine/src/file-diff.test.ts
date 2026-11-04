import { createHash } from 'node:crypto';
import type { ReviewCapture, ReviewFile } from '@daban/protocol';
import { expect, test } from 'vitest';
import { classify, compareFiles, diffText } from './file-diff.js';

const file = (text: string): ReviewFile => ({
  area: 'task',
  path: 'mock.txt',
  state: 'present',
  bytes: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'),
  text: true,
});
const capture = (files: ReviewFile[], complete = true): ReviewCapture => ({
  snapshot: {
    area: 'task',
    capture: complete ? 'complete' : 'partial',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.000Z',
    reasons: complete ? [] : ['entry-limit'],
    omitted: complete ? 0 : 1,
  },
  files,
  texts: [],
});

test('classifies observed changes and never equates unknown evidence with unchanged', () => {
  const before = file('before\n'),
    after = file('after\n');
  expect(classify(before, after)).toBe('modified');
  expect(classify(before, before)).toBe('unchanged');
  expect(classify({ area: 'task', path: before.path, state: 'absent' }, after)).toBe('created');
  expect(classify(before, { area: 'task', path: before.path, state: 'absent' })).toBe('deleted');
  expect(
    classify(before, { area: 'task', path: before.path, state: 'unknown', reason: 'unstable' }),
  ).toBe('unknown');
});
test('only complete enumerations can turn missing entries into absent', () => {
  expect(compareFiles([capture([file('mock')])], [capture([])])[0].kind).toBe('deleted');
  expect(compareFiles([capture([file('mock')])], [capture([], false)])[0].kind).toBe('unknown');
  expect(compareFiles([capture([], false)], [capture([file('mock')])])[0].kind).toBe('unknown');
});
test('preserves CRLF, empty files, final newline and repeated lines in literal diff output', () => {
  expect(diffText('', 'mock\n')).toEqual({
    state: 'text',
    lines: [{ kind: 'add', text: 'mock\n' }],
  });
  expect(diffText('mock\r\n', 'mock\n')).toEqual({
    state: 'text',
    lines: [
      { kind: 'remove', text: 'mock\r\n' },
      { kind: 'add', text: 'mock\n' },
    ],
  });
  expect(diffText('mock', 'mock\n')).toEqual({
    state: 'text',
    lines: [
      { kind: 'remove', text: 'mock' },
      { kind: 'add', text: 'mock\n' },
    ],
  });
  expect(diffText('a\na\nb\n', 'a\nb\n')).toMatchObject({ state: 'text' });
});
test('bounds computation, output rows and serialized bytes', () => {
  for (const [a, b] of [
    ['a\n'.repeat(2001), ''],
    ['a'.repeat(210000), 'b'],
    ['a\n'.repeat(1500), 'b\n'.repeat(1500)],
  ])
    expect(diffText(a, b)).toEqual({ state: 'unavailable', reason: 'diff-limit' });
});
