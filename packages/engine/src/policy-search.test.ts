import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { apply as policy } from './policy.js';
import {
  type SearchProviderConfig,
  type SearchProviderContext,
  apply as searchProvider,
} from './search-provider.js';

const config: SearchProviderConfig = {
  url: 'http://127.0.0.1:12345/mcp/mock-bot',
  capability: 'synthetic-search-capability',
  sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
  runId: 'mock-search-run',
  revision: 2,
  available: true,
};
interface Rpc {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
async function fixture(
  options: { holdFence?: boolean; holdQuery?: boolean; lostClaim?: boolean } = {},
) {
  const root = { id: 'mock-root', session: { id: 'mock-root-session' } };
  const child = { id: 'mock-child', session: { id: 'mock-child-session' } };
  const agents = {
    roots: () => [root],
    get: (id: string) => [root, child].find((agent) => agent.id === id),
    isOwnedBy: (id: string, owner: unknown) => id === child.id && owner === root,
  };
  let pre:
    | Extract<Parameters<Parameters<typeof policy>[0]['on']>, ['tools/pre-execute', unknown]>[1]
    | undefined;
  let execute: Parameters<SearchProviderContext['on']>[1] | undefined;
  let provider: Parameters<SearchProviderContext['web']['registerSearchProvider']>[0] | undefined;
  const rpcs: Rpc[] = [];
  let retire = () => {};
  let release = () => {};
  const held = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const request = async (_url: string, init: RequestInit) => {
    const rpc = JSON.parse(String(init.body)) as Rpc;
    rpcs.push(rpc);
    if (options.holdFence && rpc.method === 'attempt.fence') await held;
    if (options.holdQuery && rpc.method === 'search.query') await held;
    if (rpc.method === 'search.claim' && options.lostClaim)
      throw new Error('SYNTHETIC_CLAIM_ACK_LOST');
    return Response.json({
      id: rpc.id,
      result:
        rpc.method === 'search.query'
          ? { sources: [], truncated: false }
          : {
              accepted: true,
              ...(rpc.method === 'search.claim'
                ? {
                    searchReceipt: {
                      claimId: createHash('sha256').update(String(rpc.params.callId)).digest('hex'),
                    },
                  }
                : {}),
            },
    });
  };
  policy(
    {
      agents,
      effect: (factory) => {
        const cleanup = factory();
        retire = () => {
          cleanup();
        };
      },
      on: (...hook) => {
        if (hook[0] === 'tools/pre-execute') pre = hook[1];
      },
    },
    {
      ...config,
      attemptId: 'mock-physical-attempt',
      limit: 60,
      urls: [],
    },
    request,
  );
  await searchProvider(
    {
      agents,
      on: (_event, listener) => {
        execute = listener;
      },
      web: {
        registerSearchProvider: (value) => {
          provider = value;
        },
      },
    },
    config,
    request,
  );
  const exec = {
    token: Symbol('synthetic-search-execution'),
    name: 'web_search',
    callId: 'reused-provider-call',
    agent: child,
    arguments: { queries: ['synthetic one', 'synthetic two'] },
    signal: new AbortController().signal,
  };
  return {
    root,
    child,
    exec,
    rpcs,
    release,
    retire: () => retire(),
    pre: async (value = exec) => {
      expect.assert(pre);
      return pre(value, async () => ({ kind: 'allow' }));
    },
    query: async (value = exec, query = 'synthetic one') => {
      expect.assert(execute && provider);
      return execute(value, async () => provider!.search({ query, maxResults: 5 }));
    },
  };
}

test('search authorization is bound to its registry execution without a budget service', async () => {
  const f = await fixture();
  expect(await f.pre()).toMatchObject({ kind: 'allow' });
  expect(await f.query()).toEqual({ sources: [], truncated: false });
  expect(f.rpcs.find((rpc) => rpc.method === 'search.claim')?.params).toMatchObject({
    sessionId: f.root.session.id,
    search: { executionSessionId: f.child.session.id, queries: ['synthetic one', 'synthetic two'] },
  });
});

test('one registry token joins one pending search claim before the first fence await', async () => {
  const f = await fixture({ holdFence: true });
  const first = f.pre();
  const second = f.pre();
  f.release();
  await Promise.all([first, second]);
  const claims = f.rpcs.filter((rpc) => rpc.method === 'search.claim');
  expect(claims).toHaveLength(1);
  expect(claims[0].params).toMatchObject({
    sessionId: f.root.session.id,
    search: { executionSessionId: f.child.session.id, queries: ['synthetic one', 'synthetic two'] },
  });
});

test('a search provider consumes the exact Host receipt of its real execution', async () => {
  const f = await fixture();
  await f.pre();
  await f.query();
  const claim = f.rpcs.find((rpc) => rpc.method === 'search.claim');
  expect.assert(claim);
  const claimId = createHash('sha256').update(String(claim.params.callId)).digest('hex');
  expect(f.rpcs.find((rpc) => rpc.method === 'search.query')?.params).toEqual({
    claimId,
    query: 'synthetic one',
  });
});

test('a missing handoff cannot borrow authority from a tool call id', async () => {
  const f = await fixture();
  await expect(f.query()).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' });
  expect(f.rpcs).toHaveLength(0);
});

test('an ordinary registry token cannot be retargeted into a search handoff', async () => {
  const f = await fixture();
  await f.pre({ ...f.exec, name: 'synthetic_read' });
  expect(await f.pre()).toMatchObject({ kind: 'deny' });
  await expect(f.query()).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' });
});

test('a prepared search token cannot authorize a different tool on a repeated pre-execute', async () => {
  const f = await fixture();
  await f.pre();
  expect(await f.pre({ ...f.exec, name: 'synthetic_write' })).toMatchObject({ kind: 'deny' });
});

test('a lost search claim acknowledgement remains denied without another claim or UUID', async () => {
  const f = await fixture({ lostClaim: true });
  expect(await f.pre()).toMatchObject({ kind: 'deny' });
  expect(await f.pre()).toMatchObject({ kind: 'deny' });
  await expect(f.query()).rejects.toBeDefined();
  expect(f.rpcs.filter((rpc) => rpc.method === 'search.claim')).toHaveLength(1);
  expect(f.rpcs.some((rpc) => rpc.method === 'search.query')).toBe(false);
});

test('reused provider ids with different registry tokens keep distinct claims', async () => {
  const f = await fixture();
  const second = { ...f.exec, token: Symbol('synthetic-second-search') };
  await Promise.all([f.pre(), f.pre(second)]);
  await Promise.all([f.query(), f.query(second)]);
  expect(
    new Set(f.rpcs.filter((rpc) => rpc.method === 'search.claim').map((rpc) => rpc.params.callId))
      .size,
  ).toBe(2);
  expect(
    new Set(f.rpcs.filter((rpc) => rpc.method === 'search.query').map((rpc) => rpc.params.claimId))
      .size,
  ).toBe(2);
});

test('the handoff cannot be retargeted by changed query arguments or an impostor child', async () => {
  const f = await fixture();
  await f.pre();
  await expect(
    f.query({ ...f.exec, arguments: { queries: ['synthetic changed'] } }, 'synthetic changed'),
  ).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' });
  await expect(f.query({ ...f.exec, agent: { ...f.child } })).rejects.toMatchObject({
    code: 'SEARCH_INVALID_QUERY',
  });
  expect(f.rpcs.some((rpc) => rpc.method === 'search.query')).toBe(false);
});

test('a disposed policy handoff cannot publish an otherwise successful late bridge result', async () => {
  const f = await fixture({ holdQuery: true });
  await f.pre();
  const pending = f.query();
  while (!f.rpcs.some((rpc) => rpc.method === 'search.query')) await new Promise(setImmediate);
  f.retire();
  f.release();
  await expect(pending).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' });
});
