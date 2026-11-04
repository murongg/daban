import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isExecutionRun,
  isModelBaseURL,
  isModelConnection,
  isModelId,
  isModelStatus,
  modelCatalog,
  modelHasVision,
  modelReference,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { ModelSettings } from './settings.js';

test('native Claude discovery uses its Messages API credential and protocol survives persistence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-claude-'));
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ type: 'model', id: 'mock-claude' });
    });
    await settings.configure({
      model: 'provider:mock-claude:mock-claude',
      apiKey: 'synthetic-claude-key',
      revision: 0,
      requestId: 'mock-native-claude',
      connection: {
        id: 'mock-claude',
        name: 'Synthetic Claude',
        baseURL: 'https://claude.example.test',
        api: 'anthropic-messages',
        models: [
          {
            id: 'mock-claude',
            name: 'Mock Claude',
            vision: true,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    });
    expect(calls[0].url).toBe('https://claude.example.test/v1/models/mock-claude');
    expect(new Headers(calls[0].init?.headers).get('x-api-key')).toBe('synthetic-claude-key');
    expect(new Headers(calls[0].init?.headers).get('anthropic-version')).toBe('2023-06-01');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(null);
    expect(Reflect.get((await settings.status(true)).connections![0], 'api')).toBe(
      'anthropic-messages',
    );
    expect(Reflect.get(await settings.resolve(), 'api')).toBe('anthropic-messages');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Gemini checks each configured model resource without query credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-gemini-'));
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url, init) => {
      calls.push({ url: String(url), init });
      const name = String(url).split('/').at(-1)!;
      return Response.json({
        name: `models/${name}`,
        supportedGenerationMethods: ['generateContent'],
      });
    });
    await settings.configure({
      model: 'provider:mock-google:models/mock-gemini',
      apiKey: 'synthetic-google-key',
      revision: 0,
      requestId: 'mock-native-google',
      connection: {
        id: 'mock-google',
        name: 'Synthetic Gemini',
        baseURL: 'https://google.example.test/v1beta',
        api: 'google-generative-ai',
        models: ['models/mock-gemini', 'mock-gemini-two'].map((id) => ({
          id,
          name: id,
          vision: true,
          contextWindow: 64000,
          maxTokens: 4096,
        })),
      },
    });
    expect(calls.map((item) => item.url)).toStrictEqual([
      'https://google.example.test/v1beta/models/mock-gemini',
      'https://google.example.test/v1beta/models/mock-gemini-two',
    ]);
    expect(calls.every((item) => !item.url.includes('synthetic-google-key'))).toBe(true);
    expect(new Headers(calls[0].init?.headers).get('x-goog-api-key')).toBe('synthetic-google-key');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(null);
    expect((await settings.resolve()).apiModel).toBe('mock-gemini');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Claude aliases are verified by resource lookup without replacing the requested alias', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-claude-alias-'));
  const calls: string[] = [];
  try {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) => {
      calls.push(String(url));
      return Response.json({ type: 'model', id: 'mock-claude-versioned' });
    });
    await settings.configure({
      model: 'provider:mock-claude:mock-claude-latest',
      apiKey: 'synthetic-claude-key',
      revision: 0,
      requestId: 'mock-native-alias',
      connection: {
        id: 'mock-claude',
        name: 'Synthetic Claude',
        api: 'anthropic-messages',
        baseURL: 'https://claude.example.test',
        models: [
          {
            id: 'mock-claude-latest',
            name: 'Mock Claude',
            vision: true,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    });
    expect(calls).toStrictEqual(['https://claude.example.test/v1/models/mock-claude-latest']);
    expect((await settings.resolve()).apiModel).toBe('mock-claude-latest');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model API selectors reject nonstring values and native Google path traversal', async () => {
  const { isModelApi, modelApi } = await import('@daban/protocol');
  expect(isModelApi({ toString: () => 'anthropic-messages' })).toBe(false);
  expect(modelApi({})).toBe('openai-completions');
  for (const id of ['../mock-model', 'models/../mock-model', 'models/one/two'])
    expect(
      isModelConnection({
        ...syntheticConnection(),
        api: 'google-generative-ai',
        models: [{ ...syntheticConnection().models[0], id }],
      }),
    ).toBe(false);
  expect(
    isModelConnection({
      ...syntheticConnection('deepseek-official', 'https://api.deepseek.com/v1'),
      api: 'anthropic-messages',
    }),
  ).toBe(false);
});

test('changing protocol requires explicit credentials and retires the prior captured model binding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-protocol-change-'));
  let calls = 0;
  try {
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async (url) => {
      calls++;
      return String(url).includes('/v1/models/')
        ? Response.json({ type: 'model', id: 'mock-model' })
        : Response.json({ data: [{ id: 'mock-model' }] });
    });
    const connection = {
      id: 'mock-protocol',
      name: 'Synthetic protocol',
      baseURL: 'https://model.example.test',
      models: [
        { id: 'mock-model', name: 'Mock', vision: true, contextWindow: 64000, maxTokens: 4096 },
      ],
    };
    const original = {
      model: 'provider:mock-protocol:mock-model',
      connection,
      apiKey: 'synthetic-original-key',
      revision: 0,
      requestId: 'mock-protocol-original',
    };
    await settings.configure(original);
    const first = await settings.resolve();
    const before = await readFile(settings.file, 'utf8');
    const next = {
      model: original.model,
      connection: { ...connection, api: 'anthropic-messages' },
      revision: 1,
      requestId: 'mock-protocol-change',
    };
    await expect(settings.configure(next)).rejects.toMatchObject({
      code: 'MODEL_CREDENTIAL_REQUIRED',
    });
    expect(calls).toBe(1);
    expect(await readFile(settings.file, 'utf8')).toBe(before);
    const input = { ...next, apiKey: 'synthetic-new-protocol-key' };
    const saved = await settings.configure(input);
    expect((await settings.resolve()).binding).not.toBe(first.binding);
    expect((await settings.resolve()).api).toBe('anthropic-messages');
    expect(await settings.configure(input)).toStrictEqual(saved);
    expect(calls).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absent native model-discovery routes probe only their native completion protocol', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-fallback-'));
  try {
    for (const [api, endpoint, reply] of [
      [
        'anthropic-messages',
        '/v1/messages',
        {
          type: 'message',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'OK' }],
        },
      ],
      [
        'google-generative-ai',
        '/models/mock-model:generateContent',
        { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }] },
      ],
      [
        'openai-responses',
        '/responses',
        {
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
          ],
        },
      ],
    ] as const) {
      const calls: { url: string; init?: RequestInit }[] = [];
      const settings = new ModelSettings(path.join(root, `${api}.json`), async (url, init) => {
        calls.push({ url: String(url), init });
        return calls.length === 1 ? new Response(null, { status: 404 }) : Response.json(reply);
      });
      const input = {
        model: 'provider:mock-native:mock-model',
        revision: 0,
        requestId: 'mock-native-fallback',
        apiKey: 'synthetic-native-key',
        connection: {
          id: 'mock-native',
          name: 'Synthetic native',
          baseURL: 'https://native.example.test',
          api,
          models: [
            {
              id: 'mock-model',
              name: 'Mock',
              vision: false,
              contextWindow: 64000,
              maxTokens: 4096,
            },
          ],
        },
      };
      const result = await settings.configure(input);
      expect(calls.length).toBe(2);
      expect(calls[1].url).toBe(`https://native.example.test${endpoint}`);
      expect(calls[1].url.includes(input.apiKey)).toBe(false);
      expect(String(calls[1].init?.body).includes('Reply OK.')).toBe(true);
      expect(calls[1].init?.redirect).toBe('error');
      expect(await settings.configure(input)).toStrictEqual(result);
      expect(calls.length).toBe(2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the legacy DeepSeek guard does not authorize a foreign provider model reference', async () => {
  const { isDeepSeekModel, isModelId } = await import('@daban/protocol');
  expect(isModelId('provider:mock-provider:mock-chat')).toBe(true);
  expect(isDeepSeekModel('provider:mock-provider:mock-chat')).toBe(false);
  expect(isDeepSeekModel('deepseek-flash')).toBe(true);
});

