import { expect, test } from 'vitest';
import { approvalHash } from './approval-rules.js';
import { apply, inject, requestedUrls } from './policy.js';

function rootAgents(sessionId: string) {
  const root = { id: sessionId, session: { id: sessionId } };
  return {
    roots: () => [root],
    get: (id: string) => (id === root.id ? root : undefined),
    isOwnedBy: () => false,
  };
}

test.each(['human', 'revoked', 'owner'] as const)(
  'a child %s refusal after the approval wait consumes no shared tool claim',
  async (reason) => {
    let pre: (
      exec: {
        signal: AbortSignal;
        name: string;
        arguments: unknown;
        agent?: unknown;
        token?: symbol;
      },
      next: () => Promise<unknown>,
    ) => Promise<unknown> = async () => undefined;
    const root = { id: 'mock-root', session: { id: 'mock-root-session' } };
    const child = { id: 'mock-child', session: { id: 'mock-child-session' } };
    const scope = { kind: 'bot' as const, bot: 'mock-bot' };
    const selector = { kind: 'url' as const, url: 'https://example.test/child' };
    let present = true;
    let current = true;
    let claims = 0;
    let effects = 0;
    apply(
      {
        agents: {
          roots: () => [root],
          get: (id) => (id === root.id ? root : present && id === child.id ? child : undefined),
          isOwnedBy: (id, owner) => id === child.id && owner === root,
        },
        approval: {
          request: async (request) => {
            expect(request.agent).toBe(child);
            current = reason !== 'revoked';
            present = reason !== 'owner';
            return reason === 'human' ? 'rejected' : 'allowed-once';
          },
        },
        on: (...hook: unknown[]) => {
          if (hook[0] === 'tools/pre-execute') pre = hook[1] as typeof pre;
        },
      },
      {
        limit: 10,
        urls: [],
        attemptId: 'mock-attempt',
        budget: { budgetId: 'mock-budget', revision: 1 },
        url: 'http://127.0.0.1/mcp/mock-bot',
        capability: 'synthetic-capability',
      },
      async (_url, init) => {
        const body = JSON.parse(String(init.body)) as {
          method: string;
          params: { sessionId?: string };
        };
        if (body.method === 'budget.tool') {
          claims++;
          expect(body.params.sessionId).toBe(root.session.id);
        }
        return Response.json({
          result:
            body.method === 'approval.web'
              ? {
                  effect: 'ask',
                  source: 'rule',
                  reasonCode: 'ruleAsked',
                  matchedRules: [],
                  policyRevision: 1,
                  requestHash: approvalHash([scope, 'interactive', selector]),
                  scope,
                  trigger: 'interactive',
                  selector,
                }
              : body.method === 'approval.web.check'
                ? { current }
                : { accepted: true },
        });
      },
    );
    const result = await pre(
      {
        signal: new AbortController().signal,
        name: 'web_fetch',
        arguments: { url: selector.url },
        agent: child,
        token: Symbol('synthetic-child'),
      },
      async () => {
        effects++;
        return { kind: 'allow' };
      },
    );
    expect(result).toMatchObject({ kind: 'deny' });
    expect(effects).toBe(0);
    expect(claims).toBe(0);
  },
);

