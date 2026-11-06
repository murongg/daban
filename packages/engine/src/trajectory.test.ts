import type { TranscriptItem, TranscriptScope, TranscriptState } from '@daban/protocol';
import { expect, test } from 'vitest';
import {
  canonicalTrajectory,
  compareTrajectoryReports,
  evaluateTrajectory,
  hashTrajectory,
  normalizeTrajectory,
  type TrajectoryCapture,
  type TrajectoryCase,
  validateTrajectoryCase,
} from './trajectory.js';

const scope: TranscriptScope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const identity = { configHash: 'a'.repeat(64), codeRevision: 'mock-revision' };
const checks = [
  'coverage',
  'order',
  'arguments',
  'budget',
  'artifacts',
  'terminal',
  'unknown',
  'no-replay',
];

function emptyCase(): TrajectoryCase {
  return {
    schema: 1,
    id: 'mock-empty',
    revision: 1,
    input: {
      prompt: 'SYNTHETIC EMPTY',
      events: [{ kind: 'barrier', action: 'complete' }],
      files: [],
    },
    steps: [],
    terminal: 'completed',
    budget: { maxCalls: 0 },
    artifacts: [],
    rules: [],
    sensitive: [],
  };
}

function emptyCapture(): TrajectoryCapture {
  return {
    schema: 1,
    origin: 'synthetic',
    scope,
    sessionId: 'mock-session',
    requestId: 'mock-request',
    drained: true,
    lateEvents: 0,
    pages: [{ ...scope, state: 'complete', items: [] }],
    contents: [],
    terminal: 'completed',
    artifacts: [],
    bindings: {},
  };
}

test('a complete synthetic empty run passes all eight checks and preserves owned provenance', () => {
  const report = evaluateTrajectory(emptyCase(), emptyCapture(), identity);
  expect(report.verdict).toBe('pass');
  expect(report.checks.map((check) => check.check)).toStrictEqual(checks);
  expect(report.checks.every((check) => check.verdict === 'pass')).toBe(true);
  expect(report.scope).toStrictEqual(scope);
  expect(report.requestId).toBe('mock-request');
});

type Event = Omit<TranscriptItem, 'seq' | 'characters' | 'at'> & { text: string };

function recorded(events: Event[]) {
  const capture = emptyCapture();
  const items = events.map(({ text, ...meta }, index) => ({
    ...meta,
    seq: index + 1,
    at: '2026-01-01T00:00:00.000Z',
    characters: text.length,
  }));
  capture.pages = [];
  for (let offset = 0; offset < items.length; offset += 20) {
    const part = items.slice(offset, offset + 20);
    capture.pages.push({
      ...scope,
      state: 'complete',
      items: part,
      ...(offset + part.length < items.length ? { nextAfter: part.at(-1)!.seq } : {}),
    });
  }
  if (!items.length) capture.pages = [{ ...scope, state: 'complete', items: [] }];
  capture.contents = events.flatMap((event, index) => {
    if (!['call', 'result', 'interaction'].includes(event.kind)) return [];
    const chunks = [];
    for (let offset = 0; offset < event.text.length || !offset; offset += 32000) {
      const text = event.text.slice(offset, offset + 32000);
      chunks.push({
        ...scope,
        seq: index + 1,
        offset,
        total: event.text.length,
        text,
        ...(offset + text.length < event.text.length ? { nextOffset: offset + text.length } : {}),
      });
    }
    return chunks;
  });
  return capture;
}

function call(callId = 'mock-call', name = 'mock_tool', text = '{"value":1}'): Event {
  return { kind: 'call', callId, name, text };
}

function result(callId = 'mock-call', text = '{"ok":true}', isError = false): Event {
  return { kind: 'result', callId, text, isError };
}

function oneCase(): TrajectoryCase {
  return {
    ...emptyCase(),
    id: 'mock-one',
    steps: [{ slot: 'first', tool: 'mock_tool', args: { value: 1 }, result: 'success' }],
    budget: { maxCalls: 1 },
  };
}

function evaluate(capture: TrajectoryCapture, spec = oneCase()) {
  return evaluateTrajectory(spec, capture, identity);
}

function verdict(capture: TrajectoryCapture, spec = oneCase()) {
  return evaluate(capture, spec).verdict;
}

function check(capture: TrajectoryCapture, name: string, spec = oneCase()) {
  return evaluate(capture, spec).checks.find((entry) => entry.check === name)!;
}