test('the configured official model survives writes and rejects unsupported model IDs without replacing the key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-choice-'));
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-model-choice-key', model: 'deepseek-v4-pro' });
    expect((await settings.status()).model).toBe('deepseek-v4-pro');
    expect((await settings.privateConfig())?.model).toBe('deepseek-v4-pro');
    await expect(
      settings.save({ apiKey: 'synthetic-replacement-key', model: 'unsupported-model' }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_SETTINGS' });
    expect((await settings.privateConfig())?.apiKey).toBe('synthetic-model-choice-key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model credentials are write-only in public status and persist with private permissions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-settings-'));
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'));
    expect((await settings.status()).configured).toBe(false);
    const key = 'synthetic-key-for-unit-tests';
    await settings.save({ apiKey: key });
    const state = await settings.status();
    expect(state.configured).toBe(true);
    expect(state.model).toBe('deepseek-flash');
    expect(JSON.stringify(state).includes(key)).toBe(false);
    expect((await settings.privateConfig())?.apiKey).toBe(key);
    expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    await expect(settings.save({ apiKey: 'bad\ncredential' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    });
    expect((await settings.privateConfig())?.apiKey).toBe(key);
    expect(
      (await readFile(path.join(dir, 'credentials.json'), 'utf8')).includes('synthetic-key'),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const catalog = () =>
  Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
test('verified settings use CAS and exact write receipts without exposing keys or repeating a successful check', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-configure-'));
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async (url, init) => {
      calls.push({ url: String(url), init });
      return catalog();
    });
    const input = {
      model: 'deepseek-v4-pro' as const,
      apiKey: 'synthetic-configure-key',
      revision: 0,
      requestId: 'mock-configure',
    };
    const saved = await settings.configure(input);
    expect(saved.revision).toBe(1);
    expect(saved.model).toBe(input.model);
    expect(saved.requestId).toBe(input.requestId);
    expect(JSON.stringify(saved).includes(input.apiKey)).toBe(false);
    expect(JSON.stringify(saved).includes('fingerprint')).toBe(false);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/models');
    expect(calls[0].init?.redirect).toBe('error');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(`Bearer ${input.apiKey}`);
    expect(calls[0].init?.body).toBe(undefined);
    expect(await settings.configure(input)).toStrictEqual(saved);
    expect(calls.length).toBe(1);
    await expect(settings.configure({ ...input, model: 'deepseek-flash' })).rejects.toMatchObject({
      code: 'MODEL_SETTINGS_ID_REUSED',
    });
    const changed = await settings.configure({
      model: 'deepseek-flash',
      revision: 1,
      requestId: 'mock-change-model',
    });
    expect(changed.revision).toBe(2);
    expect((await settings.privateConfig())?.apiKey).toBe(input.apiKey);
    await expect(settings.configure({ ...input, requestId: 'mock-stale' })).rejects.toMatchObject({
      code: 'MODEL_SETTINGS_CONFLICT',
    });
    await expect(settings.check(1)).rejects.toMatchObject({ code: 'MODEL_SETTINGS_CONFLICT' });
    const checked = await settings.check(2);
    expect(checked.model).toBe('deepseek-flash');
    expect(checked.revision).toBe(2);
    expect.assert(Number.isFinite(Date.parse(checked.checkedAt)));
    expect(JSON.stringify(checked).includes(input.apiKey)).toBe(false);
    expect((await settings.status()).revision).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('API and catalog failures do not replace existing credentials or reveal response bodies', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-probe-'));
  let response = () => catalog();
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () => response());
    await settings.save({ apiKey: 'synthetic-existing-key' });
    const before = await settings.resolve();
    let attempt = 0;
    const input = {
      model: 'deepseek-flash',
      apiKey: 'synthetic-rejected-key',
      revision: 1,
      requestId: 'mock-rejected',
    };
    for (const [status, code] of [
      [401, 'MODEL_API_UNAUTHORIZED'],
      [402, 'MODEL_API_BALANCE'],
      [429, 'MODEL_API_RATE_LIMIT'],
      [500, 'MODEL_API_UNAVAILABLE'],
    ] as const) {
      response = () => new Response('synthetic-rejected-key', { status });
      await expect(
        settings.configure({ ...input, requestId: `mock-rejected-${++attempt}` }),
      ).rejects.toMatchObject({ code, message: code });
      expect(await settings.resolve()).toStrictEqual(before);
    }
    response = () => Response.json({ data: [{ id: 'different-model' }] });
    await expect(
      settings.configure({ ...input, requestId: `mock-rejected-${++attempt}` }),
    ).rejects.toMatchObject({
      code: 'MODEL_API_MODEL_UNAVAILABLE',
    });
    response = () => new Response('{broken');
    await expect(
      settings.configure({ ...input, requestId: `mock-rejected-${++attempt}` }),
    ).rejects.toMatchObject({
      code: 'MODEL_API_INVALID_RESPONSE',
    });
    response = () => new Response('x'.repeat(65537));
    await expect(
      settings.configure({ ...input, requestId: `mock-rejected-${++attempt}` }),
    ).rejects.toMatchObject({
      code: 'MODEL_API_INVALID_RESPONSE',
    });
    response = () => {
      throw new Error('synthetic-rejected-key');
    };
    await expect(
      settings.configure({ ...input, requestId: `mock-rejected-${++attempt}` }),
    ).rejects.toMatchObject({
      code: 'MODEL_API_UNAVAILABLE',
      message: 'MODEL_API_UNAVAILABLE',
    });
    expect(await settings.resolve()).toStrictEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a change during validation cannot overwrite the newer setting or publish a stale check', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-race-'));
  let release!: () => unknown;
  let began!: () => unknown;
  let gate = Promise.resolve();
  let started = Promise.resolve();
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () => {
      began();
      await gate;
      return catalog();
    });
    await settings.save({ apiKey: 'synthetic-original-key' });
    for (const action of ['configure', 'check']) {
      gate = new Promise((resolve) => {
        release = resolve;
      });
      started = new Promise((resolve) => {
        began = resolve;
      });
      const revision = (await settings.status()).revision;
      const pending =
        action === 'check'
          ? settings.check(revision)
          : settings.configure({
              model: 'deepseek-v4-pro',
              apiKey: 'synthetic-pending-key',
              revision,
              requestId: 'mock-racing-write',
            });
      await started;
      if (action === 'check') {
        const rejected = expect(pending).rejects.toMatchObject({ code: 'MODEL_SETTINGS_CONFLICT' });
        await settings.save({ apiKey: 'synthetic-newer-key' });
        release();
        await rejected;
        expect((await settings.privateConfig())?.apiKey).toBe('synthetic-newer-key');
      } else {
        await expect(settings.save({ apiKey: 'synthetic-newer-key' })).rejects.toMatchObject({
          code: 'MODEL_SETTINGS_BUSY',
        });
        release();
        await pending;
        expect((await settings.privateConfig())?.apiKey).toBe('synthetic-pending-key');
      }
    }
  } finally {
    release?.();
    await rm(dir, { recursive: true, force: true });
  }
});

