import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    assert.equal(calls[0].url, 'https://claude.example.test/v1/models/mock-claude');
    assert.equal(new Headers(calls[0].init?.headers).get('x-api-key'), 'synthetic-claude-key');
    assert.equal(new Headers(calls[0].init?.headers).get('anthropic-version'), '2023-06-01');
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), null);
    assert.equal(
      Reflect.get((await settings.status(true)).connections![0], 'api'),
      'anthropic-messages',
    );
    assert.equal(Reflect.get(await settings.resolve(), 'api'), 'anthropic-messages');
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
    assert.deepEqual(
      calls.map((item) => item.url),
      [
        'https://google.example.test/v1beta/models/mock-gemini',
        'https://google.example.test/v1beta/models/mock-gemini-two',
      ],
    );
    assert.equal(
      calls.every((item) => !item.url.includes('synthetic-google-key')),
      true,
    );
    assert.equal(new Headers(calls[0].init?.headers).get('x-goog-api-key'), 'synthetic-google-key');
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), null);
    assert.equal((await settings.resolve()).apiModel, 'mock-gemini');
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
    assert.deepEqual(calls, ['https://claude.example.test/v1/models/mock-claude-latest']);
    assert.equal((await settings.resolve()).apiModel, 'mock-claude-latest');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model API selectors reject nonstring values and native Google path traversal', async () => {
  const { isModelApi, modelApi } = await import('@daban/protocol');
  assert.equal(isModelApi({ toString: () => 'anthropic-messages' }), false);
  assert.equal(modelApi({}), 'openai-completions');
  for (const id of ['../mock-model', 'models/../mock-model', 'models/one/two'])
    assert.equal(
      isModelConnection({
        ...syntheticConnection(),
        api: 'google-generative-ai',
        models: [{ ...syntheticConnection().models[0], id }],
      }),
      false,
    );
  assert.equal(
    isModelConnection({
      ...syntheticConnection('deepseek-official', 'https://api.deepseek.com/v1'),
      api: 'anthropic-messages',
    }),
    false,
  );
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
    await assert.rejects(settings.configure(next), { code: 'MODEL_CREDENTIAL_REQUIRED' });
    assert.equal(calls, 1);
    assert.equal(await readFile(settings.file, 'utf8'), before);
    const input = { ...next, apiKey: 'synthetic-new-protocol-key' };
    const saved = await settings.configure(input);
    assert.notEqual((await settings.resolve()).binding, first.binding);
    assert.equal((await settings.resolve()).api, 'anthropic-messages');
    assert.deepEqual(await settings.configure(input), saved);
    assert.equal(calls, 2);
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
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, `https://native.example.test${endpoint}`);
      assert.equal(calls[1].url.includes(input.apiKey), false);
      assert.equal(String(calls[1].init?.body).includes('Reply OK.'), true);
      assert.equal(calls[1].init?.redirect, 'error');
      assert.deepEqual(await settings.configure(input), result);
      assert.equal(calls.length, 2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the legacy DeepSeek guard does not authorize a foreign provider model reference', async () => {
  const { isDeepSeekModel, isModelId } = await import('@daban/protocol');
  assert.equal(isModelId('provider:mock-provider:mock-chat'), true);
  assert.equal(isDeepSeekModel('provider:mock-provider:mock-chat'), false);
  assert.equal(isDeepSeekModel('deepseek-flash'), true);
});