test('missing pages, undrained observers, late events and missing terminal stay inconclusive', () => {
  const missing = emptyCapture();
  missing.pages = [];
  expect(verdict(missing, emptyCase())).toBe('inconclusive');
  expect(verdict({ ...emptyCapture(), drained: false }, emptyCase())).toBe('inconclusive');
  expect(verdict({ ...emptyCapture(), lateEvents: 1 }, emptyCase())).toBe('inconclusive');
  const noTerminal = emptyCapture();
  delete noTerminal.terminal;
  expect(verdict(noTerminal, emptyCase())).toBe('inconclusive');
  expect(verdict({ ...emptyCapture(), terminal: 'stopped' }, emptyCase())).toBe('fail');
  expect(verdict({ ...missing, terminal: 'stopped' }, emptyCase())).toBe('fail');
});

const unclosed: TranscriptState[] = ['recording', 'interrupted', 'unavailable'];
test.each(unclosed)('a %s transcript cannot establish completion', (state) => {
  expect(verdict({ ...emptyCapture(), pages: [{ ...scope, state, items: [] }] }, emptyCase())).toBe(
    'inconclusive',
  );
});

test('complete call/result evidence pairs only by its exact call identity', () => {
  const capture = recorded([call(), result()]);
  expect(verdict(capture)).toBe('pass');
  expect(normalizeTrajectory(capture).attempts).toStrictEqual([
    {
      event: 1,
      callId: 'mock-call',
      tool: 'mock_tool',
      args: { value: 1 },
      outcome: 'success',
      resultEvent: 2,
    },
  ]);
  expect(verdict(recorded([call(), result('different-call')]))).toBe('fail');
  expect(verdict(recorded([result(), call()]))).toBe('fail');
  expect(verdict(recorded([call(), result(), result()]))).toBe('fail');
  expect(verdict(recorded([call()]))).toBe('inconclusive');
});

test('identical overlapping reads are idempotent while changed metadata or body fails', () => {
  const capture = recorded([call(), result()]);
  capture.pages.push(structuredClone(capture.pages[0]));
  capture.contents.push(structuredClone(capture.contents[0]));
  expect(verdict(capture)).toBe('pass');
  const changedMeta = structuredClone(capture);
  changedMeta.pages[1].items[0].name = 'different_tool';
  expect(verdict(changedMeta)).toBe('fail');
  const changedBody = structuredClone(capture);
  changedBody.contents.at(-1)!.text = '{"value":2}';
  expect(verdict(changedBody)).toBe('fail');
});

test('different sequences reusing a call id remain two attempts and fail', () => {
  const capture = recorded([call(), result(), call(), result()]);
  expect(normalizeTrajectory(capture).attempts).toHaveLength(2);
  expect(verdict(capture)).toBe('fail');
  expect(check(capture, 'budget').verdict).toBe('fail');
});

test('owned scope checks retain bot/run/revision/group identity on every page and chunk', () => {
  const others: TranscriptScope[] = [
    { ...scope, bot: 'mock-other-bot' },
    { ...scope, runId: 'mock-other-run' },
    { ...scope, chatRevision: 1 },
    { bot: scope.bot, runId: scope.runId, conversationId: 'mock-group' },
  ];
  for (const other of others) {
    const pages = recorded([call(), result()]);
    pages.pages[0] = { ...other, state: 'complete', items: pages.pages[0].items };
    expect(verdict(pages)).toBe('fail');
    const content = recorded([call(), result()]);
    const original = content.contents[0];
    content.contents[0] = {
      ...other,
      seq: original.seq,
      offset: original.offset,
      total: original.total,
      text: original.text,
      ...(original.nextOffset !== undefined ? { nextOffset: original.nextOffset } : {}),
    };
    expect(verdict(content)).toBe('fail');
  }
});

test('page gaps and unconsumed nextAfter do not turn absence into a passing empty run', () => {
  const capture = recorded([call(), result()]);
  capture.pages[0].items[0].seq = 2;
  capture.pages[0].items[1].seq = 3;
  capture.contents[0].seq = 2;
  capture.contents[1].seq = 3;
  expect(verdict(capture)).toBe('inconclusive');
  const tail = recorded([call(), result()]);
  tail.pages[0].nextAfter = 2;
  expect(verdict(tail)).toBe('inconclusive');
});

test('UTF-16 chunks preserve split surrogate pairs and enforce the complete offset chain', () => {
  const value = `${'x'.repeat(31990)}😀${'y'.repeat(20)}`;
  const body = JSON.stringify({ value });
  const spec = oneCase();
  spec.steps[0].args = { value };
  const capture = recorded([call('mock-call', 'mock_tool', body), result()]);
  expect(capture.contents.length).toBeGreaterThan(2);
  expect(verdict(capture, spec)).toBe('pass');
  const missing = structuredClone(capture);
  missing.contents.splice(1, 1);
  expect(verdict(missing, spec)).toBe('inconclusive');
  const wrongOffset = structuredClone(capture);
  wrongOffset.contents[1].offset++;
  expect(verdict(wrongOffset, spec)).toBe('inconclusive');
  const changedTotal = structuredClone(capture);
  changedTotal.contents[1].total++;
  expect(verdict(changedTotal, spec)).toBe('inconclusive');
  const loop = structuredClone(capture);
  loop.contents[0].nextOffset = 0;
  expect(verdict(loop, spec)).toBe('inconclusive');
});

