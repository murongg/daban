import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelSettings } from './settings.js';

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
