import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.match(key, /^daban-[a-f0-9]{48}$/);
  assert.equal(key, promptCacheId(JSON.parse(JSON.stringify(scope))));
  for (const change of [
    { workspace: '/synthetic/other' },
    { bot: 'other-bot' },
    { provider: 'other-provider' },
    { model: 'other-model' },
    { chatRevision: 1 },
    { conversationId: 'mock-group' },
  ])
    assert.notEqual(key, promptCacheId({ ...scope, ...change }));
  assert.equal(
    promptCacheId({ ...scope, conversationId: 'mock-group', chatRevision: 0 }),
    promptCacheId({ ...scope, conversationId: 'mock-group', chatRevision: 2 }),
    'renewing a private chat must not change a separate group conversation',
  );
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
    assert.deepEqual(payload, { ...body, prompt_cache_key: config.key });
    assert.equal(sent.headers.get('session_id'), config.key);
    assert.equal(sent.headers.get('authorization'), 'Bearer synthetic-secret');
  }
  controller.abort();
  assert.equal(captures[0].signal.aborted, true);
});

test('Responses keeps its native options and uses the same header/body identity', async () => {
  let captured: Request | undefined;
  const transport = cacheFetch({ ...config, api: 'openai-responses' }, async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true });
  });
  const input = { model: config.model, input: 'SYNTHETIC INPUT', store: false, stream: true };
  await transport(request(input, `${config.baseURL}/responses`));
  assert.deepEqual(await captured!.json(), { ...input, prompt_cache_key: config.key });
  assert.equal(captured!.headers.get('session_id'), config.key);
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
  assert.equal(length, null);
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
    assert.equal(cacheFetch({ ...config, api }, upstream), upstream);
  const transport = cacheFetch(config, upstream);
  for (const [url, payload] of [
    ['https://other.example.test/v1/chat/completions', body],
    [`${config.baseURL}/other`, body],
    [`${config.baseURL}/chat/completions`, { ...body, model: 'other-model' }],
  ] as const) {
    await transport(request(payload, url));
    assert.deepEqual(seen.at(-1)!.payload, payload);
    assert.equal(seen.at(-1)!.session, null);
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
  assert.equal((await transport(request())).status, 200);
  assert.equal((await transport(request())).status, 200);
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads[0], { ...body, prompt_cache_key: config.key });
  assert.deepEqual(payloads[1], body);
  assert.deepEqual(payloads[2], body);
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
    assert.equal(result, response);
    assert.equal(await result.text(), text);
    assert.equal(calls, 1);
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
    assert.notEqual(globalThis.fetch, original);
    dispose();
    assert.equal(globalThis.fetch, original);
  } finally {
    globalThis.fetch = original;
  }
});