test.each(['review', 'budget'] as const)(
  'a physical attempt changed during %s cannot reach the native body',
  async (stage) => {
    let listener: (
      exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
      next: () => Promise<unknown>,
    ) => Promise<unknown> = async () => undefined;
    const root = { id: 'mock-root', session: { id: 'mock-session' } };
    const scope = { kind: 'bot' as const, bot: 'mock-bot' };
    const selector = { kind: 'url' as const, url: 'https://example.test/race' };
    let current = true;
    let effects = 0;
    let claims = 0;
    const config = {
      limit: 10,
      urls: [selector.url],
      attemptId: 'mock-attempt',
      url: 'http://127.0.0.1/mcp/mock-bot',
      capability: 'synthetic-capability',
      ...(stage === 'budget' ? { budget: { budgetId: 'mock-budget', revision: 1 } } : {}),
    };
    apply(
      {
        agents: {
          roots: () => [root],
          get: (id) => (id === root.id ? root : undefined),
          isOwnedBy: () => false,
        },
        on: (...hook: unknown[]) => {
          if (hook[0] === 'tools/pre-execute') listener = hook[1] as typeof listener;
        },
      },
      config,
      async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { method: string };
        if (body.method === 'attempt.fence')
          return Response.json({ result: { accepted: current } });
        if (body.method === 'budget.tool') {
          claims++;
          current = false;
          return Response.json({ result: { accepted: true } });
        }
        if (body.method === 'approval.web') {
          if (stage === 'review') current = false;
          return Response.json({
            result: {
              effect: 'allow',
              source: 'rule',
              reasonCode: 'ruleAllowed',
              matchedRules: [],
              policyRevision: 1,
              requestHash: approvalHash([scope, 'interactive', selector]),
              scope,
              trigger: 'interactive',
              selector,
            },
          });
        }
        return Response.json({ result: { current: true } });
      },
    );
    const exec = {
      signal: new AbortController().signal,
      name: 'web_fetch',
      arguments: { url: selector.url },
      agent: root,
      token: Symbol('synthetic-execution'),
    };
    expect(
      await listener(exec, async () => {
        effects++;
        return { kind: 'allow' };
      }),
    ).toMatchObject({ kind: 'deny' });
    expect(effects).toBe(0);
    expect(claims).toBe(stage === 'budget' ? 1 : 0);
  },
);

test('abort during the final durable attempt acknowledgement cannot enter a native body', async () => {
  let pre: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; token?: symbol },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const abort = new AbortController();
  let fences = 0;
  let claims = 0;
  let effects = 0;
  apply(
    {
      agents: rootAgents('mock-session'),
      on: (...hook: unknown[]) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1] as typeof pre;
      },
    },
    {
      limit: 10,
      urls: [],
      attemptId: 'mock-attempt',
      budget: { budgetId: 'mock-budget', revision: 1 },
      url: 'http://127.0.0.1/mcp/mock-bot',
      capability: 'synthetic-capability',
    },
    async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      if (body.method === 'attempt.fence' && ++fences === 2) abort.abort();
      if (body.method === 'budget.tool') claims++;
      return Response.json({ result: { accepted: true } });
    },
  );
  const result = await pre(
    {
      signal: abort.signal,
      name: 'todo_write',
      arguments: { todos: [{ content: 'Synthetic step', status: 'pending' }] },
      token: Symbol('synthetic-call'),
    },
    async () => {
      effects++;
      return { kind: 'allow' };
    },
  );
  expect(result).toMatchObject({ kind: expect.stringMatching(/^(deny|cancel)$/) });
  expect(effects).toBe(0);
  expect(claims).toBe(1);
});

test('the flat physical attempt and shared budget scope are captured before caller mutation', async () => {
  let pre: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; token?: symbol },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const config = {
    limit: 10,
    urls: [],
    attemptId: 'mock-original-attempt',
    budget: { budgetId: 'mock-original-budget', revision: 1 },
    url: 'http://127.0.0.1/mcp/mock-bot',
    capability: 'synthetic-original-capability',
  };
  let effects = 0;
  const bodies: { method: string; params: Record<string, unknown> }[] = [];
  apply(
    {
      agents: rootAgents('mock-session'),
      on: (...hook: unknown[]) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1] as typeof pre;
      },
    },
    config,
    async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer synthetic-original-capability',
      );
      const body = JSON.parse(String(init.body)) as {
        method: string;
        params: Record<string, unknown>;
      };
      bodies.push(body);
      return Response.json({ result: { accepted: true } });
    },
  );
  config.attemptId = 'mock-replacement-attempt';
  config.budget.budgetId = 'mock-replacement-budget';
  config.capability = 'synthetic-replacement-capability';
  await pre(
    {
      signal: new AbortController().signal,
      name: 'todo_write',
      arguments: { todos: [{ content: 'Synthetic step', status: 'pending' }] },
      token: Symbol('synthetic-call'),
    },
    async () => {
      effects++;
      return { kind: 'allow' };
    },
  );
  expect(effects).toBe(1);
  expect(
    bodies
      .filter((body) => body.method === 'attempt.fence')
      .every((body) => body.params.attemptId === 'mock-original-attempt'),
  ).toBe(true);
  expect(bodies.filter((body) => body.method === 'budget.tool')).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({
        scope: { budgetId: 'mock-original-budget', revision: 1 },
        modelAttemptId: 'mock-original-attempt',
      }),
    }),
  ]);
});