test('assistant, thinking and plan bodies are neither required nor tool evidence', () => {
  const capture = recorded([
    call(),
    { kind: 'thinking', text: 'SYNTHETIC PRIVATE REASONING' },
    result(),
    { kind: 'assistant', text: 'SYNTHETIC FINAL CLAIM' },
    { kind: 'plan', text: 'SYNTHETIC PLAN' },
  ]);
  expect(verdict(capture)).toBe('pass');
  expect(verdict(recorded([{ kind: 'assistant', text: 'Tool completed.' }]))).toBe('fail');
});

test('tool coverage retains multiplicity and strict call order', () => {
  const spec = oneCase();
  spec.steps.push({ slot: 'second', tool: 'other_tool', args: { value: 2 }, result: 'success' });
  spec.budget.maxCalls = 2;
  expect(
    verdict(
      recorded([call(), result(), call('call-2', 'other_tool', '{"value":2}'), result('call-2')]),
      spec,
    ),
  ).toBe('pass');
  expect(
    check(
      recorded([call('call-2', 'other_tool', '{"value":2}'), result('call-2'), call(), result()]),
      'order',
      spec,
    ).verdict,
  ).toBe('fail');
  expect(verdict(recorded([call(), result()]), spec)).toBe('fail');
  expect(verdict(recorded([call(), result(), call('call-2'), result('call-2')]))).toBe('fail');
});

test('repeated tools use slot order for arguments instead of matching by name', () => {
  const spec = oneCase();
  spec.steps.push({ ...spec.steps[0], slot: 'second', args: { value: 2 } });
  spec.budget.maxCalls = 2;
  const capture = recorded([call(), result(), call('call-2'), result('call-2')]);
  const report = evaluate(capture, spec);
  expect(report.verdict).toBe('fail');
  expect(report.checks.find((entry) => entry.check === 'arguments')!.pointers).toContain(
    '/second/value',
  );
});

test('arguments retain missing/null, number/string and array ordering distinctions', () => {
  const spec = oneCase();
  spec.steps[0].args = { nested: { a: 1, b: 2 }, list: [1, 2], optional: null };
  expect(
    verdict(
      recorded([
        call('mock-call', 'mock_tool', '{"optional":null,"list":[1,2],"nested":{"b":2,"a":1}}'),
        result(),
      ]),
      spec,
    ),
  ).toBe('pass');
  for (const args of [
    '{"list":[1,2],"nested":{"a":1,"b":2}}',
    '{"optional":null,"list":[1,2],"nested":{"a":"1","b":2}}',
    '{"optional":null,"list":[2,1],"nested":{"a":1,"b":2}}',
  ])
    expect(verdict(recorded([call('mock-call', 'mock_tool', args), result()]), spec)).toBe('fail');
});

