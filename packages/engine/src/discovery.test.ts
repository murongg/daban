import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelSettings } from './settings.js';

const endpoint = {
  id: 'mock-provider',
  baseURL: 'https://models.example.test/v1',
  api: 'openai-completions',
};
const query = { kind: 'list', revision: 0, connection: endpoint, apiKey: 'synthetic-provider-key' };
async function inspect(settings: ModelSettings, input: unknown): Promise<unknown> {
  return settings.inspect(input);
}
async function fixture(run: (root: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-discovery-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('matches a shared context limit even when providers differ in output limits', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) =>
      Response.json(
        String(url).startsWith(endpoint.baseURL)
          ? { data: [{ id: 'mock-alpha' }] }
          : {
              one: { models: { 'mock-alpha': { limit: { context: 64000, output: 4096 } } } },
              two: { models: { 'mock-alpha': { limit: { context: 64000, output: 8192 } } } },
            },
      ),
    );
    assert.deepEqual(await inspect(settings, { ...query, kind: 'limits', model: 'mock-alpha' }), {
      kind: 'limits',
      revision: 0,
      model: { id: 'mock-alpha', name: 'mock-alpha', contextWindow: 64000, source: 'models.dev' },
    });
  }));
test('rejects incomplete pagination instead of presenting a partial list as complete', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'mock-alpha' }], has_more: true }),
    );
    await assert.rejects(inspect(settings, query), { code: 'MODEL_DISCOVERY_LIMIT' });
  }));
test('never returns a provider credential echoed in model metadata', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'mock-alpha', name: query.apiKey }] }),
    );
    await assert.rejects(inspect(settings, query), { code: 'MODEL_API_INVALID_RESPONSE' });
  }));
test('rejects escaped credentials in metadata and accepts a valid long model ID with a bounded label', async () =>
  fixture(async (root) => {
    const key = 'synthetic-"quoted\\key';
    let label = key;
    const id = `mock-${'a'.repeat(145)}`;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id, ...(label ? { name: label } : {}) }] }),
    );
    await assert.rejects(inspect(settings, { ...query, apiKey: key }), {
      code: 'MODEL_API_INVALID_RESPONSE',
    });
    label = '';
    assert.deepEqual(await inspect(settings, query), {
      kind: 'list',
      revision: 0,
      models: [{ id, name: id.slice(0, 120) }],
    });
  }));
test('lists available models without saving credentials and returns only bounded public metadata', async () =>
  fixture(async (root) => {
    let request: RequestInit | undefined;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      assert.equal(String(url), `${endpoint.baseURL}/models`);
      request = init;
      return Response.json({
        data: [
          {
            id: 'mock-alpha',
            name: 'Mock Alpha',
            context_length: 64000,
            top_provider: { max_completion_tokens: 4096 },
            apiKey: 'synthetic-must-not-return',
          },
          { id: 'mock-alpha' },
        ],
      });
    });
    assert.deepEqual(await inspect(settings, query), {
      kind: 'list',
      revision: 0,
      models: [
        {
          id: 'mock-alpha',
          name: 'Mock Alpha',
          contextWindow: 64000,
          maxTokens: 4096,
          source: 'provider',
        },
      ],
    });
    assert.equal(
      new Headers(request?.headers).get('authorization'),
      'Bearer synthetic-provider-key',
    );
    assert.equal(request?.redirect, 'error');
    await assert.rejects(readFile(settings.file), { code: 'ENOENT' });
  }));
test('reads paginated Gemini generation models and their reported token limits', async () =>
  fixture(async (root) => {
    const calls: string[] = [];
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), query.apiKey);
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return Response.json(
        calls.length === 1
          ? {
              models: [
                {
                  name: 'models/mock-alpha',
                  displayName: 'Mock Alpha',
                  inputTokenLimit: 64000,
                  outputTokenLimit: 4096,
                  supportedGenerationMethods: ['generateContent'],
                },
                { name: 'models/mock-embed', supportedGenerationMethods: ['embedContent'] },
              ],
              nextPageToken: 'mock-next',
            }
          : {
              models: [
                { name: 'models/mock-beta', supportedGenerationMethods: ['generateContent'] },
              ],
            },
      );
    });
    const result = await inspect(settings, {
      ...query,
      connection: {
        ...endpoint,
        baseURL: 'https://gemini.example.test/v1beta',
        api: 'google-generative-ai',
      },
    });
    assert.deepEqual(result, {
      kind: 'list',
      revision: 0,
      models: [
        {
          id: 'mock-alpha',
          name: 'Mock Alpha',
          contextWindow: 64000,
          maxTokens: 4096,
          source: 'provider',
        },
        { id: 'mock-beta', name: 'mock-beta' },
      ],
    });
    assert.match(calls[1], /pageToken=mock-next/);
  }));
test('reads native Claude limits with its API headers and follows the exact model ID', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      assert.equal(String(url), 'https://claude.example.test/v1/models/mock-alpha');
      assert.equal(new Headers(init?.headers).get('x-api-key'), query.apiKey);
      assert.equal(new Headers(init?.headers).get('anthropic-version'), '2023-06-01');
      return Response.json({
        id: 'mock-alpha',
        display_name: 'Mock Alpha',
        max_input_tokens: 200000,
        max_tokens: 64000,
      });
    });
    assert.deepEqual(
      await inspect(settings, {
        ...query,
        kind: 'limits',
        model: 'mock-alpha',
        connection: {
          ...endpoint,
          baseURL: 'https://claude.example.test',
          api: 'anthropic-messages',
        },
      }),
      {
        kind: 'limits',
        revision: 0,
        model: {
          id: 'mock-alpha',
          name: 'Mock Alpha',
          contextWindow: 200000,
          maxTokens: 64000,
          source: 'provider',
        },
      },
    );
  }));