test.each([true, false])(
  'published flat attempt/budget config retains Host approval before dispatch: deny=%s',
  async (deny) => {
    let listener: (
      exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
      next: () => Promise<unknown>,
    ) => Promise<unknown> = async () => undefined;
    const root = { id: 'mock-root', session: { id: 'mock-session' } };
    const selector = { kind: 'url' as const, url: 'https://example.test/joint' };
    const scope = { kind: 'bot' as const, bot: 'mock-bot' };
    const methods: string[] = [];
    let effects = 0;
    const config = {
      limit: 10,
      urls: [selector.url],
      url: 'http://127.0.0.1/mcp/mock-bot',
      capability: 'synthetic-capability',
      attemptId: 'mock-attempt',
      budget: { budgetId: 'mock-budget', revision: 1 },
    };
    apply(
      {
        agents: {
          roots: () => [root],
          get: (id) => (id === root.id ? root : undefined),
          isOwnedBy: () => false,
        },
        on: (...hook: unknown[]) => {
          if (hook[0] === 'tools/pre-execute') listener = hook[1] as typeof listener;
        },
      },
      config,
      async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { method: string };
        methods.push(body.method);
        return Response.json({
          result:
            body.method === 'approval.web'
              ? {
                  effect: deny ? 'deny' : 'allow',
                  source: 'rule',
                  reasonCode: deny ? 'ruleDenied' : 'ruleAllowed',
                  matchedRules: [],
                  policyRevision: 1,
                  requestHash: approvalHash([scope, 'interactive', selector]),
                  scope,
                  trigger: 'interactive',
                  selector,
                }
              : body.method === 'approval.web.check'
                ? { current: true }
                : { accepted: true },
        });
      },
    );
    const execution = {
      signal: new AbortController().signal,
      name: 'web_fetch',
      arguments: { url: selector.url },
      agent: root,
      token: Symbol('synthetic-execution'),
    };
    await listener(execution, async () => {
      effects++;
      return { kind: 'allow' };
    });
    expect(methods).toContain('approval.web');
    expect(methods).toContain('attempt.fence');
    expect(effects).toBe(deny ? 0 : 1);
    expect(methods.filter((method) => method === 'budget.tool')).toHaveLength(deny ? 0 : 1);
    if (!deny) expect(methods).toContain('approval.web.check');
  },
);

test('a supplied URL still consults Host deny and rechecks a captured decision immediately before fetch', async () => {
  for (const denied of [true, false]) {
    let listener: (
      exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
      next: () => Promise<unknown>,
    ) => Promise<unknown> = async () => undefined;
    let effects = 0;
    const methods: string[] = [];
    const selector = { kind: 'url' as const, url: 'https://example.test/mock' };
    const scope = { kind: 'bot' as const, bot: 'mock-bot' };
    const decision = {
      effect: denied ? 'deny' : 'allow',
      source: 'rule',
      reasonCode: denied ? 'ruleDenied' : 'baselineAllowed',
      matchedRules: [],
      policyRevision: 1,
      requestHash: approvalHash([scope, 'interactive', selector]),
      scope,
      trigger: 'interactive',
      selector,
    };
    const request = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      methods.push(body.method);
      return Response.json(
        body.method === 'approval.web'
          ? { result: decision }
          : { error: { code: 'APPROVAL_POLICY_CHANGED' } },
      );
    };
    const root = { id: 'mock-agent', session: { id: 'mock-session' } };
    const config = {
      limit: 10,
      urls: [selector.url],
      url: 'http://127.0.0.1/mcp/mock-bot',
      capability: 'synthetic-capability',
    };
    Reflect.apply(apply, undefined, [
      {
        agents: {
          roots: () => [root],
          get: (id: string) => (id === root.id ? root : undefined),
          isOwnedBy: () => false,
        },
        on: (...hook: unknown[]) => {
          if (hook[0] === 'tools/pre-execute') listener = hook[1] as typeof listener;
        },
      },
      config,
      request,
    ]);
    const result = await listener(
      {
        signal: new AbortController().signal,
        name: 'web_fetch',
        arguments: { url: selector.url },
        agent: root,
      },
      async () => {
        effects++;
        return { kind: 'allow' };
      },
    );
    expect(effects).toBe(0);
    expect(result).toMatchObject({ kind: 'deny' });
    expect(methods).toEqual(denied ? ['approval.web'] : ['approval.web', 'approval.web.check']);
  }
});