test('duplicate JSON keys, unsafe integers and invalid numbers cannot silently canonicalize', () => {
  for (const args of [
    '{"value":1,"value":1}',
    '{"value":1,"\\u0076alue":1}',
    '{"value":9007199254740993}',
    '{"value":1e500}',
  ]) {
    const capture = recorded([call('mock-call', 'mock_tool', args), result()]);
    expect(check(capture, 'arguments').verdict).toBe('fail');
  }
  expect(() => canonicalTrajectory({ value: Number.NaN })).toThrow();
  expect(() => canonicalTrajectory({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  expect(canonicalTrajectory({ value: 12.34 })).toBe('{"value":12.34}');
});

test('error and refused attempts still consume the call budget and cannot satisfy success', () => {
  const capture = recorded([call(), result('mock-call', 'COMMAND_APPROVAL_REJECTED', true)]);
  expect(check(capture, 'coverage').verdict).toBe('fail');
  const spec = oneCase();
  spec.steps[0].result = 'error';
  spec.steps[0].code = 'COMMAND_APPROVAL_REJECTED';
  expect(verdict(capture, spec)).toBe('pass');
  spec.budget.maxCalls = 0;
  expect(check(capture, 'budget', spec).verdict).toBe('fail');
  spec.budget.maxCalls = 1;
  spec.steps[0].code = 'COMMAND_CANCELLED';
  expect(check(capture, 'coverage', spec).verdict).toBe('fail');
});

test('model request budgets require the fixture counter instead of session statistics', () => {
  const spec = oneCase();
  spec.budget.maxModelRequests = 2;
  const capture = recorded([call(), result()]);
  expect(check(capture, 'budget', spec).verdict).toBe('inconclusive');
  expect(verdict({ ...capture, modelRequests: 2 }, spec)).toBe('pass');
  expect(check({ ...capture, modelRequests: 3 }, 'budget', spec).verdict).toBe('fail');
});

test('normalization touches only declared pointers and retains workspace suffix boundaries', () => {
  const spec = oneCase();
  spec.steps[0].args = {
    path: `\${workspace}/nested/file.txt`,
    nonce: `\${nonce}`,
    id: 'business-id',
  };
  spec.rules = [
    { pointer: '/first/path', kind: 'workspace', alias: 'workspace' },
    { pointer: '/first/nonce', kind: 'nonce', alias: 'nonce' },
  ];
  const capture = recorded([
    call(
      'mock-call',
      'mock_tool',
      '{"path":"/tmp/mock-root/nested/file.txt","nonce":"mock-42","id":"business-id"}',
    ),
    result(),
  ]);
  capture.bindings = { workspace: '/tmp/mock-root', nonce: 'mock-42' };
  expect(verdict(capture, spec)).toBe('pass');
  for (const path of ['/tmp/mock-root-other/nested/file.txt', '/tmp/mock-root/../file.txt']) {
    const changed = recorded([
      call('mock-call', 'mock_tool', JSON.stringify({ path, nonce: 'mock-42', id: 'business-id' })),
      result(),
    ]);
    changed.bindings = capture.bindings;
    expect(check(changed, 'arguments', spec).verdict).toBe('fail');
  }
  const nonce = structuredClone(capture);
  nonce.bindings.nonce = 'mock-43';
  expect(check(nonce, 'arguments', spec).verdict).toBe('fail');
});

test('nonce aliases preserve shared references and cannot collapse different alias identities', () => {
  const spec = oneCase();
  spec.steps[0].args = { first: `\${nonce}`, second: `\${nonce}` };
  spec.rules = [
    { pointer: '/first/first', kind: 'nonce', alias: 'nonce' },
    { pointer: '/first/second', kind: 'nonce', alias: 'nonce' },
  ];
  const capture = recorded([
    call('mock-call', 'mock_tool', '{"first":"mock-nonce","second":"mock-nonce"}'),
    result(),
  ]);
  capture.bindings = { nonce: 'mock-nonce' };
  expect(verdict(capture, spec)).toBe('pass');
  capture.contents[0].text = '{"first":"mock-nonce","second":"other-nonc"}';
  capture.contents[0].total = capture.contents[0].text.length;
  capture.pages[0].items[0].characters = capture.contents[0].text.length;
  expect(check(capture, 'arguments', spec).verdict).toBe('fail');
  const aliases = oneCase();
  aliases.steps[0].args = { first: `\${one}`, second: `\${two}` };
  aliases.rules = [
    { pointer: '/first/first', kind: 'nonce', alias: 'one' },
    { pointer: '/first/second', kind: 'nonce', alias: 'two' },
  ];
  const collapsed = recorded([
    call('mock-call', 'mock_tool', '{"first":"same","second":"same"}'),
    result(),
  ]);
  collapsed.bindings = { one: 'same', two: 'same' };
  expect(check(collapsed, 'arguments', aliases).verdict).toBe('fail');
});

test('sensitive values compare before report redaction and already redacted evidence stays unknown', () => {
  const spec = oneCase();
  spec.steps[0].args = { secret: 'mock-secret-one' };
  spec.sensitive = ['/first/secret'];
  const capture = recorded([
    call('mock-call', 'mock_tool', '{"secret":"mock-secret-two"}'),
    result(),
  ]);
  const report = evaluate(capture, spec);
  expect(report.verdict).toBe('fail');
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain('mock-secret-one');
  expect(serialized).not.toContain('mock-secret-two');
  expect(report.checks.find((entry) => entry.check === 'arguments')!.pointers).toContain(
    '/first/secret',
  );
  expect(
    check(
      recorded([call('mock-call', 'mock_tool', '{"secret":"[credential redacted]"}'), result()]),
      'arguments',
      spec,
    ).verdict,
  ).toBe('inconclusive');
});

test('RFC 6901 paths escape keys and invalid, missing or overlapping rules are input errors', () => {
  const spec = oneCase();
  spec.steps[0].args = { 'a/b': { '~key': `\${nonce}` } };
  spec.rules = [{ pointer: '/first/a~1b/~0key', kind: 'nonce', alias: 'nonce' }];
  const capture = recorded([
    call('mock-call', 'mock_tool', '{"a/b":{"~key":"mock-nonce"}}'),
    result(),
  ]);
  capture.bindings = { nonce: 'mock-nonce' };
  expect(verdict(capture, spec)).toBe('pass');
  for (const pointer of ['/missing/value', '/first/missing', '/first/a~2b', 'first/a']) {
    const invalid = structuredClone(spec);
    invalid.rules[0].pointer = pointer;
    expect(() => validateTrajectoryCase(invalid)).toThrow();
  }
  const overlap = structuredClone(spec);
  overlap.rules.push({ pointer: '/first/a~1b', kind: 'nonce', alias: 'other' });
  expect(() => validateTrajectoryCase(overlap)).toThrow();
});

test('only exact structured or whole-text unknown codes suspend a verdict and forbid later calls', () => {
  const spec = oneCase();
  spec.steps[0].result = 'error';
  for (const body of [
    'COMMAND_OUTCOME_UNKNOWN',
    'COMMAND_OUTCOME_UNKNOWN: synthetic acknowledgement was lost',
    '{"error":"COMMAND_OUTCOME_UNKNOWN"}',
    '{"error":{"code":"COMMAND_OUTCOME_UNKNOWN"}}',
  ]) {
    const capture = recorded([call(), result('mock-call', body, true)]);
    expect(check(capture, 'unknown', spec).verdict).toBe('inconclusive');
    expect(check(capture, 'no-replay', spec).verdict).toBe('pass');
    expect(verdict(capture, spec)).toBe('inconclusive');
    const replay = recorded([
      call(),
      result('mock-call', body, true),
      call('other-call', 'other_tool'),
      result('other-call'),
    ]);
    expect(check(replay, 'no-replay', spec).verdict).toBe('fail');
  }
  for (const body of ['FUTURE_OUTCOME_UNKNOWN', 'COMMAND_OUTCOME_UNKNOWN_EXTRA'])
    expect(
      check(recorded([call(), result('mock-call', body, true)]), 'unknown', spec).verdict,
    ).toBe('inconclusive');
  expect(
    verdict(
      recorded([call(), result('mock-call', 'not a code COMMAND_OUTCOME_UNKNOWN', true)]),
      spec,
    ),
  ).toBe('pass');
  expect(
    verdict(
      recorded([
        call(),
        result('mock-call', '{"nested":{"error":"COMMAND_OUTCOME_UNKNOWN"}}', true),
      ]),
      spec,
    ),
  ).toBe('pass');
});

test('an observed unknown code cannot be hidden in success metadata or contradictory result fields', () => {
  const capture = recorded([call(), result('mock-call', '{"error":"COMMAND_OUTCOME_UNKNOWN"}')]);
  expect(verdict(capture)).not.toBe('pass');
  const contradicted = recorded([
    call(),
    {
      ...result('mock-call', '{"error":"COMMAND_OUTCOME_UNKNOWN"}', true),
      code: 'COMMAND_APPROVAL_REJECTED',
    },
  ]);
  expect(verdict(contradicted)).not.toBe('pass');
});

test('stopAfter fences the result event even if a later call changes tool and identity', () => {
  const spec = oneCase();
  spec.steps[0].result = 'error';
  spec.steps[0].code = 'COMMAND_CANCELLED';
  spec.stopAfter = 'first';
  const stopped = recorded([call(), result('mock-call', '{"error":"COMMAND_CANCELLED"}', true)]);
  expect(verdict(stopped, spec)).toBe('pass');
  const extra = recorded([
    call(),
    result('mock-call', 'COMMAND_CANCELLED', true),
    call('other-call', 'other_tool'),
    result('other-call'),
  ]);
  expect(check(extra, 'no-replay', spec).verdict).toBe('fail');
  const invalid = oneCase();
  invalid.stopAfter = 'first';
  expect(() => validateTrajectoryCase(invalid)).toThrow();
});

test('artifact facts require stable verified bytes and an exact set of paths', () => {
  const spec = oneCase();
  spec.artifacts = [{ path: 'mock.txt', size: 4, sha256: 'b'.repeat(64) }];
  const capture = recorded([call(), result()]);
  capture.artifacts = [{ ...spec.artifacts[0], state: 'verified' }];
  expect(verdict(capture, spec)).toBe('pass');
  for (const reason of ['missing', 'changed', 'unsafe', 'too-large'] as const) {
    const unknown = {
      ...capture,
      artifacts: [{ path: 'mock.txt', state: 'unknown' as const, reason }],
    };
    expect(check(unknown, 'artifacts', spec).verdict).toBe('inconclusive');
  }
  expect(check({ ...capture, artifacts: [] }, 'artifacts', spec).verdict).toBe('inconclusive');
  const wrong = structuredClone(capture);
  if (wrong.artifacts[0].state === 'verified') wrong.artifacts[0].sha256 = 'c'.repeat(64);
  expect(check(wrong, 'artifacts', spec).verdict).toBe('fail');
  expect(
    check(
      {
        ...capture,
        artifacts: [
          ...capture.artifacts,
          { path: 'extra.txt', state: 'verified', size: 0, sha256: 'd'.repeat(64) },
        ],
      },
      'artifacts',
      spec,
    ).verdict,
  ).toBe('fail');
});

test('case hashes include script and expectations while excluding actual fixture bindings', () => {
  const spec = oneCase();
  const capture = recorded([call(), result()]);
  const first = evaluate(capture, spec);
  expect(first.caseHash).toMatch(/^[a-f0-9]{64}$/);
  expect(first.caseHash).not.toBe('0'.repeat(64));
  const reordered = oneCase();
  reordered.steps[0].args = { value: 1 };
  expect(evaluate(capture, reordered).caseHash).toBe(first.caseHash);
  for (const change of [
    (value: TrajectoryCase) => value.revision++,
    (value: TrajectoryCase) => value.budget.maxCalls++,
    (value: TrajectoryCase) => value.input.files.push({ path: 'mock.txt', utf8: 'SYNTHETIC' }),
    (value: TrajectoryCase) =>
      value.input.events.unshift({
        kind: 'call',
        callId: 'script-call',
        tool: 'script_tool',
        args: {},
      }),
  ]) {
    const changed = structuredClone(spec);
    change(changed);
    expect(evaluate(capture, changed).caseHash).not.toBe(first.caseHash);
  }
  expect(evaluate({ ...capture, bindings: { workspace: '/other-temp' } }, spec).caseHash).toBe(
    first.caseHash,
  );
  expect(hashTrajectory({ a: 1, nested: { b: 2, a: 3 } })).toBe(
    hashTrajectory({ nested: { a: 3, b: 2 }, a: 1 }),
  );
});

test('exact-key schema validation rejects unsupported input without accepting external evidence', () => {
  const unknown = { ...emptyCase(), owners: [{ verdict: 'pass' }], profile: '/user/profile' };
  expect(() => validateTrajectoryCase(unknown)).toThrow();
  expect(() => validateTrajectoryCase({ ...emptyCase(), schema: 2 })).toThrow();
  expect(() => validateTrajectoryCase({ ...emptyCase(), revision: 0 })).toThrow();
  expect(() => validateTrajectoryCase({ ...emptyCase(), parent: 'mock-parent' })).toThrow();
  const noBarrier = emptyCase();
  noBarrier.input.events = [];
  expect(() => validateTrajectoryCase(noBarrier)).toThrow();
  const extraBarrier = emptyCase();
  extraBarrier.input.events.push({ kind: 'barrier', action: 'stop' });
  expect(() => validateTrajectoryCase(extraBarrier)).toThrow();
});

test('bounded JSON rejects cycles, excessive nesting, key counts and collections', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => canonicalTrajectory(cyclic)).toThrow();
  let deep: unknown = 1;
  for (let index = 0; index < 20; index++) deep = { next: deep };
  expect(() => canonicalTrajectory(deep)).toThrow();
  expect(() =>
    canonicalTrajectory(
      Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`k${index}`, 1])),
    ),
  ).toThrow();
  expect(() => canonicalTrajectory(Array(1001).fill(1))).toThrow();
  expect(() =>
    validateTrajectoryCase({ ...oneCase(), steps: Array(1001).fill(oneCase().steps[0]) }),
  ).toThrow();
});

