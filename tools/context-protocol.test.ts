import {
  type ContextCapture,
  contextCategories,
  disconnected,
  isContextCapture,
  isContextView,
  isRemoteRpcRequest,
  isRemoteSnapshot,
  isRemoteSnapshotCapabilities,
  parseRuntimeCommand,
  remoteSnapshotFor,
} from '@daban/protocol';
import { expect, test } from 'vitest';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const capture = (): ContextCapture => ({
  revision: 1,
  at: '2026-01-01T08:00:00+08:00',
  reason: 'turn',
  coverage: 'partial',
  turnId: 'mock-turn',
  estimator: 'daban-text-v1',
  configuredWindow: 16384,
  configuredOutput: 1024,
  sources: contextCategories.map((category) => ({
    category,
    evidence: 'unknown',
    membership: 'unknown',
    hostTokens: null,
    savedCharacters: 0,
    refs: [],
    omittedRefs: 0,
  })),
  pressure: { seq: 0, at: '2026-01-01T00:00:00Z' },
  gaps: ['sdk-envelope'],
});

test('validates partial captures, safe source ownership, ISO dates and private-body exclusion', () => {
  const selected = capture();
  expect(isContextCapture(selected)).toBe(true);
  const view = { scope, state: 'captured', health: 'ok', selected, revisions: [1] };
  expect(isContextView(view)).toBe(true);
  for (const invalid of [
    { ...selected, at: '2026-02-30T00:00:00Z' },
    { ...selected, rawOutput: 'SYNTHETIC PRIVATE' },
    { ...selected, revision: 0 },
    { ...selected, configuredWindow: Number.NaN },
    { ...selected, configuredOutput: Number.MAX_SAFE_INTEGER + 1 },
    { ...selected, sources: [selected.sources[0], ...selected.sources.slice(0, 9)] },
    { ...selected, pressure: { seq: 0, at: selected.at, pressureTokens: -1 } },
    {
      ...selected,
      breakdown: {
        seq: 1,
        at: selected.at,
        systemTokens: 1,
        toolsTokens: 2,
        messageTokens: 3,
        headers: {},
      },
    },
    {
      ...selected,
      boundary: {
        kind: 'prune',
        endSeq: 4,
        shadowedSeqs: Array.from({ length: 33 }, (_, i) => i),
        omittedSeqs: 0,
      },
    },
  ])
    expect(isContextCapture(invalid)).toBe(false);
  expect(isContextView({ ...view, revisions: [1, 1] })).toBe(false);
  selected.sources[7].refs = [{ scope: { ...scope, bot: 'mock-foreign' }, seq: 1 }];
  expect(isContextView(view)).toBe(false);
});

test('never provides role or preference body refs and rejects oversized wire captures', () => {
  for (const category of ['persona', 'preferences']) {
    const selected = capture();
    selected.at = '2026-01-01T00:00:00Z';
    selected.sources.find((source) => source.category === category)!.refs = [{ scope, seq: 1 }];
    expect(isContextCapture(selected)).toBe(false);
  }
  const large = capture();
  large.at = '2026-01-01T00:00:00Z';
  const long = {
    bot: 'a'.repeat(80),
    runId: 'b'.repeat(80),
    chatRevision: Number.MAX_SAFE_INTEGER,
  };
  for (const index of [0, 3, 4, 5])
    large.sources[index].refs = Array.from({ length: 5 }, (_, i) => ({ scope: long, seq: i + 1 }));
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(6144);
  expect(isContextCapture(large)).toBe(false);
});

test('snapshot acceptance is an exact hint and copies only the three negotiated optional fields', () => {
  const hint = {
    type: 'snapshot-capabilities',
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
    accept: { contextInspector: 1 },
  };
  expect(isRemoteSnapshotCapabilities(hint)).toBe(true);
  expect(isRemoteSnapshotCapabilities({ ...hint, accept: {} })).toBe(true);
  for (const accept of [
    { contextInspector: true },
    { preflight: 2 },
    { fileReview: {} },
    { privateKey: 1 },
  ])
    expect(isRemoteSnapshotCapabilities({ ...hint, accept })).toBe(false);
  expect(isRemoteSnapshotCapabilities({ ...hint, permission: 'mock-authority' })).toBe(false);
  const original = {
    ...disconnected('ready'),
    contextInspector: 1,
    preflight: 1,
    fileReview: 1,
    unexpected: 'must-still-be-rejected',
  };
  expect(remoteSnapshotFor(original)).toEqual({
    ...disconnected('ready'),
    unexpected: original.unexpected,
  });
  expect(remoteSnapshotFor(original, { contextInspector: 1 })).toEqual({
    ...disconnected('ready'),
    contextInspector: 1,
    unexpected: original.unexpected,
  });
  expect(original).toMatchObject({ contextInspector: 1, preflight: 1, fileReview: 1 });
  expect(isRemoteSnapshot(remoteSnapshotFor(original, { contextInspector: 1 }))).toBe(false);
});

test('accepts exact context queries for private and group tasks', () => {
  for (const target of [
    scope,
    { bot: scope.bot, runId: scope.runId, conversationId: 'mock-group' },
  ]) {
    const input: unknown = { type: 'context.inspect', query: { scope: target } };
    expect(parseRuntimeCommand(input)).toEqual(input);
  }
});

test('accepts a captured source in an earlier run of the same chat', () => {
  const input: unknown = {
    type: 'context.source',
    query: {
      scope,
      revision: 1,
      ref: { scope: { ...scope, runId: 'mock-previous-run' }, seq: 1 },
      offset: 0,
    },
  };
  expect(parseRuntimeCommand(input)).toEqual(input);
});

test('preserves baseline snapshots and accepts only the literal context capability', () => {
  expect(isRemoteSnapshot(disconnected('ready'))).toBe(true);
  const input: unknown = { ...disconnected('ready'), contextInspector: 1 };
  expect(isRemoteSnapshot(input)).toBe(true);
  for (const capability of [true, 0, 2, {}])
    expect(isRemoteSnapshot({ ...disconnected('ready'), contextInspector: capability })).toBe(
      false,
    );
  expect(
    isRemoteSnapshot({ ...disconnected('ready'), contextInspector: 1, apiKey: 'mock-secret' }),
  ).toBe(false);
});

test('permits both authenticated context observations through the existing RPC boundary', () => {
  for (const method of ['context.inspect', 'context.source']) {
    const input: unknown = {
      type: 'request',
      id: 'mock-request',
      host: 'a'.repeat(64),
      workspace: 'mock-workspace',
      method,
      params: {
        query:
          method === 'context.inspect' ? { scope } : { scope, revision: 1, ref: { scope, seq: 1 } },
      },
    };
    expect(isRemoteRpcRequest(input)).toBe(true);
  }
});
