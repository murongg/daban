import { expect, test } from 'vitest';
import { apply, cacheFetch, promptCacheId } from './prompt-cache.js';

const config = {
  api: 'openai-completions' as const,
  baseURL: 'https://models.example.test/v1',
  model: 'synthetic-model',
  key: `daban-${'a'.repeat(48)}`,
};
const body = {
  model: config.model,
  messages: [
    { role: 'system', content: 'SYNTHETIC SYSTEM' },
    { role: 'user', content: 'HELLO' },
  ],
  tools: [
    { type: 'function', function: { name: 'synthetic_tool', parameters: { type: 'object' } } },
  ],
  stream: true,
};
const request = (payload: unknown = body, url = `${config.baseURL}/chat/completions`) =>
  new Request(url, {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-secret', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

test('prompt identity survives task/process changes and isolates workspaces, Bots, connections and chat boundaries', () => {
  const scope = {
    workspace: '/synthetic/workspace',
    bot: 'mock-bot',
    provider: 'mock-provider',
    model: 'synthetic-model',
    chatRevision: 0,
  };
  const key = promptCacheId(scope);
  expect(key).toMatch(/^daban-[a-f0-9]{48}$/);
  expect(key).toBe(promptCacheId(JSON.parse(JSON.stringify(scope))));
  for (const change of [
    { workspace: '/synthetic/other' },
    { bot: 'other-bot' },
    { provider: 'other-provider' },
    { model: 'other-model' },
    { chatRevision: 1 },
    { conversationId: 'mock-group' },
  ])
    expect(key).not.toBe(promptCacheId({ ...scope, ...change }));
  expect(
    promptCacheId({ ...scope, conversationId: 'mock-group', chatRevision: 0 }),
    'renewing a private chat must not change a separate group conversation',
  ).toBe(promptCacheId({ ...scope, conversationId: 'mock-group', chatRevision: 2 }));
});

test('Chat requests carry one stable identity without changing messages, tools, auth or cancellation', async () => {
  const controller = new AbortController();
  const captures: Request[] = [];
  const transport = cacheFetch(config, async (input, init) => {
    captures.push(new Request(input, init));
    return Response.json({ ok: true });
  });
  await transport(request(), { signal: controller.signal });
  await transport(request({ ...body, prompt_cache_key: 'sdk-session-that-can-change' }));
  for (const sent of captures) {
    const payload = await sent.json();
    expect(payload).toStrictEqual({ ...body, prompt_cache_key: config.key });
    expect(sent.headers.get('session_id')).toBe(config.key);
    expect(sent.headers.get('authorization')).toBe('Bearer synthetic-secret');
  }
  controller.abort();
  expect(captures[0].signal.aborted).toBe(true);
});

test('Responses keeps its native options and uses the same header/body identity', async () => {
  let captured: Request | undefined;
  const transport = cacheFetch({ ...config, api: 'openai-responses' }, async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true });
  });
  const input = { model: config.model, input: 'SYNTHETIC INPUT', store: false, stream: true };
  await transport(request(input, `${config.baseURL}/responses`));
  expect(await captured!.json()).toStrictEqual({ ...input, prompt_cache_key: config.key });
  expect(captured!.headers.get('session_id')).toBe(config.key);
});

test('rewriting a request removes its stale content length', async () => {
  let length: string | null = 'unobserved';
  const transport = cacheFetch(config, async (input, init) => {
    length = new Request(input, init).headers.get('content-length');
    return Response.json({ ok: true });
  });
  await transport(request(), {
    headers: { 'content-length': String(JSON.stringify(body).length) },
  });
  expect(length).toBe(null);
});

test('native Claude/Gemini and unrelated endpoints or models are not rewritten', async () => {
  const seen: { url: string; payload: unknown; session: string | null }[] = [];
  const upstream: typeof fetch = async (input, init) => {
    const sent = new Request(input, init);
    seen.push({
      url: sent.url,
      payload: await sent.json(),
      session: sent.headers.get('session_id'),
    });
    return Response.json({ ok: true });
  };
  for (const api of ['anthropic-messages', 'google-generative-ai'] as const)
    expect(cacheFetch({ ...config, api }, upstream)).toBe(upstream);
  const transport = cacheFetch(config, upstream);
  for (const [url, payload] of [
    ['https://other.example.test/v1/chat/completions', body],
    [`${config.baseURL}/other`, body],
    [`${config.baseURL}/chat/completions`, { ...body, model: 'other-model' }],
  ] as const) {
    await transport(request(payload, url));
    expect(seen.at(-1)!.payload).toStrictEqual(payload);
    expect(seen.at(-1)!.session).toBe(null);
  }
});

test('an explicit unsupported-cache-field rejection retries once and remembers compatibility', async () => {
  const payloads: Record<string, unknown>[] = [];
  const transport = cacheFetch(config, async (input, init) => {
    const sent = new Request(input, init);
    const payload = (await sent.json()) as Record<string, unknown>;
    payloads.push(payload);
    return 'prompt_cache_key' in payload
      ? Response.json(
          { error: { message: "Unknown parameter: 'prompt_cache_key'" } },
          { status: 400 },
        )
      : Response.json({ ok: true });
  });
  expect((await transport(request())).status).toBe(200);
  expect((await transport(request())).status).toBe(200);
  expect(payloads.length).toBe(3);
  expect(payloads[0]).toStrictEqual({ ...body, prompt_cache_key: config.key });
  expect(payloads[1]).toStrictEqual(body);
  expect(payloads[2]).toStrictEqual(body);
});

test('ordinary failures and successful streams are returned intact without an extra request', async () => {
  for (const [status, text] of [
    [400, 'Invalid model'],
    [400, 'prompt_cache_key must be a string'],
    [
      400,
      JSON.stringify({
        error: { message: 'Unknown model' },
        request: { prompt_cache_key: 'echo' },
      }),
    ],
    [401, 'Unknown parameter: prompt_cache_key'],
    [429, 'Quota exceeded'],
    [500, 'Internal error'],
    [200, 'data: {"usage":{"prompt_tokens_details":{"cached_tokens":1280}}}\n\ndata: [DONE]\n\n'],
  ] as const) {
    let calls = 0;
    const response = new Response(text, { status });
    const transport = cacheFetch(config, async () => {
      calls++;
      return response;
    });
    const result = await transport(request());
    expect(result).toBe(response);
    expect(await result.text()).toBe(text);
    expect(calls).toBe(1);
  }
});

test('the DSH transport extension restores fetch when disposed', () => {
  const original = globalThis.fetch;
  let dispose = () => {};
  try {
    apply(
      {
        on: (_event, callback) => {
          dispose = callback;
        },
      },
      config,
    );
    expect(globalThis.fetch).not.toBe(original);
    dispose();
    expect(globalThis.fetch).toBe(original);
  } finally {
    globalThis.fetch = original;
  }
});