test('ask mode requests approval even for a URL supplied in the accepted task', async () => {
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  let asked = 0,
    dispatched = 0;
  apply(
    {
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') listener = hook[1];
      },
      approval: {
        request: async () => {
          asked++;
          return 'rejected';
        },
      },
    },
    { limit: 10, urls: ['https://example.test/mock'], approvalMode: 'ask' },
  );
  const result = await listener(
    {
      signal: new AbortController().signal,
      name: 'web_fetch',
      arguments: { url: 'https://example.test/mock' },
      agent: {},
    },
    async () => {
      dispatched++;
      return { kind: 'allow' };
    },
  );
  expect(result).toMatchObject({ kind: 'deny' });
  expect(asked).toBe(1);
  expect(dispatched).toBe(0);
});

test('the policy declares approval as a required Cordis capability', () => {
  expect.assert(inject.includes('approval'));
});

test('owned read-only children use the accepted root session for exact web rules without borrowing native approval', async () => {
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const root = { id: 'mock-root', session: { id: 'mock-root-session' } };
  const child = { id: 'mock-child', session: { id: 'mock-child-session' } };
  let effects = 0;
  const sessions: unknown[] = [];
  const scope = { kind: 'bot' as const, bot: 'mock-bot' };
  const selector = { kind: 'url' as const, url: 'https://example.test/mock-child-read' };
  const context: Parameters<typeof apply>[0] = {
    agents: {
      roots: () => [root],
      get: (id) => (id === root.id ? root : id === child.id ? child : undefined),
      isOwnedBy: (id, owner) => id === child.id && owner === root,
    },
    on: (...hook) => {
      if (hook[0] === 'tools/pre-execute') listener = hook[1];
    },
    approval: {
      request: async (input) => {
        expect(input.agent).toBe(child);
        throw new Error('An authorized task URL must not request native approval');
      },
    },
  };
  const request = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sessions.push(body.params.sessionId);
    if (body.params.sessionId !== root.session.id)
      return Response.json({ error: { code: 'INVALID_INTERACTION' } });
    return Response.json({
      result:
        body.method === 'approval.web.check'
          ? { current: true }
          : {
              effect: 'allow',
              source: 'risk',
              reasonCode: 'baselineAllowed',
              matchedRules: [],
              policyRevision: 0,
              requestHash: approvalHash([scope, 'interactive', selector]),
              scope,
              trigger: 'interactive',
              selector,
            },
    });
  };
  apply(
    context,
    {
      limit: 10,
      urls: [selector.url],
      url: 'http://127.0.0.1/mcp/mock-bot',
      capability: 'synthetic-capability',
    },
    request,
  );
  await listener(
    {
      signal: new AbortController().signal,
      name: 'web_fetch',
      arguments: { url: selector.url },
      agent: child,
    },
    async () => {
      effects++;
      return { kind: 'allow' };
    },
  );
  expect(effects).toBe(1);
  expect(sessions).toEqual([root.session.id, root.session.id, root.session.id]);
});

