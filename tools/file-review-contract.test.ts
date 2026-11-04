import {
  disconnected,
  isRemoteRpcRequest,
  isRemoteSnapshot,
  isReviewChange,
  isReviewPage,
  isReviewResponse,
  parseRuntimeCommand,
} from '@daban/protocol';
import { expect, test } from 'vitest';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const file = { scope, revision: 1, area: 'task', path: 'input.txt' };
const commands = [
  { type: 'files.review.read', query: { scope } },
  { type: 'files.review.diff', query: file },
  { type: 'files.review.current', query: file },
];

test.each(commands)('accepts bounded $type', (command) => {
  expect(parseRuntimeCommand(command)).toEqual(command);
});

test('accepts eight explicit shared files without requiring a project', () => {
  const command = {
    type: 'task.start',
    bot: scope.bot,
    task: {
      requestId: 'mock-request',
      prompt: 'Review synthetic files.',
      chatRevision: 0,
      fileReview: { sharedPaths: Array.from({ length: 8 }, (_, i) => `mock-${i}.txt`) },
    },
  };
  expect(parseRuntimeCommand(command)).toEqual(command);
});

test.each(commands)('allows remote $type', ({ type, ...params }) => {
  expect(
    isRemoteRpcRequest({
      type: 'request',
      id: 'mock-request',
      host: 'a'.repeat(64),
      workspace: 'mock-workspace',
      method: type,
      params,
    }),
  ).toBe(true);
});

test('accepts only the strict optional snapshot shape', () => {
  const snapshot = disconnected('ready');
  expect(isRemoteSnapshot(snapshot)).toBe(true);
  expect(isRemoteSnapshot({ ...snapshot, fileReview: { available: true } })).toBe(true);
  expect(isRemoteSnapshot({ ...snapshot, fileReview: { available: 1 } })).toBe(false);
  expect(isRemoteSnapshot({ ...snapshot, fileReview: { available: true, extra: true } })).toBe(
    false,
  );
  expect(isRemoteSnapshot({ ...snapshot, unknown: true })).toBe(false);
});

test.each([
  { type: 'files.review.read', query: { scope: { ...scope, conversationId: 'mock-group' } } },
  { type: 'files.review.diff', query: { ...file, revision: 0 } },
  { type: 'files.review.current', query: { ...file, path: '../mock-secret' } },
  { type: 'files.review.restore', query: file },
  {
    type: 'snapshot-capabilities',
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
    accept: { fileReview: 1 },
  },
  {
    type: 'task.start',
    bot: scope.bot,
    task: {
      requestId: 'mock-duplicate',
      prompt: 'Synthetic task.',
      fileReview: { sharedPaths: ['mock.txt', 'mock.txt'] },
    },
  },
  {
    type: 'task.start',
    bot: scope.bot,
    task: {
      requestId: 'mock-limit',
      prompt: 'Synthetic task.',
      fileReview: { sharedPaths: Array.from({ length: 9 }, (_, i) => `mock-${i}.txt`) },
    },
  },
])('rejects invalid $type', (command) => {
  expect(() => parseRuntimeCommand(command)).toThrow('INVALID_COMMAND');
});

test('does not accept contradictory change kinds, counts or a different response command', () => {
  const before = {
    area: 'task',
    path: 'mock.txt',
    state: 'present',
    bytes: 1,
    sha256: 'a'.repeat(64),
    text: true,
  };
  const after = { ...before, sha256: 'b'.repeat(64) };
  const item = { before, after, kind: 'modified' };
  const page = {
    scope,
    revision: 1,
    state: 'complete',
    writers: 'unknown',
    effects: 'partial',
    reasons: [],
    counts: { created: 0, modified: 1, deleted: 0, unchanged: 0, unknown: 0 },
    items: [item],
  };
  expect(isReviewPage(page)).toBe(true);
  expect(
    isReviewPage({ ...page, counts: { ...page.counts, modified: Number.MAX_SAFE_INTEGER } }),
  ).toBe(false);
  expect(isReviewChange({ ...item, kind: 'unchanged' })).toBe(false);
  expect(isReviewPage({ ...page, counts: { ...page.counts, modified: 0, unchanged: 1 } })).toBe(
    false,
  );
  expect(
    isReviewResponse({ type: 'files.review.restore', query: file }, { ...file, state: 'matching' }),
  ).toBe(false);
});