const syntheticConnection = (id = 'mock-provider', baseURL = 'https://models.example.test/v1') => ({
  id,
  name: `Synthetic ${id}`,
  baseURL,
  models: [
    {
      id: 'mock-text',
      name: 'Synthetic Text',
      vision: false,
      contextWindow: 32768,
      maxTokens: 2048,
    },
    {
      id: 'mock-vision',
      name: 'Synthetic Vision',
      vision: true,
      contextWindow: 65536,
      maxTokens: 4096,
    },
  ],
});
const syntheticCatalog = () =>
  Response.json({
    data: [
      { id: 'mock-text' },
      { id: 'mock-vision' },
      { id: 'deepseek-flash' },
      { id: 'deepseek-v4-pro' },
    ],
  });

test('independent provider connections preserve legacy credentials and never publish any secret', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-providers-'));
  const calls: { url: string; key: string | null }[] = [];
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async (url, init) => {
      calls.push({ url: String(url), key: new Headers(init?.headers).get('authorization') });
      return syntheticCatalog();
    });
    await writeFile(
      settings.file,
      JSON.stringify({ apiKey: 'synthetic-legacy-key', model: 'deepseek-flash', revision: 4 }),
    );
    const input = {
      model: 'provider:mock-provider:mock-text',
      connection: syntheticConnection(),
      apiKey: 'synthetic-other-key',
      revision: 4,
      requestId: 'mock-add-provider',
    };
    const saved = await settings.configure(input);
    expect(saved.model).toBe(input.model);
    expect(saved.provider).toBe('mock-provider');
    expect(saved.revision).toBe(5);
    expect(JSON.stringify(saved).includes('synthetic-other-key')).toBe(false);
    expect(calls[0].url).toBe('https://models.example.test/v1/models');
    expect(calls[0].key).toBe('Bearer synthetic-other-key');
    expect(await settings.configure(input)).toStrictEqual(saved);
    expect(calls.length).toBe(1);
    await settings.configure({
      model: 'deepseek-flash',
      revision: 5,
      requestId: 'mock-return-legacy',
    });
    expect((await settings.privateConfig())?.apiKey).toBe('synthetic-legacy-key');
    expect.assert((await readFile(settings.file, 'utf8')).includes('synthetic-other-key'));
    await settings.save({ apiKey: 'synthetic-rotated-legacy' });
    expect.assert((await readFile(settings.file, 'utf8')).includes('synthetic-other-key'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider credentials cannot be borrowed from another connection or retained after an endpoint change', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-scope-'));
  let calls = 0;
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () => {
      calls += 1;
      return syntheticCatalog();
    });
    await settings.save({ apiKey: 'synthetic-legacy-key' });
    const input = {
      model: 'provider:mock-provider:mock-text',
      connection: syntheticConnection(),
      revision: 1,
      requestId: 'mock-new-key-required',
    };
    await expect(settings.configure(input)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(calls).toBe(0);
    await settings.configure({ ...input, apiKey: 'synthetic-provider-key' });
    const before = await readFile(settings.file, 'utf8');
    await expect(
      settings.configure({
        ...input,
        connection: syntheticConnection('mock-provider', 'https://other.example.test/v1'),
        revision: 2,
        requestId: 'mock-moved-endpoint',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL_REQUIRED' });
    expect(await readFile(settings.file, 'utf8')).toBe(before);
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a provider save checks every declared model and refuses malformed endpoints before network access', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-validation-'));
  let calls = 0;
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () => {
      calls += 1;
      return Response.json({ data: [{ id: 'mock-text' }] });
    });
    const input = {
      model: 'provider:mock-provider:mock-text',
      connection: syntheticConnection(),
      apiKey: 'synthetic-provider-key',
      revision: 0,
      requestId: 'mock-all-models',
    };
    await expect(settings.configure(input)).rejects.toMatchObject({
      code: 'MODEL_API_MODEL_UNAVAILABLE',
    });
    expect((await settings.status()).configured).toBe(false);
    for (const baseURL of [
      'http://models.example.test/v1',
      'https://secret@models.example.test/v1',
      'https://models.example.test/v1?key=mock',
      'https://models.example.test/v1#mock',
    ]) {
      await expect(
        settings.configure({ ...input, connection: syntheticConnection('mock-provider', baseURL) }),
      ).rejects.toMatchObject({ code: 'INVALID_MODEL_SETTINGS' });
    }
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pending legacy settings receipts remain replayable after the provider catalog upgrade', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-receipt-'));
  try {
    const input = {
      model: 'deepseek-flash',
      apiKey: 'synthetic-legacy-receipt',
      revision: 0,
      requestId: 'mock-legacy-receipt',
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.model, input.apiKey, input.revision]))
      .digest('hex');
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () => {
      throw Error('No new network request expected');
    });
    await writeFile(
      settings.file,
      JSON.stringify({
        provider: 'deepseek-official',
        apiKey: input.apiKey,
        model: input.model,
        revision: 1,
        receipt: { id: input.requestId, fingerprint },
      }),
    );
    expect(await settings.configure(input)).toStrictEqual({
      provider: 'deepseek-official',
      model: input.model,
      configured: true,
      revision: 1,
      requestId: input.requestId,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model resolution binds supplier, endpoint, abilities and search credentials without exposing them in status', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-resolution-'));
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () =>
      syntheticCatalog(),
    );
    await settings.configure({
      model: 'provider:mock-provider:mock-vision',
      connection: syntheticConnection(),
      apiKey: 'synthetic-primary-key',
      revision: 0,
      requestId: 'mock-first-custom',
    });
    const first = await settings.resolve();
    expect(first.provider).toBe('mock-provider');
    expect(first.model).toBe('provider:mock-provider:mock-vision');
    expect(first.apiModel).toBe('mock-vision');
    expect(first.vision).toBe(true);
    expect(first.contextWindow).toBe(65536);
    expect(first.maxTokens).toBe(4096);
    expect(first.searchApiKey).toBe(undefined);
    expect(first.secrets).toStrictEqual(['synthetic-primary-key']);
    await settings.save({ apiKey: 'synthetic-search-key' });
    const next = await settings.resolve();
    expect(next.model).toBe(first.model);
    expect(next.apiKey).toBe(first.apiKey);
    expect(next.searchApiKey).toBe('synthetic-search-key');
    expect(next.binding).not.toBe(first.binding);
    expect(new Set(next.secrets)).toStrictEqual(
      new Set(['synthetic-primary-key', 'synthetic-search-key']),
    );
    await settings.configure({
      model: first.model,
      connection: syntheticConnection('mock-secondary', 'http://127.0.0.1:1234/v1'),
      apiKey: 'synthetic-secondary-key',
      revision: 2,
      requestId: 'mock-add-secondary',
    });
    const secondary = await settings.resolve('provider:mock-secondary:mock-text');
    expect(secondary.apiModel).toBe('mock-text');
    expect(secondary.apiKey).toBe('synthetic-secondary-key');
    expect(secondary.vision).toBe(false);
    expect(secondary.binding).not.toBe(next.binding);
    const publicState = await settings.status(true);
    expect.assert(isModelStatus(publicState));
    expect(publicState.connections?.length).toBe(3);
    expect((await settings.status()).connections).toBe(undefined);
    expect(JSON.stringify(publicState).includes('-key')).toBe(false);
    expect(JSON.stringify(publicState).includes('fingerprint')).toBe(false);
    await expect(settings.resolve('provider:mock-missing:mock-text')).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model references and public metadata validate capabilities, bounds and exact fields', () => {
  const connection = syntheticConnection();
  expect(modelReference('deepseek-official', 'deepseek-flash')).toBe('deepseek-flash');
  expect(modelReference(connection.id, 'mock-text')).toBe('provider:mock-provider:mock-text');
  expect(isModelId('provider:mock-provider:vendor/mock-model:stable')).toBe(true);
  expect(isModelId('arbitrary-legacy-name')).toBe(false);
  expect(isModelId('provider:mock:bad model')).toBe(false);
  expect(isModelId(`provider:mock:${'x'.repeat(161)}`)).toBe(false);
  expect(modelHasVision('deepseek-flash')).toBe(true);
  expect(modelHasVision('deepseek-flash', [])).toBe(false);
  expect(modelCatalog([])).toStrictEqual([]);
  expect(modelCatalog().length).toBe(2);
  expect(modelHasVision('provider:mock-provider:mock-vision', modelCatalog([connection]))).toBe(
    true,
  );
  expect(isModelConnection(connection)).toBe(true);
  expect(isModelConnection({ ...connection, apiKey: 'synthetic-key' })).toBe(false);
  expect(
    isModelConnection({ ...connection, models: [connection.models[0], connection.models[0]] }),
  ).toBe(false);
  expect(
    isModelConnection({ ...connection, models: [{ ...connection.models[0], maxTokens: 40000 }] }),
  ).toBe(false);
  for (const url of [
    'http://localhost:1234/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:1234/v1',
    'https://models.example.test/v1',
  ])
    expect(isModelBaseURL(url)).toBe(true);
  for (const url of [
    'http://192.168.0.1/v1',
    'file:///etc/passwd',
    'https://models.example.test/v1\n',
    'https://models.example.test/v1?',
  ])
    expect(isModelBaseURL(url)).toBe(false);
  const run = {
    id: 'mock-run',
    bot: 'mock-bot',
    workdir: '/tmp/mock',
    canonicalRoot: '/tmp/mock',
    model: 'provider:mock:vision',
    vision: true,
    limit: 10,
  };
  expect(isExecutionRun(run)).toBe(true);
  expect(isExecutionRun({ ...run, vision: 'true' })).toBe(false);
});

