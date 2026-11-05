import {
  type ContextCapture,
  contextCategories,
  disconnected,
  isContextBoundary,
  isContextCapture,
  isContextView,
  isRemoteRpcRequest,
  isRemoteSnapshot,
  isRemoteSnapshotCapabilities,
  parseRuntimeCommand,
  remoteReplyFor,
  remoteSnapshotFor,
} from '@daban/protocol';
import { expect, test } from 'vitest';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
test.each([
  { type: 'budget.settings' },
  { type: 'projects.list' },
  {
    type: 'model.saved',
    input: {
      scope: 'a'.repeat(64),
      requestId: 'mock-saved-model',
      revision: 2,
      connection: 'mock-provider',
      model: 'provider:mock-provider:mock-model',
    },
  },
])('preserves the main $type command through the extracted public parser', (command) => {
  expect(parseRuntimeCommand(command)).toEqual(command);
});

test('accepts current safe model metadata without accepting unknown model fields', () => {
  const snapshot = disconnected('ready');
  const model = {
    ...snapshot.model,
    modelAccess: { scope: 'a'.repeat(64), fallback: true, diagnostics: true, cli: false },
    fallbackModel: 'provider:mock-provider:mock-model',
    probeRevision: 0,
  };
  expect(isRemoteSnapshot({ ...snapshot, model })).toBe(true);
  expect(isRemoteSnapshot({ ...snapshot, model: { ...model, rawSdk: 'SYNTHETIC PRIVATE' } })).toBe(
    false,
  );
  expect(isRemoteSnapshot({ ...snapshot, model: { ...model, probeRevision: -1 } })).toBe(false);
});

test('an original Context-capable controller still receives its supported model schema', () => {
  const baseline = { ...disconnected('ready'), contextInspector: 1 };
  const current = {
    ...baseline,
    model: {
      ...baseline.model,
      modelAccess: { scope: 'a'.repeat(64), fallback: true, diagnostics: true, cli: false },
      fallbackModel: 'provider:mock-provider:mock-model',
      probeRevision: 0,
    },
  };
  // The verified 522 receiver already advertises Context, but its model object has a closed older schema.
  expect(remoteSnapshotFor(current, { contextInspector: 1 })).toEqual(baseline);
  expect(remoteSnapshotFor(current, { contextInspector: 1 }, 2)).toEqual(current);
  expect(current.model).toHaveProperty('modelAccess');
});

test('schema 2 extends the same closed hint without changing the three read-only accept keys', () => {
  const hint = {
    type: 'snapshot-capabilities',
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
    accept: { contextInspector: 1 },
    schema: 2,
  };
  expect(isRemoteSnapshotCapabilities(hint)).toBe(true);
  for (const invalid of [
    { ...hint, schema: 1 },
    { ...hint, schema: 3 },
    { ...hint, schema: '2' },
    { ...hint, token: 'synthetic-private' },
    { ...hint, accept: { modelAccess: 1 } },
  ])
    expect(isRemoteSnapshotCapabilities(invalid)).toBe(false);
});

test('legacy snapshots omit unsupported scoped locators and preserve archived group identity', () => {
  const project = { projectId: 'mock-project', revision: 1 };
  const file = {
    path: 'synthetic.txt',
    name: 'synthetic.txt',
    size: 3,
    modified: '2026-01-01T00:00:00.000Z',
  };
  const scoped = { ...file, project, task: { bot: scope.bot, runId: scope.runId } };
  const summary = {
    runId: scope.runId,
    chatRevision: 0,
    requestId: 'mock-request',
    phase: 'completed',
    prompt: '',
    result: '',
    error: '',
    files: [file, scoped],
    project,
    rootRunId: scope.runId,
  };
  const task = {
    ...summary,
    running: false,
    toolCount: 0,
    executedCount: 0,
    trace: [],
    history: [summary],
  };
  const group = {
    id: 'mock-group',
    name: 'Synthetic group',
    members: ['mock-bot', 'mock-peer'],
    revision: 1,
    createdAt: file.modified,
    updatedAt: file.modified,
    archived: true,
    project,
  };
  const time = {
    id: 'mock-time',
    bot: scope.bot,
    title: 'Synthetic schedule',
    prompt: 'Synthetic work',
    rule: { kind: 'every', everySeconds: 60 },
    enabled: true,
    revision: 1,
    createdAt: file.modified,
    updatedAt: file.modified,
    history: [],
    automation: {
      configRevision: 1,
      policy: { kind: 'all' },
      initialized: false,
      cursor: 0,
      count: 0,
    },
  };
  const fileSchedule = {
    ...time,
    id: 'mock-file',
    rule: { kind: 'file', scope: project, paths: ['synthetic.txt'], pollSeconds: 60 },
  };
  const snapshot = {
    ...disconnected('ready'),
    agents: { [scope.bot]: task },
    groups: { available: true, revision: 1, items: [group] },
    schedules: {
      available: true,
      items: [time, fileSchedule],
      automation: { changes: true, files: true },
    },
    notices: {
      available: true,
      items: [
        {
          kind: 'automation',
          id: 'mock-notice',
          bot: scope.bot,
          schedule: time.id,
          phase: 'completed',
          reason: 'changed',
        },
      ],
    },
  };
  expect(isRemoteSnapshot(snapshot)).toBe(true);
  const legacy = remoteSnapshotFor(snapshot) as typeof snapshot;
  expect(legacy.agents[scope.bot].files).toEqual([file]);
  expect(legacy.agents[scope.bot].history[0].files).toEqual([file]);
  expect(legacy.agents[scope.bot]).not.toHaveProperty('project');
  expect(legacy.groups.items).toEqual([{ ...group, project: undefined }]);
  expect(legacy.groups.items[0].archived).toBe(true);
  expect(legacy.notices.items).toEqual([]);
  expect(legacy.schedules.items).toEqual([{ ...time, automation: undefined }]);
  expect(remoteSnapshotFor(snapshot, {}, 2)).toEqual(snapshot);
  expect(() => remoteReplyFor('schedule.get', fileSchedule)).toThrow('AUTOMATION_UPGRADE_REQUIRED');
  expect(remoteReplyFor('schedule.get', fileSchedule, {}, 2)).toEqual(fileSchedule);
  expect(() => remoteReplyFor('files.read', { ...scoped, content: 'SYNTHETIC CONTENT' })).toThrow(
    'REMOTE_SCHEMA_UPGRADE_REQUIRED',
  );
  expect(() =>
    remoteReplyFor('status', {
      ...snapshot,
      model: { ...snapshot.model, apiKey: 'synthetic-private' },
    }),
  ).toThrow('REMOTE_INVALID_SNAPSHOT');
  const page = { bot: scope.bot, revision: 0, items: [summary] };
  expect(remoteReplyFor('chat.history', page)).toMatchObject({ items: [{ files: [file] }] });
  expect(remoteReplyFor('chat.history', page)).not.toHaveProperty('items.0.project');
  expect(remoteReplyFor('group.read', group)).toEqual({ ...group, project: undefined });
});

