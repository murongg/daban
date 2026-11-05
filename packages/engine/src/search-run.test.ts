import type { SearchResult } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Fault } from './control.js';
import { observeTools } from './events.js';
import { RunSearch, type SearchRun } from './search-run.js';
import type { SearchCapture, SearchSettings } from './search-settings.js';

const snapshot: SearchCapture = {
  revision: 3,
  provider: 'brave',
  available: true,
  binding: 'synthetic-search-binding',
};
const result: SearchResult = {
  sources: [{ url: 'https://source.example.test/original?x=1', title: 'Synthetic source' }],
  truncated: false,
};
const params = (overrides: Record<string, unknown> = {}) => ({
  runId: 'mock-run',
  sessionId: 'mock-session',
  executionSessionId: 'mock-session',
  callId: 'mock-call',
  searchRevision: 3,
  queries: ['synthetic first', 'synthetic second'],
  query: 'synthetic first',
  maxResults: 5,
  ...overrides,
});
function fixture(query: Pick<SearchSettings, 'query'>['query'] = async () => result) {
  const calls: {
    query: string;
    maxResults: number | undefined;
    signal: AbortSignal | undefined;
  }[] = [];
  const run: SearchRun & { bot: string; seen: Record<string, number>; trace: [] } = {
    id: 'mock-run',
    sessionId: 'mock-session',
    abort: new AbortController(),
    toolCount: 0,
    limit: 3,
    bot: 'mock-bot',
    seen: {},
    trace: [],
  };
  let current = snapshot;
  const service = {
    async capture() {
      return current;
    },
    async query(
      captured: SearchCapture,
      queryText: string,
      signal?: AbortSignal,
      maxResults?: number,
    ) {
      calls.push({ query: queryText, maxResults, signal });
      return query(captured, queryText, signal, maxResults);
    },
  };
  return {
    run,
    calls,
    owner: new RunSearch(service, snapshot, run),
    change(value: SearchCapture) {
      current = value;
    },
  };
}