test('the reserved official route cannot redirect legacy credentials to a different endpoint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-reserved-provider-'));
  let calls = 0;
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async () => {
      calls += 1;
      return syntheticCatalog();
    });
    await settings.save({ apiKey: 'synthetic-official-key' });
    const before = await readFile(settings.file, 'utf8');
    for (const baseURL of [
      'https://proxy.example.test/v1',
      'https://api.deepseek.com/v1/',
      'https://api.deepseek.com/v1/../v1',
    ]) {
      const connection = syntheticConnection('deepseek-official', baseURL);
      expect(isModelConnection(connection)).toBe(false);
      await expect(
        settings.configure({
          model: 'provider:deepseek-official:mock-text',
          connection,
          apiKey: 'synthetic-other-key',
          revision: 1,
          requestId: 'mock-moved-official',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MODEL_SETTINGS' });
      expect(await readFile(settings.file, 'utf8')).toBe(before);
    }
    expect(
      isModelConnection(syntheticConnection('deepseek-official', 'https://api.deepseek.com/v1')),
    ).toBe(true);
    expect(
      isModelConnection(syntheticConnection('mock-proxy', 'https://proxy.example.test/v1')),
    ).toBe(true);
    expect(calls).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('private catalog reads reject contradictory defaults, missing identity and oversized files without rewriting them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-private-catalog-'));
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-official-key' });
    const saved = JSON.parse(await readFile(settings.file, 'utf8')) as Record<string, unknown>;
    for (const input of [
      { ...saved, apiKey: 'synthetic-inconsistent-key' },
      { ...saved, provider: 'mock-other' },
      { ...saved, model: 'provider:mock-other:mock-text' },
      { ...saved, model: undefined },
      { ...saved, provider: undefined },
      { ...saved, revision: undefined },
      { ...saved, padding: 'x'.repeat(2 * 1024 * 1024) },
    ]) {
      const content = JSON.stringify(input);
      await writeFile(settings.file, content);
      await expect(settings.privateConfig()).rejects.toMatchObject({
        code: 'MODEL_CONFIG_UNAVAILABLE',
      });
      expect(await readFile(settings.file, 'utf8')).toBe(content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing model-list endpoints verify each declared model with a fixed bounded completion and retain exact replay', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-completion-'));
  try {
    for (const status of [404, 405]) {
      const calls: { url: string; init?: RequestInit }[] = [];
      const settings = new ModelSettings(
        path.join(dir, `credentials-${status}.json`),
        async (url, init) => {
          calls.push({ url: String(url), init });
          if (String(url).endsWith('/models')) return new Response(null, { status });
          return Response.json({
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
          });
        },
      );
      const input = {
        model: 'provider:mock-provider:mock-text',
        connection: syntheticConnection(),
        apiKey: 'synthetic-completion-key',
        revision: 0,
        requestId: `mock-completion-${status}`,
      };
      const saved = await settings.configure(input);
      expect(saved.model).toBe(input.model);
      expect(calls.length).toBe(3);
      for (const [index, call] of calls.slice(1).entries()) {
        expect(call.url).toBe('https://models.example.test/v1/chat/completions');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.redirect).toBe('error');
        expect(new Headers(call.init?.headers).get('authorization')).toBe(
          'Bearer synthetic-completion-key',
        );
        expect(JSON.parse(String(call.init?.body))).toStrictEqual({
          model: input.connection.models[index].id,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          stream: false,
          max_tokens: 8,
        });
        expect(String(call.init?.body).includes(input.apiKey)).toBe(false);
      }
      expect(await settings.configure(input)).toStrictEqual(saved);
      expect(calls.length).toBe(3);
      await settings.check(1);
      expect(calls.length).toBe(5);
      expect(JSON.parse(String(calls[4].init?.body)).model).toBe('mock-text');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completion fallback never hides authorization, balance, rate, malformed response or network failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-fallback-failures-'));
  try {
    let reply = () => new Response(null, { status: 401 });
    const calls: string[] = [];
    const settings = new ModelSettings(path.join(dir, 'credentials.json'), async (url) => {
      calls.push(String(url));
      return reply();
    });
    await settings.save({ apiKey: 'synthetic-preserved-key' });
    const before = await settings.resolve();
    let attempt = 0;
    const input = {
      model: 'provider:mock-provider:mock-text',
      connection: syntheticConnection(),
      apiKey: 'synthetic-failing-key',
      revision: 1,
      requestId: 'mock-failed-completion',
    };
    for (const [status, code] of [
      [400, 'MODEL_API_UNAVAILABLE'],
      [401, 'MODEL_API_UNAUTHORIZED'],
      [403, 'MODEL_API_UNAUTHORIZED'],
      [402, 'MODEL_API_BALANCE'],
      [429, 'MODEL_API_RATE_LIMIT'],
      [500, 'MODEL_API_UNAVAILABLE'],
    ] as const) {
      reply = () => new Response('synthetic-failing-key', { status });
      calls.length = 0;
      await expect(
        settings.configure({ ...input, requestId: `mock-completion-failure-${++attempt}` }),
      ).rejects.toMatchObject({ code, message: code });
      expect(calls.length).toBe(1);
      expect(await settings.resolve()).toStrictEqual(before);
    }
    for (const response of [
      () => Response.json({ choices: [] }),
      () => new Response('x'.repeat(65537)),
      () => {
        throw Error('synthetic-failing-key');
      },
    ]) {
      calls.length = 0;
      reply = () => (calls.length === 1 ? new Response(null, { status: 404 }) : response());
      await expect(
        settings.configure({ ...input, requestId: `mock-completion-failure-${++attempt}` }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error &&
          ['MODEL_API_INVALID_RESPONSE', 'MODEL_API_UNAVAILABLE'].includes(error.message),
      );
      expect(calls.length).toBe(2);
      expect(await settings.resolve()).toStrictEqual(before);
    }
    calls.length = 0;
    reply = () =>
      calls.length === 1
        ? new Response(null, { status: 404 })
        : calls.length === 2
          ? Response.json({
              choices: [
                {
                  finish_reason: 'length',
                  message: {
                    role: 'assistant',
                    content: '',
                    reasoning_content: 'Synthetic reasoning',
                  },
                },
              ],
            })
          : new Response(null, { status: 403 });
    await expect(
      settings.configure({ ...input, requestId: `mock-completion-failure-${++attempt}` }),
    ).rejects.toMatchObject({
      code: 'MODEL_API_UNAUTHORIZED',
    });
    expect(calls.length).toBe(3);
    expect(await settings.resolve()).toStrictEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('official search follows the explicitly configured official endpoint even with generated connection IDs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-provider-search-'));
  try {
    for (const legacy of [false, true]) {
      const settings = new ModelSettings(path.join(dir, `credentials-${legacy}.json`), async () =>
        syntheticCatalog(),
      );
      if (legacy) await settings.save({ apiKey: 'synthetic-legacy-search-key' });
      const first = syntheticConnection('mock-generated-first', 'https://api.deepseek.com/v1');
      await settings.configure({
        model: 'provider:mock-generated-first:mock-text',
        connection: first,
        apiKey: 'synthetic-first-search-key',
        revision: legacy ? 1 : 0,
        requestId: 'mock-first-official-search',
      });
      const firstRoute = await settings.resolve();
      expect(firstRoute.searchApiKey).toBe('synthetic-first-search-key');
      await settings.configure({
        model: 'provider:mock-generated-second:mock-text',
        connection: syntheticConnection('mock-generated-second', 'https://api.deepseek.com/v1/'),
        apiKey: 'synthetic-second-search-key',
        revision: (await settings.status()).revision,
        requestId: 'mock-second-official-search',
      });
      const secondRoute = await settings.resolve();
      expect(secondRoute.searchApiKey).toBe('synthetic-second-search-key');
      expect(secondRoute.binding).not.toBe(firstRoute.binding);
      await settings.configure({
        model: 'provider:mock-custom:mock-text',
        connection: syntheticConnection('mock-custom'),
        apiKey: 'synthetic-custom-key',
        revision: (await settings.status()).revision,
        requestId: 'mock-custom-search',
      });
      const customRoute = await settings.resolve();
      expect(customRoute.searchApiKey).toBe(
        legacy ? 'synthetic-legacy-search-key' : 'synthetic-first-search-key',
      );
      const restarted = new ModelSettings(settings.file);
      expect((await restarted.resolve()).searchApiKey).toBe(customRoute.searchApiKey);
      expect(
        (await restarted.resolve('provider:mock-generated-second:mock-text')).searchApiKey,
      ).toBe('synthetic-second-search-key');
      await settings.configure({
        model: customRoute.model,
        connection: { ...first, name: 'Renamed synthetic connection' },
        revision: (await settings.status()).revision,
        requestId: 'mock-rename-official-search',
      });
      expect((await settings.resolve()).searchApiKey).toBe(customRoute.searchApiKey);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