test('validates the current task and automation metadata as closed public values', () => {
  const snapshot = disconnected('ready');
  const task = {
    phase: 'completed',
    running: false,
    prompt: '',
    result: '',
    error: '',
    toolCount: 0,
    executedCount: 0,
    files: [],
    history: [],
    trace: [],
    rootRunId: 'mock-run',
    project: { projectId: 'mock-project', revision: 1 },
    attemptSummary: [
      {
        attemptId: 'mock-attempt',
        model: 'provider:mock-provider:mock-model',
        phase: 'completed',
        fence: 'clean',
        createdAt: '2026-01-01T00:00:00.000Z',
        usage: 'unknown',
      },
    ],
  };
  const state = { ...snapshot, agents: { 'mock-bot': task } };
  expect(isRemoteSnapshot(state)).toBe(true);
  for (const invalid of [
    { ...task, rootRunId: '../foreign' },
    { ...task, project: { ...task.project, path: '/synthetic/private' } },
    { ...task, attemptSummary: [{ ...task.attemptSummary[0], apiKey: 'synthetic-private' }] },
    { ...task, rawSdk: 'SYNTHETIC PRIVATE' },
    { ...task, phase: ['completed'] },
  ])
    expect(isRemoteSnapshot({ ...snapshot, agents: { 'mock-bot': invalid } })).toBe(false);
  expect(
    isRemoteSnapshot({
      ...snapshot,
      schedules: { available: true, items: [], automation: { changes: true, files: true } },
    }),
  ).toBe(true);
  expect(
    isRemoteSnapshot({
      ...snapshot,
      schedules: { available: true, items: [], automation: { changes: 'true', files: true } },
    }),
  ).toBe(false);
});

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

const enumFields = [
  {
    name: 'boundary kind',
    value: 'summary',
    check: isContextBoundary,
    input: (kind: unknown) => ({ kind, endSeq: 1, shadowedSeqs: [0], omittedSeqs: 0 }),
  },
  {
    name: 'source evidence',
    value: 'unknown',
    check: isContextCapture,
    input: (evidence: unknown) => {
      const selected = capture();
      return {
        ...selected,
        sources: selected.sources.map((source, index) =>
          index === 0 ? { ...source, evidence } : source,
        ),
      };
    },
  },
  {
    name: 'source membership',
    value: 'unknown',
    check: isContextCapture,
    input: (membership: unknown) => {
      const selected = capture();
      return {
        ...selected,
        sources: selected.sources.map((source, index) =>
          index === 0 ? { ...source, membership } : source,
        ),
      };
    },
  },
  {
    name: 'capture reason',
    value: 'turn',
    check: isContextCapture,
    input: (reason: unknown) => ({ ...capture(), reason }),
  },
  {
    name: 'unavailable reason',
    value: 'legacy',
    check: isContextView,
    input: (reason: unknown) => ({ scope, state: 'unavailable', reason }),
  },
  {
    name: 'capture health',
    value: 'ok',
    check: isContextView,
    input: (health: unknown) => ({
      scope,
      state: 'captured',
      health,
      selected: capture(),
      revisions: [1],
    }),
  },
];
const invalidEnums = [
  { name: 'array', make: (value: string): unknown => [value] },
  { name: 'nested array', make: (value: string): unknown => [[value]] },
  { name: 'coercible object', make: (value: string): unknown => ({ toString: () => value }) },
  {
    name: 'uncoercible object',
    make: (_value: string): unknown => ({ toString: null, valueOf: null }),
  },
  { name: 'plain object', make: (_value: string): unknown => ({}) },
  { name: 'null', make: (_value: string): unknown => null },
  { name: 'boolean', make: (_value: string): unknown => true },
  { name: 'number', make: (_value: string): unknown => 1 },
];
for (const field of enumFields) {
  test(`${field.name} accepts its original string`, () => {
    expect(field.check(field.input(field.value))).toBe(true);
  });
  test.each(invalidEnums)(
    `${field.name} rejects $name without conversion or exceptions`,
    ({ make }) => {
      const input: unknown = field.input(make(field.value));
      expect(() => field.check(input)).not.toThrow();
      expect(field.check(input)).toBe(false);
    },
  );
}

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