test('reports can only compare the same case and configuration fingerprints', () => {
  const first = evaluate(recorded([call(), result()]));
  expect(
    compareTrajectoryReports(first, { ...first, scope: { ...scope, runId: 'mock-new-run' } }),
  ).toBe('comparable');
  expect(compareTrajectoryReports(first, { ...first, caseHash: 'b'.repeat(64) })).toBe(
    'incomparable',
  );
  expect(compareTrajectoryReports(first, { ...first, configHash: 'b'.repeat(64) })).toBe(
    'incomparable',
  );
});

test('a redacted sensitive field cannot hide a proven mismatch in another argument', () => {
  const spec = oneCase();
  spec.steps[0].args = { secret: 'mock-secret-one', amount: 1 };
  spec.sensitive = ['/first/secret'];
  const capture = recorded([
    call('mock-call', 'mock_tool', '{"secret":"[redacted]","amount":2}'),
    result(),
  ]);
  const report = evaluate(capture, spec);
  expect(report.verdict).toBe('fail');
  expect(report.checks.find((entry) => entry.check === 'arguments')!.pointers).toContain(
    '/first/amount',
  );
});

test('normalization cannot claim a mismatch from an already redacted sensitive binding', () => {
  const spec = oneCase();
  spec.steps[0].args = { token: `\${nonce}` };
  spec.sensitive = ['/first/token'];
  spec.rules = [{ pointer: '/first/token', kind: 'nonce', alias: 'nonce' }];
  const capture = recorded([call('mock-call', 'mock_tool', '{"token":"[redacted]"}'), result()]);
  capture.bindings = { nonce: 'mock-nonce' };
  expect(verdict(capture, spec)).toBe('inconclusive');
});

