import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isModelDefinition, isModelInspection } from '@daban/protocol';
import { expect, test } from 'vitest';
import { ModelSettings } from './settings.js';

const endpoint = {
  id: 'mock-provider',
  baseURL: 'https://models.example.test/v1',
  api: 'openai-completions',
};
const query = { kind: 'list', revision: 0, connection: endpoint, apiKey: 'synthetic-provider-key' };
test('bounds merged output limits to a smaller provider context', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) =>
      Response.json(
        String(url).startsWith(endpoint.baseURL)
          ? { data: [{ id: 'mock-alpha', context_length: 4096 }] }
          : {
              mock: {
                api: endpoint.baseURL,
                models: { 'mock-alpha': { limit: { context: 96000, output: 8192 } } },
              },
            },
      ),
    );
    const result = await settings.inspect({ ...query, kind: 'limits', model: 'mock-alpha' });
    expect(isModelInspection(result)).toBe(true);
    expect(result.kind === 'limits' ? result.model.maxTokens : undefined).toBe(4096);
  }));
test('persists optional capability declarations without overriding an explicit image setting', async () =>
  fixture(async (root) => {
    const file = path.join(root, 'credentials.json');
    const settings = new ModelSettings(file, async () =>
      Response.json({ data: [{ id: 'mock-alpha' }] }),
    );
    const model = {
      id: 'mock-alpha',
      name: 'Mock Alpha',
      contextWindow: 64000,
      maxTokens: 8192,
      vision: true,
      capabilities: { input: ['text'], toolCall: false, temperature: false },
    };
    expect(isModelDefinition(model)).toBe(true);
    for (const capabilities of [
      { input: ['bad'] },
      { input: ['text', 'text'] },
      { toolCall: 'true' },
      { extra: true },
      {},
    ])
      expect(isModelDefinition({ ...model, capabilities })).toBe(false);
    await settings.configure({
      revision: 0,
      requestId: 'mock-capability-save',
      model: `provider:${endpoint.id}:mock-alpha`,
      apiKey: query.apiKey,
      connection: { ...endpoint, name: 'Mock Provider', models: [model] },
    });
    expect((await new ModelSettings(file).status(true)).connections?.[0].models[0]).toStrictEqual(
      model,
    );
    expect((await settings.resolve()).vision).toBe(true);
  }));
test('matches catalog capabilities without credentials or a provider request and keeps false distinct from unknown', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      expect(String(url)).toBe('https://models.dev/api.json');
      expect(new Headers(init?.headers).get('authorization')).toBe(null);
      return Response.json({
        mock: {
          api: endpoint.baseURL,
          models: {
            'mock-alpha': {
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
              reasoning: true,
              tool_call: false,
              temperature: false,
              limit: { context: 96000, output: 8192 },
            },
          },
        },
      });
    });
    expect(
      await inspect(settings, {
        kind: 'metadata',
        revision: 0,
        connection: endpoint,
        model: 'mock-alpha',
      }),
    ).toStrictEqual({
      kind: 'metadata',
      revision: 0,
      model: {
        id: 'mock-alpha',
        name: 'mock-alpha',
        contextWindow: 96000,
        maxTokens: 8192,
        source: 'models.dev',
        capabilities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
          reasoning: true,
          toolCall: false,
          temperature: false,
        },
      },
    });
    await expect(readFile(path.join(root, 'credentials.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }));
test('keeps consensus capabilities when gateway limits conflict and omits conflicting declarations', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({
        one: {
          models: {
            'mock-alpha': {
              limit: { context: 64000 },
              modalities: { input: ['image', 'text'] },
              reasoning: true,
              tool_call: true,
            },
          },
        },
        two: {
          models: {
            'mock-alpha': {
              limit: { context: 96000 },
              modalities: { input: ['text', 'image'] },
              reasoning: false,
              tool_call: true,
            },
          },
        },
      }),
    );
    expect(
      await inspect(settings, {
        kind: 'metadata',
        revision: 0,
        connection: endpoint,
        model: 'mock-alpha',
      }),
    ).toStrictEqual({
      kind: 'metadata',
      revision: 0,
      model: {
        id: 'mock-alpha',
        name: 'mock-alpha',
        source: 'models.dev',
        capabilities: { input: ['text', 'image'], toolCall: true },
      },
    });
  }));
test('merges capabilities with provider limits and prefers the exact catalog endpoint', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) =>
      Response.json(
        String(url).startsWith(endpoint.baseURL)
          ? { data: [{ id: 'mock-alpha', context_length: 32000 }] }
          : {
              exact: {
                api: endpoint.baseURL,
                models: {
                  'mock-alpha': {
                    limit: { context: 96000 },
                    modalities: { input: ['text'] },
                    tool_call: true,
                  },
                },
              },
              other: {
                api: 'https://other.example.test/v1',
                models: {
                  'mock-alpha': {
                    limit: { context: 128000 },
                    modalities: { input: ['text', 'image'] },
                    tool_call: false,
                  },
                },
              },
            },
      ),
    );
    expect(
      await inspect(settings, { ...query, kind: 'limits', model: 'mock-alpha' }),
    ).toStrictEqual({
      kind: 'limits',
      revision: 0,
      model: {
        id: 'mock-alpha',
        name: 'mock-alpha',
        contextWindow: 32000,
        source: 'provider',
        capabilities: { input: ['text'], toolCall: true },
      },
    });
  }));
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
    expect(
      await inspect(settings, { ...query, kind: 'limits', model: 'mock-alpha' }),
    ).toStrictEqual({
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
    await expect(inspect(settings, query)).rejects.toMatchObject({ code: 'MODEL_DISCOVERY_LIMIT' });
  }));