test('search RPC IDs and a declared tool batch dispatch each exact query once', async () => {
  const { owner, run, calls } = fixture();
  const [first, replay] = await Promise.all([
    owner.query('mock-rpc', params()),
    owner.query('mock-rpc', params()),
  ]);
  expect(first).toEqual(result);
  expect(replay).toEqual(result);
  expect(calls).toHaveLength(1);
  expect(run.toolCount).toBe(1);
  expect(await owner.query('mock-query-alias', params())).toEqual(result);
  expect(calls).toHaveLength(1);
  expect(await owner.query('mock-second', params({ query: 'synthetic second' }))).toEqual(result);
  expect(calls.map((call) => call.query)).toEqual(['synthetic first', 'synthetic second']);
  expect(calls[0].signal).toBe(run.abort.signal);
  expect(calls[0].maxResults).toBe(5);
  expect(run.toolCount).toBe(1);
  await expect(
    owner.query('mock-rpc', params({ query: 'synthetic second' })),
  ).rejects.toMatchObject({ code: 'SEARCH_REQUEST_CONFLICT' });
  await expect(
    owner.query('mock-changed-batch', params({ queries: ['synthetic first'], maxResults: 4 })),
  ).rejects.toMatchObject({ code: 'SEARCH_REQUEST_CONFLICT' });
});
test('RPC validation rejects scope, revision, undeclared queries and permission overrides before dispatch', async () => {
  const { owner, run, calls } = fixture();
  for (const input of [
    params({ runId: 'other-run' }),
    params({ sessionId: 'other-session' }),
    params({ searchRevision: 2 }),
    params({ queries: ['one', 'two', 'three', 'four', 'five'] }),
    params({ query: 'not declared' }),
    params({ queries: [] }),
    params({ maxResults: 6 }),
    params({ maxResults: 0 }),
    params({ maxResults: 1.5 }),
    params({ provider: 'deepseek' }),
    params({ key: 'synthetic-secret' }),
    params({ endpoint: 'https://foreign.example.test' }),
    params({ executionSessionId: '' }),
    params({ callId: 'x'.repeat(201) }),
    params({ queries: [' '], query: ' ' }),
  ])
    await expect(owner.query('mock-invalid', input)).rejects.toBeInstanceOf(Fault);
  for (const id of [null, {}, [], false, '', 1.5, Number.NaN])
    await expect(owner.query(id, params())).rejects.toBeInstanceOf(Fault);
  expect(calls).toHaveLength(0);
  expect(run.toolCount).toBe(0);
});
test('query and owner limits bound Host dispatch even when the SDK is bypassed', async () => {
  const { owner, run, calls } = fixture();
  let stopped = 0;
  run.onLimit = () => {
    stopped++;
  };
  run.toolCount = 2;
  await owner.query('mock-one', params());
  expect(run.toolCount).toBe(3);
  await expect(owner.query('mock-over', params({ callId: 'next-call' }))).rejects.toMatchObject({
    code: 'TOOL_LIMIT',
  });
  expect(calls).toHaveLength(1);
  expect(stopped).toBe(1);
});
test('unknown supplier outcomes remain claimed in memory and cannot be retried under another RPC ID', async () => {
  const { owner, calls } = fixture(async () => {
    throw new Fault('SEARCH_TIMEOUT');
  });
  await expect(owner.query(1, params())).rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
  await expect(owner.query(1, params())).rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
  await expect(owner.query(2, params())).rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
  expect(calls).toHaveLength(1);
});
test('Stop, session replacement and search configuration changes suppress late and cached sources', async () => {
  let settle: ((result: SearchResult) => unknown) | undefined;
  const pending = new Promise<SearchResult>((resolve) => {
    settle = resolve;
  });
  const first = fixture(async () => pending);
  const response = first.owner.query('mock-late', params());
  for (let i = 0; i < 10 && !first.calls.length; i++) await Promise.resolve();
  first.run.abort.abort();
  settle?.(result);
  await expect(response).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  const second = fixture();
  await second.owner.query('mock-cached', params());
  second.run.sessionId = 'new-session';
  await expect(second.owner.query('mock-cached', params())).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  const third = fixture();
  await third.owner.query('mock-cached', params());
  third.change({ ...snapshot, revision: 4, binding: 'new-synthetic-binding' });
  await expect(third.owner.query('mock-cached', params())).rejects.toMatchObject({
    code: 'SEARCH_CONFIG_CHANGED',
  });
  expect(third.calls).toHaveLength(1);
});
test('source objects returned to callers cannot mutate a cached original result', async () => {
  const { owner } = fixture();
  const first = await owner.query('mock-rpc', params());
  first.sources[0].url = 'https://tampered.example.test/';
  expect(await owner.query('mock-rpc', params())).toEqual(result);
});
test('Host and native observation count a search batch once regardless of arrival order', async () => {
  for (const nativeFirst of [false, true]) {
    const { owner, run } = fixture();
    const observe = observeTools(run, 'mock-session');
    const note = {
      method: 'session.event',
      params: {
        sessionId: 'mock-session',
        event: { type: 'tool/call', data: { name: 'web_search', callId: 'mock-call' } },
      },
    };
    if (nativeFirst) observe(note);
    await owner.query('mock-rpc', params());
    if (!nativeFirst) observe(note);
    expect(run.toolCount).toBe(1);
    expect(run.trace).toHaveLength(1);
  }
});
test('owned child invocations share the run quota but keep distinct session call identities', async () => {
  const { owner, run, calls } = fixture();
  await owner.query('mock-root', params());
  await owner.query('mock-child', params({ executionSessionId: 'mock-child-session' }));
  expect(run.toolCount).toBe(2);
  expect(calls).toHaveLength(2);
});
test('unavailable captured search is refused without dispatch', async () => {
  const run: SearchRun = {
    id: 'mock-run',
    sessionId: 'mock-session',
    abort: new AbortController(),
    toolCount: 0,
    limit: 3,
  };
  const unavailable = { ...snapshot, available: false };
  const owner = new RunSearch(
    {
      capture: async () => unavailable,
      query: async () => {
        throw new Error('must not dispatch');
      },
    },
    unavailable,
    run,
  );
  await expect(owner.query('mock-unavailable', params())).rejects.toMatchObject({
    code: 'SEARCH_NOT_CONFIGURED',
  });
});

test('a replay cannot release cached sources after another tool has exhausted the shared quota', async () => {
  const { owner, run, calls } = fixture();
  await owner.query('mock-cached-limit', params());
  run.toolCount = run.limit + 1;
  await expect(owner.query('mock-cached-limit', params())).rejects.toMatchObject({
    code: 'TOOL_LIMIT',
  });
  expect(calls).toHaveLength(1);
});
test('RPC receipt aliases remain bounded instead of growing an unbounded query cache', async () => {
  const { owner, run, calls } = fixture();
  run.limit = 1;
  for (let i = 0; i < 4; i++) await owner.query(`mock-alias-${i}`, params());
  await expect(owner.query('mock-over-alias', params())).rejects.toMatchObject({
    code: 'TOOL_LIMIT',
  });
  expect(calls).toHaveLength(1);
});
test('a native fetch call identity cannot be borrowed as a free search budget slot', async () => {
  const { owner, run } = fixture();
  observeTools(
    run,
    'mock-session',
  )({
    method: 'session.event',
    params: {
      sessionId: 'mock-session',
      event: { type: 'tool/call', data: { name: 'web_fetch', callId: 'mock-call' } },
    },
  });
  expect(run.toolCount).toBe(1);
  await owner.query('mock-after-fetch', params());
  expect(run.toolCount).toBe(2);
});