test('workspace roots support Windows native separators and filesystem-root boundaries', () => {
  const spec = oneCase();
  spec.steps[0].args = { path: `\${workspace}/report.txt` };
  spec.rules = [{ pointer: '/first/path', kind: 'workspace', alias: 'workspace' }];
  for (const [root, path] of [
    ['C:\\Users\\mock\\artifacts', 'C:\\Users\\mock\\artifacts/report.txt'],
    ['/', '/report.txt'],
  ]) {
    const capture = recorded([call('mock-call', 'mock_tool', JSON.stringify({ path })), result()]);
    capture.bindings = { workspace: root };
    expect(verdict(capture, spec)).toBe('pass');
  }
});

test('duplicate JSON result keys cannot conceal an uncertain outcome', () => {
  const capture = recorded([
    call(),
    result('mock-call', '{"error":"COMMAND_OUTCOME_UNKNOWN","error":"benign"}'),
  ]);
  expect(verdict(capture)).toBe('inconclusive');
});

test('every supported unknown code suspends success while ordinary embedded text does not', () => {
  const codes = [
    'MCP_OUTCOME_UNKNOWN',
    'COMMAND_OUTCOME_UNKNOWN',
    'EXECUTION_OUTCOME_UNKNOWN',
    'PROCESS_OUTCOME_UNKNOWN',
    'BROWSER_OUTCOME_UNKNOWN',
    'COMPUTER_OUTCOME_UNKNOWN',
    'SOFTWARE_OUTCOME_UNKNOWN',
    'REMOTE_OUTCOME_UNKNOWN',
  ];
  for (const code of codes) {
    const spec = oneCase();
    spec.steps[0].result = 'error';
    expect(
      verdict(
        recorded([call(), result('mock-call', `${code}: synthetic uncertainty`, true)]),
        spec,
      ),
    ).toBe('inconclusive');
  }
});