test.each([
  'foreign',
  'lookalike',
  'removed-after-approval',
  'root-replaced-after-check',
  'native-never',
] as const)('web rules refuse an unowned or stale agent (%s)', async (scenario) => {
  let listener: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; agent?: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const root = { id: 'mock-root', session: { id: 'mock-root-session' } };
  const child = { id: 'mock-child', session: { id: 'mock-child-session' } };
  const foreign = { id: 'mock-foreign', session: root.session, root };
  const registered = new Map([
    [root.id, root],
    [child.id, child],
    [foreign.id, foreign],
  ]);
  let currentRoot = root;
  let effects = 0;
  const methods: string[] = [];
  const selector = { kind: 'url' as const, url: 'https://example.test/mock-read' };
  const scope = { kind: 'bot' as const, bot: 'mock-bot' };
  const context: Parameters<typeof apply>[0] = {
    agents: {
      roots: () => [currentRoot],
      get: (id) => registered.get(id),
      isOwnedBy: (id, owner) => id === child.id && owner === root,
    },
    on: (...hook) => {
      if (hook[0] === 'tools/pre-execute') listener = hook[1];
    },
    approval: {
      request: async (input) => {
        expect(input.agent).toBe(child);
        if (scenario === 'native-never') return 'rejected';
        if (scenario === 'removed-after-approval') registered.delete(child.id);
        return 'allowed-once';
      },
    },
  };
  const request = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    methods.push(body.method);
    if (body.method === 'approval.web.check') {
      if (scenario === 'root-replaced-after-check')
        currentRoot = { id: 'mock-next-root', session: { id: 'mock-next-session' } };
      return Response.json({ result: { current: true } });
    }
    return Response.json({
      result: {
        effect: 'ask',
        source: 'rule',
        reasonCode: 'ruleAsked',
        matchedRules: [],
        policyRevision: 0,
        requestHash: approvalHash([scope, 'interactive', selector]),
        scope,
        trigger: 'interactive',
        selector,
      },
    });
  };
  apply(
    context,
    {
      limit: 10,
      urls: [selector.url],
      url: 'http://127.0.0.1/mcp/mock-bot',
      capability: 'synthetic-capability',
    },
    request,
  );
  const agent =
    scenario === 'foreign'
      ? foreign
      : scenario === 'lookalike'
        ? { ...child, session: root.session }
        : child;
  expect(
    await listener(
      {
        signal: new AbortController().signal,
        name: 'web_fetch',
        arguments: { url: selector.url },
        agent,
      },
      async () => {
        effects++;
        return { kind: 'allow' };
      },
    ),
  ).toMatchObject({ kind: 'deny' });
  expect(effects).toBe(0);
  expect(methods).toEqual(
    scenario === 'foreign' || scenario === 'lookalike'
      ? []
      : scenario === 'root-replaced-after-check'
        ? ['approval.web', 'approval.web.check']
        : ['approval.web'],
  );
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
    expect((result as { kind: string }).kind).toBe('deny');
  }
  await listener(
    { signal: new AbortController().signal, name: 'computer__bot_schedule_list', arguments: {} },
    next,
  );
  expect(bodies).toBe(1);
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
  expect(await listener(exec, next)).toStrictEqual({
    kind: 'deny',
    reason: 'TOOL_LIMIT',
    info: { name: 'ToolLimitError', code: 'TOOL_LIMIT' },
  });
  expect(bodies).toBe(2);
  const aborted = new AbortController();
  aborted.abort();
  expect(await listener({ ...exec, signal: aborted.signal }, next)).toStrictEqual({
    kind: 'cancel',
  });
  expect(bodies).toBe(2);
  expect(() => apply({ on: () => undefined }, { limit: 0, urls: [] })).toThrowError(
    /INVALID_TOOL_LIMIT/,
  );
});