test('the configured official model survives writes and rejects unsupported model IDs without replacing the key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-choice-'));
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-model-choice-key', model: 'deepseek-v4-pro' });
    assert.equal((await settings.status()).model, 'deepseek-v4-pro');
    assert.equal((await settings.privateConfig())?.model, 'deepseek-v4-pro');
    await assert.rejects(
      settings.save({ apiKey: 'synthetic-replacement-key', model: 'unsupported-model' }),
      { code: 'INVALID_MODEL_SETTINGS' },
    );
    assert.equal((await settings.privateConfig())?.apiKey, 'synthetic-model-choice-key');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model credentials are write-only in public status and persist with private permissions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-settings-'));
  try {
    const settings = new ModelSettings(path.join(dir, 'credentials.json'));
    assert.equal((await settings.status()).configured, false);
    const key = 'synthetic-key-for-unit-tests';
    await settings.save({ apiKey: key });
    const state = await settings.status();
    assert.equal(state.configured, true);
    assert.equal(state.model, 'deepseek-flash');
    assert.equal(JSON.stringify(state).includes(key), false);
    assert.equal((await settings.privateConfig())?.apiKey, key);
    assert.equal((await stat(path.join(dir, 'credentials.json'))).mode & 0o777, 0o600);
    await assert.rejects(settings.save({ apiKey: 'bad\ncredential' }), {
      code: 'INVALID_CREDENTIAL',
    });
    assert.equal((await settings.privateConfig())?.apiKey, key);
    assert.equal(
      (await readFile(path.join(dir, 'credentials.json'), 'utf8')).includes('synthetic-key'),
      true,
    );
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
    assert.equal(saved.revision, 1);
    assert.equal(saved.model, input.model);
    assert.equal(saved.requestId, input.requestId);
    assert.equal(JSON.stringify(saved).includes(input.apiKey), false);
    assert.equal(JSON.stringify(saved).includes('fingerprint'), false);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/models');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(
      new Headers(calls[0].init?.headers).get('authorization'),
      `Bearer ${input.apiKey}`,
    );
    assert.equal(calls[0].init?.body, undefined);
    assert.deepEqual(await settings.configure(input), saved);
    assert.equal(calls.length, 1);
    await assert.rejects(settings.configure({ ...input, model: 'deepseek-flash' }), {
      code: 'MODEL_SETTINGS_ID_REUSED',
    });
    const changed = await settings.configure({
      model: 'deepseek-flash',
      revision: 1,
      requestId: 'mock-change-model',
    });
    assert.equal(changed.revision, 2);
    assert.equal((await settings.privateConfig())?.apiKey, input.apiKey);
    await assert.rejects(settings.configure({ ...input, requestId: 'mock-stale' }), {
      code: 'MODEL_SETTINGS_CONFLICT',
    });
    await assert.rejects(settings.check(1), { code: 'MODEL_SETTINGS_CONFLICT' });
    const checked = await settings.check(2);
    assert.equal(checked.model, 'deepseek-flash');
    assert.equal(checked.revision, 2);
    assert.ok(Number.isFinite(Date.parse(checked.checkedAt)));
    assert.equal(JSON.stringify(checked).includes(input.apiKey), false);
    assert.equal((await settings.status()).revision, 2);
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
    const before = await readFile(settings.file, 'utf8');
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
      await assert.rejects(settings.configure(input), { code, message: code });
      assert.equal(await readFile(settings.file, 'utf8'), before);
    }
    response = () => Response.json({ data: [{ id: 'different-model' }] });
    await assert.rejects(settings.configure(input), { code: 'MODEL_API_MODEL_UNAVAILABLE' });
    response = () => new Response('{broken');
    await assert.rejects(settings.configure(input), { code: 'MODEL_API_INVALID_RESPONSE' });
    response = () => new Response('x'.repeat(65537));
    await assert.rejects(settings.configure(input), { code: 'MODEL_API_INVALID_RESPONSE' });
    response = () => {
      throw new Error('synthetic-rejected-key');
    };
    await assert.rejects(settings.configure(input), {
      code: 'MODEL_API_UNAVAILABLE',
      message: 'MODEL_API_UNAVAILABLE',
    });
    assert.equal(await readFile(settings.file, 'utf8'), before);
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
      const rejected = assert.rejects(pending, { code: 'MODEL_SETTINGS_CONFLICT' });
      await started;
      await settings.save({ apiKey: 'synthetic-newer-key' });
      release();
      await rejected;
      assert.equal((await settings.privateConfig())?.apiKey, 'synthetic-newer-key');
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
    assert.equal(saved.model, input.model);
    assert.equal(saved.provider, 'mock-provider');
    assert.equal(saved.revision, 5);
    assert.equal(JSON.stringify(saved).includes('synthetic-other-key'), false);
    assert.equal(calls[0].url, 'https://models.example.test/v1/models');
    assert.equal(calls[0].key, 'Bearer synthetic-other-key');
    assert.deepEqual(await settings.configure(input), saved);
    assert.equal(calls.length, 1);
    await settings.configure({
      model: 'deepseek-flash',
      revision: 5,
      requestId: 'mock-return-legacy',
    });
    assert.equal((await settings.privateConfig())?.apiKey, 'synthetic-legacy-key');
    assert.ok((await readFile(settings.file, 'utf8')).includes('synthetic-other-key'));
    await settings.save({ apiKey: 'synthetic-rotated-legacy' });
    assert.ok((await readFile(settings.file, 'utf8')).includes('synthetic-other-key'));
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
    await assert.rejects(settings.configure(input), { code: 'MODEL_NOT_CONFIGURED' });
    assert.equal(calls, 0);
    await settings.configure({ ...input, apiKey: 'synthetic-provider-key' });
    const before = await readFile(settings.file, 'utf8');
    await assert.rejects(
      settings.configure({
        ...input,
        connection: syntheticConnection('mock-provider', 'https://other.example.test/v1'),
        revision: 2,
        requestId: 'mock-moved-endpoint',
      }),
      { code: 'MODEL_CREDENTIAL_REQUIRED' },
    );
    assert.equal(await readFile(settings.file, 'utf8'), before);
    assert.equal(calls, 1);
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
    await assert.rejects(settings.configure(input), { code: 'MODEL_API_MODEL_UNAVAILABLE' });
    assert.equal((await settings.status()).configured, false);
    for (const baseURL of [
      'http://models.example.test/v1',
      'https://secret@models.example.test/v1',
      'https://models.example.test/v1?key=mock',
      'https://models.example.test/v1#mock',
    ]) {
      await assert.rejects(
        settings.configure({ ...input, connection: syntheticConnection('mock-provider', baseURL) }),
        { code: 'INVALID_MODEL_SETTINGS' },
      );
    }
    assert.equal(calls, 1);
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
    assert.deepEqual(await settings.configure(input), {
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
    assert.equal(first.provider, 'mock-provider');
    assert.equal(first.model, 'provider:mock-provider:mock-vision');
    assert.equal(first.apiModel, 'mock-vision');
    assert.equal(first.vision, true);
    assert.equal(first.contextWindow, 65536);
    assert.equal(first.maxTokens, 4096);
    assert.equal(first.searchApiKey, undefined);
    assert.deepEqual(first.secrets, ['synthetic-primary-key']);
    await settings.save({ apiKey: 'synthetic-search-key' });
    const next = await settings.resolve();
    assert.equal(next.model, first.model);
    assert.equal(next.apiKey, first.apiKey);
    assert.equal(next.searchApiKey, 'synthetic-search-key');
    assert.notEqual(next.binding, first.binding);
    assert.deepEqual(
      new Set(next.secrets),
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
    assert.equal(secondary.apiModel, 'mock-text');
    assert.equal(secondary.apiKey, 'synthetic-secondary-key');
    assert.equal(secondary.vision, false);
    assert.notEqual(secondary.binding, next.binding);
    const publicState = await settings.status(true);
    assert.ok(isModelStatus(publicState));
    assert.equal(publicState.connections?.length, 3);
    assert.equal((await settings.status()).connections, undefined);
    assert.equal(JSON.stringify(publicState).includes('-key'), false);
    assert.equal(JSON.stringify(publicState).includes('fingerprint'), false);
    await assert.rejects(settings.resolve('provider:mock-missing:mock-text'), {
      code: 'MODEL_UNAVAILABLE',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model references and public metadata validate capabilities, bounds and exact fields', () => {
  const connection = syntheticConnection();
  assert.equal(modelReference('deepseek-official', 'deepseek-flash'), 'deepseek-flash');
  assert.equal(modelReference(connection.id, 'mock-text'), 'provider:mock-provider:mock-text');
  assert.equal(isModelId('provider:mock-provider:vendor/mock-model:stable'), true);
  assert.equal(isModelId('arbitrary-legacy-name'), false);
  assert.equal(isModelId('provider:mock:bad model'), false);
  assert.equal(isModelId(`provider:mock:${'x'.repeat(161)}`), false);
  assert.equal(modelHasVision('deepseek-flash'), true);
  assert.equal(modelHasVision('deepseek-flash', []), false);
  assert.deepEqual(modelCatalog([]), []);
  assert.equal(modelCatalog().length, 2);
  assert.equal(
    modelHasVision('provider:mock-provider:mock-vision', modelCatalog([connection])),
    true,
  );
  assert.equal(isModelConnection(connection), true);
  assert.equal(isModelConnection({ ...connection, apiKey: 'synthetic-key' }), false);
  assert.equal(
    isModelConnection({ ...connection, models: [connection.models[0], connection.models[0]] }),
    false,
  );
  assert.equal(
    isModelConnection({ ...connection, models: [{ ...connection.models[0], maxTokens: 40000 }] }),
    false,
  );
  for (const url of [
    'http://localhost:1234/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:1234/v1',
    'https://models.example.test/v1',
  ])
    assert.equal(isModelBaseURL(url), true);
  for (const url of [
    'http://192.168.0.1/v1',
    'file:///etc/passwd',
    'https://models.example.test/v1\n',
    'https://models.example.test/v1?',
  ])
    assert.equal(isModelBaseURL(url), false);
  const run = {
    id: 'mock-run',
    bot: 'mock-bot',
    workdir: '/tmp/mock',
    canonicalRoot: '/tmp/mock',
    model: 'provider:mock:vision',
    vision: true,
    limit: 10,
  };
  assert.equal(isExecutionRun(run), true);
  assert.equal(isExecutionRun({ ...run, vision: 'true' }), false);
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
      assert.equal(isModelConnection(connection), false);
      await assert.rejects(
        settings.configure({
          model: 'provider:deepseek-official:mock-text',
          connection,
          apiKey: 'synthetic-other-key',
          revision: 1,
          requestId: 'mock-moved-official',
        }),
        { code: 'INVALID_MODEL_SETTINGS' },
      );
      assert.equal(await readFile(settings.file, 'utf8'), before);
    }
    assert.equal(
      isModelConnection(syntheticConnection('deepseek-official', 'https://api.deepseek.com/v1')),
      true,
    );
    assert.equal(
      isModelConnection(syntheticConnection('mock-proxy', 'https://proxy.example.test/v1')),
      true,
    );
    assert.equal(calls, 0);
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
      await assert.rejects(settings.privateConfig(), { code: 'MODEL_CONFIG_UNAVAILABLE' });
      assert.equal(await readFile(settings.file, 'utf8'), content);
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
      assert.equal(saved.model, input.model);
      assert.equal(calls.length, 3);
      for (const [index, call] of calls.slice(1).entries()) {
        assert.equal(call.url, 'https://models.example.test/v1/chat/completions');
        assert.equal(call.init?.method, 'POST');
        assert.equal(call.init?.redirect, 'error');
        assert.equal(
          new Headers(call.init?.headers).get('authorization'),
          'Bearer synthetic-completion-key',
        );
        assert.deepEqual(JSON.parse(String(call.init?.body)), {
          model: input.connection.models[index].id,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          stream: false,
          max_tokens: 8,
        });
        assert.equal(String(call.init?.body).includes(input.apiKey), false);
      }
      assert.deepEqual(await settings.configure(input), saved);
      assert.equal(calls.length, 3);
      await settings.check(1);
      assert.equal(calls.length, 5);
      assert.equal(JSON.parse(String(calls[4].init?.body)).model, 'mock-text');
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
    const before = await readFile(settings.file, 'utf8');
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
      await assert.rejects(settings.configure(input), { code, message: code });
      assert.equal(calls.length, 1);
      assert.equal(await readFile(settings.file, 'utf8'), before);
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
      await assert.rejects(
        settings.configure(input),
        (error: unknown) =>
          error instanceof Error &&
          ['MODEL_API_INVALID_RESPONSE', 'MODEL_API_UNAVAILABLE'].includes(error.message),
      );
      assert.equal(calls.length, 2);
      assert.equal(await readFile(settings.file, 'utf8'), before);
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
    await assert.rejects(settings.configure(input), { code: 'MODEL_API_UNAUTHORIZED' });
    assert.equal(calls.length, 3);
    assert.equal(await readFile(settings.file, 'utf8'), before);
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
      assert.equal(firstRoute.searchApiKey, 'synthetic-first-search-key');
      await settings.configure({
        model: 'provider:mock-generated-second:mock-text',
        connection: syntheticConnection('mock-generated-second', 'https://api.deepseek.com/v1/'),
        apiKey: 'synthetic-second-search-key',
        revision: (await settings.status()).revision,
        requestId: 'mock-second-official-search',
      });
      const secondRoute = await settings.resolve();
      assert.equal(secondRoute.searchApiKey, 'synthetic-second-search-key');
      assert.notEqual(secondRoute.binding, firstRoute.binding);
      await settings.configure({
        model: 'provider:mock-custom:mock-text',
        connection: syntheticConnection('mock-custom'),
        apiKey: 'synthetic-custom-key',
        revision: (await settings.status()).revision,
        requestId: 'mock-custom-search',
      });
      const customRoute = await settings.resolve();
      assert.equal(
        customRoute.searchApiKey,
        legacy ? 'synthetic-legacy-search-key' : 'synthetic-first-search-key',
      );
      const restarted = new ModelSettings(settings.file);
      assert.equal((await restarted.resolve()).searchApiKey, customRoute.searchApiKey);
      assert.equal(
        (await restarted.resolve('provider:mock-generated-second:mock-text')).searchApiKey,
        'synthetic-second-search-key',
      );
      await settings.configure({
        model: customRoute.model,
        connection: { ...first, name: 'Renamed synthetic connection' },
        revision: (await settings.status()).revision,
        requestId: 'mock-rename-official-search',
      });
      assert.equal((await settings.resolve()).searchApiKey, customRoute.searchApiKey);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