test('durable human cards may contain bounded plain text without changing tool pairing', () => {
  expect(
    verdict(
      recorded([
        call(),
        { kind: 'interaction', text: 'SYNTHETIC HUMAN DECISION', callId: 'mock-human-card' },
        result(),
      ]),
    ),
  ).toBe('pass');
});

test('normalized call ids must retain original evidence rather than redaction placeholders', () => {
  const capture = recorded([call('[redacted]'), result('[redacted]')]);
  expect(verdict(capture)).toBe('inconclusive');
});

test('a proven order violation outranks an unrelated missing human-card body', () => {
  const spec = oneCase();
  spec.steps.push({ slot: 'second', tool: 'other_tool', args: { value: 2 }, result: 'success' });
  spec.budget.maxCalls = 2;
  const capture = recorded([
    call('other-call', 'other_tool', '{"value":2}'),
    result('other-call'),
    call(),
    result(),
    { kind: 'interaction', text: 'SYNTHETIC HUMAN CARD' },
  ]);
  capture.contents = capture.contents.filter((part) => part.seq !== 5);
  expect(check(capture, 'order', spec).verdict).toBe('fail');
  expect(verdict(capture, spec)).toBe('fail');
});

test('sensitive subtree differences report only the declared pointer, including private keys', () => {
  const spec = oneCase();
  spec.steps[0].args = { secret: { expected: 'mock-secret' } };
  spec.sensitive = ['/first/secret'];
  const capture = recorded([
    call('mock-call', 'mock_tool', '{"secret":{"SYNTHETIC_PRIVATE_KEY":"mock-other"}}'),
    result(),
  ]);
  const report = evaluate(capture, spec);
  expect(report.verdict).toBe('fail');
  expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PRIVATE_KEY');
  expect(report.checks.find((entry) => entry.check === 'arguments')!.pointers).toStrictEqual([
    '/first/secret',
  ]);
});

test('redaction markers anywhere in argument evidence cannot certify a matching value', () => {
  const spec = oneCase();
  spec.steps[0].args = { value: '[redacted]' };
  expect(
    verdict(recorded([call('mock-call', 'mock_tool', '{"value":"[redacted]"}'), result()]), spec),
  ).toBe('inconclusive');
});