test('web policy allows only exact URLs supplied in this user request, not page-chosen destinations or queries', async () => {
  const urls = requestedUrls(
    '读取 [合成来源](https://example.test/page#intro)，再看 https://docs.example.test/。',
  );
  expect(urls).toStrictEqual(['https://example.test/page', 'https://docs.example.test/']);
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
  expect(await listener(exec, next)).toStrictEqual({ kind: 'allow' });
  for (const url of [
    'https://example.test/page?data=synthetic-private',
    'https://untrusted.test/',
    'https://mock:secret@example.test/page',
  ]) {
    expect(await listener({ ...exec, arguments: { url } }, next)).toStrictEqual({
      kind: 'deny',
      reason:
        'Only fetch exact URLs provided by the user in this task. Ask the user to supply another URL.',
      info: { name: 'WebPolicyError', code: 'WEB_URL_NOT_AUTHORIZED' },
    });
  }
  expect(bodies).toBe(1);
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
  expect(requests.length, 'one grant must never become an always-allow URL rule').toBe(2);
  grant = false;
  const denied = await listener({ ...exec, callId: 'mock-call-3' }, next);
  expect((denied as { kind: string }).kind).toBe('deny');
  expect((denied as { info: { code: string } }).info.code).toBe('WEB_APPROVAL_REJECTED');
  expect((denied as { reason: string }).reason).toMatch(/user declined/i);
  expect(bodies).toBe(2);
  expect((requests[0] as { reason: string }).reason).toBe(
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
  expect((denied as { info: { code: string } }).info.code).toBe('INVALID_TASK_PLAN');
  expect(bodies).toBe(1);
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
  expect(approvals).toBe(0);
  expect(bodies).toBe(1);
  await pre(
    { ...exec, name: 'web_fetch', arguments: { url: 'https://example.test/source?x=1&data=mock' } },
    next,
  );
  expect(approvals).toBe(1);
  expect(bodies).toBe(1);
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
  expect(approvals).toBe(2);
  expect(bodies).toBe(1);
});

test('attempt policy waits for durable Host fence acknowledgement before native tools or approvals', async () => {
  const { vi } = await import('vitest');
  let release: () => unknown = () => undefined;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const order: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const value = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    expect(value).toMatchObject({
      method: 'attempt.fence',
      params: { attemptId: 'mock-attempt', sessionId: 'mock-root', kind: 'tool' },
    });
    order.push('fence');
    await gate;
    return Response.json({ result: { accepted: true } });
  };
  vi.stubGlobal('fetch', fetcher);
  let pre: (
    exec: { signal: AbortSignal; name: string; arguments: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const ctx: Parameters<typeof apply>[0] = {
    on: (...hook) => {
      if (hook[0] === 'tools/pre-execute') pre = hook[1];
    },
  };
  const config = {
    limit: 10,
    urls: [],
    url: 'http://127.0.0.1:12345/mcp/mock-bot',
    capability: 'synthetic-attempt-token',
    attemptId: 'mock-attempt',
  };
  apply(Object.assign(ctx, { agents: rootAgents('mock-root') }), config);
  let pending: Promise<unknown> | undefined;
  try {
    pending = pre(
      {
        signal: new AbortController().signal,
        name: 'todo_write',
        arguments: { todos: [{ content: 'Synthetic step', status: 'pending' }] },
      },
      async () => {
        order.push('execute');
        return { kind: 'allow' };
      },
    );
    await new Promise(setImmediate);
    expect(order).toEqual(['fence']);
    release();
    await pending;
    expect(order).toEqual(['fence', 'fence', 'execute']);
  } finally {
    release();
    await pending?.catch(() => undefined);
    vi.unstubAllGlobals();
  }
});

test('logical tool admission is shared and a refusal prevents the tool body', async () => {
  const { vi } = await import('vitest');
  const methods: string[] = [];
  let bodies = 0;
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const value = JSON.parse(String(init?.body)) as { method: string };
    methods.push(value.method);
    return Response.json(
      value.method === 'budget.tool' ? { error: { code: -1 } } : { result: { accepted: true } },
    );
  });
  let pre: (
    exec: {
      signal: AbortSignal;
      name: string;
      arguments: unknown;
      callId?: string;
      token?: symbol;
    },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  const config = {
    limit: 60,
    urls: [],
    attemptId: 'synthetic-attempt',
    url: 'http://127.0.0.1:12345/mcp/mock-bot',
    capability: 'synthetic-token',
    budget: { budgetId: 'synthetic-budget', revision: 1 },
  };
  apply(
    {
      agents: rootAgents('synthetic-root'),
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1];
      },
    },
    config,
  );
  try {
    const result = await pre(
      {
        signal: new AbortController().signal,
        name: 'todo_write',
        callId: 'synthetic-tool',
        token: Symbol('synthetic-tool-execution'),
        arguments: { todos: [{ content: 'Synthetic step', status: 'pending' }] },
      },
      async () => {
        bodies++;
        return { kind: 'allow' };
      },
    );
    expect(methods).toContain('budget.tool');
    expect(result).toMatchObject({ kind: 'deny' });
    expect(bodies).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a lost tool permit acknowledgement retries the same registry execution without charging twice', async () => {
  const { vi } = await import('vitest');
  const charged = new Set<string>();
  const ids: string[] = [];
  let first = true,
    bodies = 0;
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const value = JSON.parse(String(init?.body)) as { method: string; params: { callId: string } };
    if (value.method === 'budget.tool') {
      ids.push(value.params.callId);
      charged.add(value.params.callId);
      if (first) {
        first = false;
        throw new Error('SYNTHETIC_ACK_LOST');
      }
    }
    return Response.json({ result: { accepted: true } });
  });
  type Execution = {
    token: symbol;
    callId: string;
    signal: AbortSignal;
    name: string;
    arguments: unknown;
  };
  let pre: (exec: Execution, next: () => Promise<unknown>) => Promise<unknown> = async () =>
    undefined;
  apply(
    {
      agents: rootAgents('synthetic-root'),
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1];
      },
    },
    {
      limit: 1,
      urls: [],
      attemptId: 'synthetic-attempt',
      url: 'http://127.0.0.1:12345/mcp/mock-bot',
      capability: 'synthetic-token',
      budget: { budgetId: 'synthetic-budget', revision: 1 },
    },
  );
  const exec = Object.freeze({
    token: Symbol('synthetic-execution'),
    callId: 'synthetic-provider-id',
    signal: new AbortController().signal,
    name: 'todo_write',
    arguments: { todos: [{ content: 'SYNTHETIC STEP', status: 'completed' }] },
  });
  const next = async () => {
    bodies++;
    return { kind: 'allow' };
  };
  try {
    expect(await pre(exec, next)).toMatchObject({ kind: 'deny' });
    expect(await pre({ ...exec }, next)).toMatchObject({ kind: 'allow' });
    expect(bodies).toBe(1);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(charged.size).toBe(1);
    expect(ids[0]).not.toBe(exec.callId);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a provider call ID without the registry execution token cannot obtain a shared tool claim', async () => {
  const { vi } = await import('vitest');
  const methods: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    methods.push((JSON.parse(String(init?.body)) as { method: string }).method);
    return Response.json({ result: { accepted: true } });
  });
  let pre: (
    exec: { signal: AbortSignal; name: string; arguments: unknown; callId: string },
    next: () => Promise<unknown>,
  ) => Promise<unknown> = async () => undefined;
  apply(
    {
      agents: rootAgents('synthetic-root'),
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1];
      },
    },
    {
      limit: 2,
      urls: [],
      attemptId: 'synthetic-attempt',
      url: 'http://127.0.0.1:12345/mcp/mock-bot',
      capability: 'synthetic-token',
      budget: { budgetId: 'synthetic-budget', revision: 1 },
    },
  );
  let bodies = 0;
  try {
    expect(
      await pre(
        {
          signal: new AbortController().signal,
          name: 'computer__read_file',
          arguments: { path: 'synthetic.txt' },
          callId: 'synthetic-provider-id',
        },
        async () => {
          bodies++;
        },
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(methods).not.toContain('budget.tool');
    expect(bodies).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
