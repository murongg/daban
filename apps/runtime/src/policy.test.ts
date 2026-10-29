import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, requestedUrls } from './policy.js';

test('the policy declares approval as a required Cordis capability', () => {
  assert.ok(inject.includes('approval'));
});

test('native session-bound schedules cannot bypass the product schedule service', async () => {
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') listener = hook[1];
      },
    },
    { limit: 10, urls: [] },
  );
  let bodies = 0;
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  for (const name of ['schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list']) {
    const result = await listener(
      { signal: new AbortController().signal, name, arguments: {} },
      next,
    );
    assert.equal((result as { kind: string }).kind, 'deny');
  }
  await listener(
    { signal: new AbortController().signal, name: 'computer__bot_schedule_list', arguments: {} },
    next,
  );
  assert.equal(bodies, 1);
});

test('DSH pre-execute policy denies excess mixed native/MCP calls before any tool body runs', async () => {
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => {
    throw new Error('not installed');
  };
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') listener = hook[1];
      },
    },
    { limit: 2, urls: [] },
  );
  let bodies = 0;
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  const exec = { signal: new AbortController().signal, name: 'computer__read_file', arguments: {} };
  await listener(exec, next);
  await listener(exec, next);
  assert.deepEqual(await listener(exec, next), {
    kind: 'deny',
    reason: 'TOOL_LIMIT',
    info: { name: 'ToolLimitError', code: 'TOOL_LIMIT' },
  });
  assert.equal(bodies, 2);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await listener({ ...exec, signal: aborted.signal }, next), { kind: 'cancel' });
  assert.equal(bodies, 2);
  assert.throws(() => apply({ on: () => undefined }, { limit: 0, urls: [] }), /INVALID_TOOL_LIMIT/);
});

test('web policy allows only exact URLs supplied in this user request, not page-chosen destinations or queries', async () => {
  const urls = requestedUrls(
    '读取 [合成来源](https://example.test/page#intro)，再看 https://docs.example.test/。',
  );
  assert.deepEqual(urls, ['https://example.test/page', 'https://docs.example.test/']);
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') listener = hook[1];
      },
    },
    { limit: 10, urls },
  );
  let bodies = 0;
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  const exec = {
    signal: new AbortController().signal,
    name: 'web_fetch',
    arguments: { url: 'https://example.test/page#next' },
  };
  assert.deepEqual(await listener(exec, next), { kind: 'allow' });
  for (const url of [
    'https://example.test/page?data=synthetic-private',
    'https://untrusted.test/',
    'https://mock:secret@example.test/page',
  ]) {
    assert.deepEqual(await listener({ ...exec, arguments: { url } }, next), {
      kind: 'deny',
      reason:
        'Only fetch exact URLs provided by the user in this task. Ask the user to supply another URL.',
      info: { name: 'WebPolicyError', code: 'WEB_URL_NOT_AUTHORIZED' },
    });
  }
  assert.equal(bodies, 1);
});
test('a new web URL requires an exact single-use DSH approval and rejection never dispatches', async () => {
  let listener: (
    exec: {
      signal: AbortSignal;
      name: string;
      arguments: unknown;
      agent?: unknown;
      callId?: string;
    },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const requests: unknown[] = [];
  let grant = true,
    bodies = 0;
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') listener = hook[1];
      },
      approval: {
        request: async (request) => {
          requests.push(request);
          return grant ? 'allowed-once' : 'rejected';
        },
      },
    },
    { limit: 10, urls: [] },
  );
  const exec = {
    signal: new AbortController().signal,
    name: 'web_fetch',
    callId: 'mock-call',
    agent: {},
    arguments: { url: 'https://example.test/new' },
  };
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  await listener(exec, next);
  await listener({ ...exec, callId: 'mock-call-2' }, next);
  assert.equal(requests.length, 2, 'one grant must never become an always-allow URL rule');
  grant = false;
  const denied = await listener({ ...exec, callId: 'mock-call-3' }, next);
  assert.equal((denied as { kind: string }).kind, 'deny');
  assert.equal((denied as { info: { code: string } }).info.code, 'WEB_APPROVAL_REJECTED');
  assert.match((denied as { reason: string }).reason, /user declined/i);
  assert.equal(bodies, 2);
  assert.equal(
    (requests[0] as { reason: string }).reason,
    JSON.stringify({ url: 'https://example.test/new' }),
  );
});
test('native todo calls cannot report success with a plan the client cannot represent', async () => {
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') listener = hook[1];
      },
    },
    { limit: 10, urls: [] },
  );
  let bodies = 0;
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  const exec = {
    signal: new AbortController().signal,
    name: 'todo_write',
    arguments: { todos: [{ content: '合成一步', status: 'pending' }] },
  };
  await listener(exec, next);
  const denied = await listener(
    {
      ...exec,
      arguments: {
        todos: Array.from({ length: 33 }, (_value, index) => ({
          content: `合成步骤 ${index}`,
          status: 'pending',
        })),
      },
    },
    next,
  );
  assert.equal((denied as { info: { code: string } }).info.code, 'INVALID_TASK_PLAN');
  assert.equal(bodies, 1);
});
test('only exact URLs from a successful canonical search result bypass another approval in the same run', async () => {
  let pre: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  let post: (
    exec: { signal: AbortSignal; name: string; arguments: unknown },
    result: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  let approvals = 0,
    bodies = 0;
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1];
        else post = hook[1];
      },
      approval: {
        request: async () => {
          approvals++;
          return 'rejected';
        },
      },
    },
    { limit: 20, urls: [] },
  );
  const exec = {
    signal: new AbortController().signal,
    name: 'web_search',
    arguments: {},
    agent: {},
  };
  const accept = async () => ({ kind: 'accept' });
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  await post(
    exec,
    {
      isError: false,
      value: { sources: [{ url: 'https://example.test/source?x=1' }], truncated: false },
    },
    accept,
  );
  await pre(
    { ...exec, name: 'web_fetch', arguments: { url: 'https://example.test/source?x=1' } },
    next,
  );
  assert.equal(approvals, 0);
  assert.equal(bodies, 1);
  await pre(
    { ...exec, name: 'web_fetch', arguments: { url: 'https://example.test/source?x=1&data=mock' } },
    next,
  );
  assert.equal(approvals, 1);
  assert.equal(bodies, 1);
  for (const result of [
    { isError: true, value: { sources: [{ url: 'https://example.test/not-trusted' }] } },
    { isError: false, content: [{ type: 'text', text: 'https://example.test/not-trusted' }] },
  ])
    await post(exec, result, accept);
  await post(
    { ...exec, name: 'web_fetch' },
    { isError: false, value: { sources: [{ url: 'https://example.test/not-trusted' }] } },
    accept,
  );
  await pre(
    { ...exec, name: 'web_fetch', arguments: { url: 'https://example.test/not-trusted' } },
    next,
  );
  assert.equal(approvals, 2);
  assert.equal(bodies, 1);
});