test('capture and script bounds are checked before iterating or serializing unbounded collections', () => {
  const capture = recorded([call(), result()]);
  capture.pages[0].items = Array.from({ length: 21 }, (_, index) => ({
    ...capture.pages[0].items[0],
    seq: index + 1,
  }));
  expect(() => normalizeTrajectory(capture)).toThrow();
  const spec = oneCase();
  const large = 'x'.repeat(4 * 1024 * 1024);
  spec.input.events = [
    { kind: 'call', callId: 'script-call', tool: 'mock_tool', args: { large } },
    { kind: 'result', callId: 'script-call', body: { large }, isError: false },
    { kind: 'barrier', action: 'complete' },
  ];
  expect(() => validateTrajectoryCase(spec)).toThrow();
});

test('nonexistent optional case fields are omitted from the version fingerprint', () => {
  const plain = oneCase();
  const optional = oneCase();
  optional.steps[0].code = undefined;
  optional.budget.maxModelRequests = undefined;
  expect(evaluate(recorded([call(), result()]), optional).caseHash).toBe(
    evaluate(recorded([call(), result()]), plain).caseHash,
  );
});

test('complete metadata proves missing expected calls even when a separate result is missing', () => {
  const spec = oneCase();
  spec.steps.push({ slot: 'second', tool: 'other_tool', args: { value: 2 }, result: 'success' });
  spec.budget.maxCalls = 2;
  const capture = recorded([call()]);
  expect(check(capture, 'coverage', spec).verdict).toBe('fail');
  expect(check(capture, 'budget', spec).verdict).toBe('pass');
  expect(verdict(capture, spec)).toBe('fail');
});

test('an unrelated missing human-card body cannot hide a missing call from complete metadata', () => {
  const spec = oneCase();
  spec.steps.push({ slot: 'second', tool: 'other_tool', args: { value: 2 }, result: 'success' });
  spec.budget.maxCalls = 2;
  const capture = recorded([call(), result(), { kind: 'interaction', text: 'SYNTHETIC CARD' }]);
  capture.contents = capture.contents.filter((part) => part.seq !== 3);
  expect(check(capture, 'coverage', spec).verdict).toBe('fail');
  expect(verdict(capture, spec)).toBe('fail');
});

test('a missing tool name is unavailable identity evidence rather than a proven extra empty tool', () => {
  const missing = call();
  delete missing.name;
  const capture = recorded([missing, result()]);
  expect(verdict(capture)).toBe('inconclusive');
  expect(check(capture, 'coverage').verdict).toBe('inconclusive');
});

test('missing result bodies do not erase a complete metadata call-budget count', () => {
  const capture = recorded([call(), result()]);
  capture.contents = capture.contents.filter((part) => part.seq !== 2);
  expect(check(capture, 'budget').verdict).toBe('pass');
  expect(verdict(capture)).toBe('inconclusive');
});

test('missing prefix metadata can still complete an otherwise compatible call sequence', () => {
  const spec = oneCase();
  spec.steps.push({ slot: 'second', tool: 'other_tool', args: { value: 2 }, result: 'success' });
  spec.budget.maxCalls = 2;
  const capture = recorded([call('other-call', 'other_tool', '{"value":2}'), result('other-call')]);
  for (const page of capture.pages) for (const item of page.items) item.seq++;
  for (const part of capture.contents) part.seq++;
  expect(verdict(capture, spec)).toBe('inconclusive');
});

test.each([
  { alias: '__proto__', kind: 'workspace' as const },
  { alias: 'constructor', kind: 'workspace' as const },
  { alias: '__proto__', kind: 'nonce' as const },
  { alias: 'constructor', kind: 'nonce' as const },
])('binding $alias of kind $kind requires a fixture-owned property', ({ alias, kind }) => {
  const spec = oneCase();
  const marker = `\${${alias}}`;
  const binding = kind === 'workspace' ? '/tmp/mock-root' : 'mock-nonce';
  const actual = kind === 'workspace' ? `${binding}/file.txt` : binding;
  spec.steps[0].args = { value: kind === 'workspace' ? `${marker}/file.txt` : marker };
  spec.rules = [{ pointer: '/first/value', kind, alias }];
  const capture = recorded([
    call('mock-call', 'mock_tool', JSON.stringify({ value: actual })),
    result(),
  ]);
  expect(check(capture, 'arguments', spec).verdict).toBe('fail');
  Object.defineProperty(capture.bindings, alias, {
    value: binding,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  expect(verdict(capture, spec)).toBe('pass');
});