test('uses exact unambiguous public catalog limits without forwarding any provider credential', async () =>
  fixture(async (root) => {
    let registryCalls = 0;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      if (String(url).startsWith(endpoint.baseURL))
        return Response.json({ data: [{ id: 'mock-alpha' }] });
      assert.equal(String(url), 'https://models.dev/api.json');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      assert.equal(new Headers(init?.headers).get('x-api-key'), null);
      registryCalls++;
      return Response.json({
        mock: {
          api: endpoint.baseURL,
          models: {
            'mock-alpha': { limit: { context: 96000, output: 8192 } },
            'mock-alpha-long': { limit: { context: 200000, output: 16384 } },
          },
        },
      });
    });
    const input = { ...query, kind: 'limits', model: 'mock-alpha' };
    assert.deepEqual(await inspect(settings, input), {
      kind: 'limits',
      revision: 0,
      model: {
        id: 'mock-alpha',
        name: 'mock-alpha',
        contextWindow: 96000,
        maxTokens: 8192,
        source: 'models.dev',
      },
    });
    await inspect(settings, input);
    assert.equal(registryCalls, 1);
  }));
test('keeps limits unknown when public metadata is ambiguous or unavailable', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) =>
      Response.json(
        String(url).startsWith(endpoint.baseURL)
          ? { data: [{ id: 'mock-alpha' }] }
          : {
              one: { models: { 'mock-alpha': { limit: { context: 64000 } } } },
              two: { models: { 'mock-alpha': { limit: { context: 96000 } } } },
            },
      ),
    );
    assert.deepEqual(await inspect(settings, { ...query, kind: 'limits', model: 'mock-alpha' }), {
      kind: 'limits',
      revision: 0,
      model: { id: 'mock-alpha', name: 'mock-alpha' },
    });
  }));
test('sends a real fixed-prompt test rather than treating a models-list entry as a working model', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      assert.equal(String(url), `${endpoint.baseURL}/chat/completions`);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'mock-alpha');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply OK.' }]);
      assert.equal(body.max_tokens, 64);
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      });
    });
    const result = await inspect(settings, { ...query, kind: 'test', model: 'mock-alpha' });
    assert.ok(result && typeof result === 'object');
    assert.equal(Reflect.get(result, 'kind'), 'test');
    assert.equal(Reflect.get(result, 'model'), 'mock-alpha');
    assert.ok(Number.isFinite(Reflect.get(result, 'latencyMs')));
    assert.equal(JSON.stringify(result).includes(query.apiKey), false);
    await assert.rejects(readFile(settings.file), { code: 'ENOENT' });
  }));
test('reuses a saved key only at the same connection, destination, protocol and revision', async () =>
  fixture(async (root) => {
    let calls = 0;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
      calls++;
      return Response.json({ data: [{ id: 'mock-alpha' }] });
    });
    await settings.configure({
      model: 'provider:mock-provider:mock-alpha',
      connection: {
        ...endpoint,
        name: 'Mock Provider',
        models: [
          {
            id: 'mock-alpha',
            name: 'Mock Alpha',
            vision: false,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
      apiKey: query.apiKey,
      revision: 0,
      requestId: 'mock-save',
    });
    const before = await readFile(settings.file);
    const { apiKey: _key, ...savedQuery } = query;
    await inspect(settings, { ...savedQuery, revision: 1 });
    for (const connection of [
      { ...endpoint, baseURL: 'https://other.example.test/v1' },
      { ...endpoint, api: 'openai-responses' },
      { ...endpoint, id: 'mock-other' },
    ])
      await assert.rejects(inspect(settings, { ...savedQuery, revision: 1, connection }), {
        code: 'MODEL_CREDENTIAL_REQUIRED',
      });
    await assert.rejects(inspect(settings, { ...savedQuery, revision: 0 }), {
      code: 'MODEL_SETTINGS_CONFLICT',
    });
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(settings.file), before);
  }));
test('rejects invalid inputs before network IO and returns sanitized upstream failures', async () =>
  fixture(async (root) => {
    let calls = 0;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
      calls++;
      return new Response('synthetic-private-detail', { status: 401 });
    });
    for (const input of [
      { ...query, kind: 'shell' },
      { ...query, model: '../bad' },
      { ...query, revision: -1 },
      { ...query, apiKey: 'bad\nsecret' },
      { ...query, connection: { ...endpoint, baseURL: 'https://example.test/?key=bad' } },
      { ...query, extra: true },
    ])
      await assert.rejects(inspect(settings, input), { code: 'INVALID_MODEL_SETTINGS' });
    assert.equal(calls, 0);
    await assert.rejects(inspect(settings, query), { code: 'MODEL_API_UNAUTHORIZED' });
  }));
test('does not turn discovery into paid inference when a list route is unsupported', async () =>
  fixture(async (root) => {
    let calls = 0;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
      calls++;
      return new Response(null, { status: 404 });
    });
    await assert.rejects(inspect(settings, query), { code: 'MODEL_DISCOVERY_UNAVAILABLE' });
    assert.equal(calls, 1);
  }));