test('never returns a provider credential echoed in model metadata', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'mock-alpha', name: query.apiKey }] }),
    );
    await expect(inspect(settings, query)).rejects.toMatchObject({
      code: 'MODEL_API_INVALID_RESPONSE',
    });
  }));
test('rejects escaped credentials in metadata and accepts a valid long model ID with a bounded label', async () =>
  fixture(async (root) => {
    const key = 'synthetic-"quoted\\key';
    let label = key;
    const id = `mock-${'a'.repeat(145)}`;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id, ...(label ? { name: label } : {}) }] }),
    );
    await expect(inspect(settings, { ...query, apiKey: key })).rejects.toMatchObject({
      code: 'MODEL_API_INVALID_RESPONSE',
    });
    label = '';
    expect(await inspect(settings, query)).toStrictEqual({
      kind: 'list',
      revision: 0,
      models: [{ id, name: id.slice(0, 120) }],
    });
  }));
test('lists available models without saving credentials and returns only bounded public metadata', async () =>
  fixture(async (root) => {
    let request: RequestInit | undefined;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      expect(String(url)).toBe(`${endpoint.baseURL}/models`);
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
    expect(await inspect(settings, query)).toStrictEqual({
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
    expect(new Headers(request?.headers).get('authorization')).toBe(
      'Bearer synthetic-provider-key',
    );
    expect(request?.redirect).toBe('error');
    await expect(readFile(settings.file)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
test('reads paginated Gemini generation models and their reported token limits', async () =>
  fixture(async (root) => {
    const calls: string[] = [];
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(query.apiKey);
      expect(new Headers(init?.headers).get('authorization')).toBe(null);
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
    expect(result).toStrictEqual({
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
    expect(calls[1]).toMatch(/pageToken=mock-next/);
  }));
test('reads native Claude limits with its API headers and follows the exact model ID', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      expect(String(url)).toBe('https://claude.example.test/v1/models/mock-alpha');
      expect(new Headers(init?.headers).get('x-api-key')).toBe(query.apiKey);
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
      return Response.json({
        id: 'mock-alpha',
        display_name: 'Mock Alpha',
        max_input_tokens: 200000,
        max_tokens: 64000,
      });
    });
    expect(
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
    ).toStrictEqual({
      kind: 'limits',
      revision: 0,
      model: {
        id: 'mock-alpha',
        name: 'Mock Alpha',
        contextWindow: 200000,
        maxTokens: 64000,
        source: 'provider',
      },
    });
  }));
test('uses exact unambiguous public catalog limits without forwarding any provider credential', async () =>
  fixture(async (root) => {
    let registryCalls = 0;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      if (String(url).startsWith(endpoint.baseURL))
        return Response.json({ data: [{ id: 'mock-alpha' }] });
      expect(String(url)).toBe('https://models.dev/api.json');
      expect(new Headers(init?.headers).get('authorization')).toBe(null);
      expect(new Headers(init?.headers).get('x-api-key')).toBe(null);
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
    expect(await inspect(settings, input)).toStrictEqual({
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
    expect(registryCalls).toBe(1);
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
    expect(
      await inspect(settings, { ...query, kind: 'limits', model: 'mock-alpha' }),
    ).toStrictEqual({
      kind: 'limits',
      revision: 0,
      model: { id: 'mock-alpha', name: 'mock-alpha' },
    });
  }));
test('sends a real fixed-prompt test rather than treating a models-list entry as a working model', async () =>
  fixture(async (root) => {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      expect(String(url)).toBe(`${endpoint.baseURL}/chat/completions`);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('mock-alpha');
      expect(body.messages).toStrictEqual([{ role: 'user', content: 'Reply OK.' }]);
      expect(body.max_tokens).toBe(64);
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      });
    });
    const result = await inspect(settings, { ...query, kind: 'test', model: 'mock-alpha' });
    expect.assert(result && typeof result === 'object');
    expect(Reflect.get(result, 'kind')).toBe('test');
    expect(Reflect.get(result, 'model')).toBe('mock-alpha');
    expect.assert(Number.isFinite(Reflect.get(result, 'latencyMs')));
    expect(JSON.stringify(result).includes(query.apiKey)).toBe(false);
    await expect(readFile(settings.file)).rejects.toMatchObject({ code: 'ENOENT' });
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
      await expect(
        inspect(settings, { ...savedQuery, revision: 1, connection }),
      ).rejects.toMatchObject({
        code: 'MODEL_CREDENTIAL_REQUIRED',
      });
    await expect(inspect(settings, { ...savedQuery, revision: 0 })).rejects.toMatchObject({
      code: 'MODEL_SETTINGS_CONFLICT',
    });
    expect(calls).toBe(2);
    expect(await readFile(settings.file)).toStrictEqual(before);
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
      await expect(inspect(settings, input)).rejects.toMatchObject({
        code: 'INVALID_MODEL_SETTINGS',
      });
    expect(calls).toBe(0);
    await expect(inspect(settings, query)).rejects.toMatchObject({
      code: 'MODEL_API_UNAUTHORIZED',
    });
  }));
test('does not turn discovery into paid inference when a list route is unsupported', async () =>
  fixture(async (root) => {
    let calls = 0;
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () => {
      calls++;
      return new Response(null, { status: 404 });
    });
    await expect(inspect(settings, query)).rejects.toMatchObject({
      code: 'MODEL_DISCOVERY_UNAVAILABLE',
    });
    expect(calls).toBe(1);
  }));
