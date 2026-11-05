import type { ModelApi, TokenUsage } from '@daban/protocol';
import { expect, test } from 'vitest';
import { cacheFetch } from './prompt-cache.js';

type Meter = {
  api: ModelApi;
  begin: (request: Request) => Promise<string | undefined>;
  report: (id: string, usage: TokenUsage) => Promise<unknown>;
};
async function wrap(meter: Meter, upstream: typeof fetch) {
  const module = (await import(new URL('./usage.js', import.meta.url).href)) as {
    usageFetch: (meter: Meter, upstream: typeof fetch) => typeof fetch;
  };
  return module.usageFetch(meter, upstream);
}
const endpoint = 'https://models.example.test/v1/chat/completions';
const input = () =>
  new Request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'synthetic-model', stream: true, messages: [] }),
  });
const sse = (usage = true) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'synthetic' }, finish_reason: 'stop' }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } : {}) })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
test('wire send waits for admission and settles only after a complete raw stream', async () => {
  const order: string[] = [],
    receipts: TokenUsage[] = [];
  const fetcher = await wrap(
    {
      api: 'openai-completions',
      begin: async () => {
        order.push('permit');
        return 'synthetic-attempt';
      },
      report: async (_id, usage) => {
        receipts.push(usage);
      },
    },
    async () => {
      order.push('send');
      return sse();
    },
  );
  const response = await fetcher(input());
  expect(receipts).toEqual([]);
  expect(await response.text()).toContain('synthetic');
  expect(order).toEqual(['permit', 'send']);
  expect(receipts).toEqual([
    {
      state: 'reported',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
});
test('cache downgrade and transport retry each acquire their own send permit', async () => {
  let permits = 0,
    sends = 0;
  const receipts: TokenUsage[] = [];
  const metered = await wrap(
    {
      api: 'openai-completions',
      begin: async () => `synthetic-${++permits}`,
      report: async (_id, usage) => {
        receipts.push(usage);
      },
    },
    async () =>
      ++sends === 1
        ? Response.json({ error: { message: 'unknown prompt_cache_key' } }, { status: 400 })
        : sse(),
  );
  const cached = cacheFetch(
    {
      api: 'openai-completions',
      baseURL: 'https://models.example.test/v1',
      model: 'synthetic-model',
      key: `daban-${'a'.repeat(48)}`,
    },
    metered,
  );
  await (await cached(input())).text();
  expect(sends).toBe(2);
  expect(permits).toBe(2);
  expect(receipts).toHaveLength(2);
  expect(receipts[0]).toMatchObject({ state: 'unknown' });
  expect(receipts[1]).toMatchObject({ state: 'reported' });
});
test('denied or unreachable admission sends nothing', async () => {
  let sends = 0;
  const fetcher = await wrap(
    {
      api: 'openai-completions',
      begin: async () => {
        throw new Error('BUDGET_LIMIT_REACHED');
      },
      report: async () => {},
    },
    async () => {
      sends++;
      return sse();
    },
  );
  await expect(fetcher(input())).rejects.toThrow('BUDGET_LIMIT_REACHED');
  expect(sends).toBe(0);
});
test.each(['missing', 'truncated', 'cancelled', 'network'])(
  'unknown wire result retains an explicit reason (%s)',
  async (scenario) => {
    const receipts: TokenUsage[] = [];
    const fetcher = await wrap(
      {
        api: 'openai-completions',
        begin: async () => 'synthetic-attempt',
        report: async (_id, usage) => {
          receipts.push(usage);
        },
      },
      async () => {
        if (scenario === 'network') throw new Error('SYNTHETIC_NETWORK_FAILURE');
        if (scenario === 'truncated')
          return new Response('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        return sse(false);
      },
    );
    if (scenario === 'network')
      await expect(fetcher(input())).rejects.toThrow('SYNTHETIC_NETWORK_FAILURE');
    else {
      const response = await fetcher(input());
      if (scenario === 'cancelled') await response.body?.cancel();
      else await response.text();
    }
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: 'unknown' });
  },
);

test('non-stream Risk usage is read from a complete provider response', async () => {
  const receipts: TokenUsage[] = [];
  const fetcher = await wrap(
    {
      api: 'openai-completions',
      begin: async () => 'synthetic-review',
      report: async (_id, usage) => {
        receipts.push(usage);
      },
    },
    async () =>
      Response.json({
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      }),
  );
  await (await fetcher(input())).json();
  expect(receipts).toEqual([
    {
      state: 'reported',
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
});

test('SDK consumer cancellation after a complete terminal provider frame still settles its explicit usage', async () => {
  const receipts: TokenUsage[] = [];
  const fetcher = await wrap(
    {
      api: 'openai-completions',
      begin: async () => 'synthetic-complete',
      report: async (_id, usage) => {
        receipts.push(usage);
      },
    },
    async () => sse(),
  );
  const response = await fetcher(input());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(receipts[0]).toMatchObject({ state: 'reported', inputTokens: 10, outputTokens: 2 });
});

test('metered provider requests cannot hide extra physical sends behind HTTP redirects', async () => {
  let redirect: RequestRedirect | undefined;
  const fetcher = await wrap(
    { api: 'openai-completions', begin: async () => 'synthetic-attempt', report: async () => {} },
    async (input, init) => {
      redirect = new Request(input, init).redirect;
      return sse();
    },
  );
  await (await fetcher(input())).text();
  expect(redirect).toBe('error');
});
