import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { apply, type SearchProviderConfig, type SearchProviderContext } from './search-provider.js';

const config: SearchProviderConfig = {
  url: 'http://127.0.0.1:12345/mcp/mock-bot',
  capability: 'synthetic-capability',
  sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
  runId: 'mock-run',
  revision: 3,
  available: true,
};
function fixture() {
  const root = { id: 'mock-agent', session: { id: 'mock-session' } };
  let provider: Parameters<SearchProviderContext['web']['registerSearchProvider']>[0] | undefined;
  let execute: Parameters<SearchProviderContext['on']>[1] | undefined;
  const ctx: SearchProviderContext = {
    web: {
      registerSearchProvider(value) {
        provider = value;
      },
    },
    agents: {
      roots: () => [root],
      get: (id) => (id === root.id ? root : undefined),
      isOwnedBy: () => false,
    },
    on(_event, listener) {
      execute = listener;
    },
  };
  const exec = {
    name: 'web_search',
    callId: 'mock-call',
    agent: root,
    arguments: { queries: ['synthetic one', 'synthetic two'] },
    signal: new AbortController().signal,
  };
  return {
    ctx,
    exec,
    get provider() {
      expect.assert(provider);
      return provider;
    },
    get execute() {
      expect.assert(execute);
      return execute;
    },
  };
}
test('the provider uses the actual tool context and capability bridge without supplier credentials', async () => {
  const f = fixture();
  const received: Record<string, unknown>[] = [];
  await apply(f.ctx, config, async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-capability');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    received.push(body);
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: { sources: [{ url: 'https://example.test/source?q=one' }], truncated: false },
    });
  });
  expect(f.provider.available()).toBe(true);
  const result = await f.execute(f.exec, async () =>
    f.provider.search({ query: 'synthetic one', maxResults: 5 }, f.exec.signal),
  );
  expect(result).toEqual({
    sources: [{ url: 'https://example.test/source?q=one' }],
    truncated: false,
  });
  expect(received[0]).toMatchObject({
    method: 'search.query',
    params: {
      runId: 'mock-run',
      sessionId: 'mock-session',
      executionSessionId: 'mock-session',
      callId: 'mock-call',
      searchRevision: 3,
      queries: ['synthetic one', 'synthetic two'],
      query: 'synthetic one',
      maxResults: 5,
    },
  });
  await expect(f.provider.search({ query: 'synthetic one' })).rejects.toMatchObject({
    code: 'SEARCH_INVALID_QUERY',
  });
});
test('parallel tool executions retain their own invocation identity', async () => {
  const f = fixture();
  const calls: string[] = [];
  await apply(f.ctx, config, async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      id: string;
      params: { callId: string; query: string };
    };
    calls.push(`${body.params.callId}:${body.params.query}`);
    return Response.json({ id: body.id, result: { sources: [], truncated: false } });
  });
  await Promise.all(
    ['one', 'two'].map((value) =>
      f.execute({ ...f.exec, callId: value, arguments: { queries: [value] } }, async () => {
        await new Promise<unknown>((resolve) => setTimeout(resolve, value === 'one' ? 3 : 1));
        return f.provider.search({ query: value });
      }),
    ),
  );
  expect(calls.sort()).toEqual(['one:one', 'two:two']);
});
test('stable Host errors survive the bridge but unknown responses and cancelled results grant nothing', async () => {
  const f = fixture();
  let result: unknown = { error: { code: -32000, message: 'SEARCH_CONFIG_CHANGED' } };
  await apply(f.ctx, config, async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { id: string };
    return Response.json({ id: body.id, ...(result as object) });
  });
  const search = () => f.execute(f.exec, async () => f.provider.search({ query: 'synthetic one' }));
  await expect(search()).rejects.toMatchObject({ code: 'SEARCH_CONFIG_CHANGED' });
  result = { error: { message: 'synthetic-secret-reflection' } };
  await expect(search()).rejects.toThrow('SEARCH_UNAVAILABLE');
  result = { result: { sources: [], truncated: false, key: 'synthetic-secret' } };
  await expect(search()).rejects.toThrow('SEARCH_INVALID_RESPONSE');
});
test('a locally disabled provider never performs a capability or supplier probe', async () => {
  const f = fixture();
  await apply(f.ctx, { ...config, available: false }, async () => {
    throw new Error('Unexpected network');
  });
  expect(f.provider.available()).toBe(false);
  await expect(
    f.execute(f.exec, async () => f.provider.search({ query: 'synthetic one' })),
  ).rejects.toMatchObject({ code: 'SEARCH_DISABLED' });
});
