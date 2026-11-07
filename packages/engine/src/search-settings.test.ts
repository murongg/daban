import { link, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSearchCheckRequest,
  isSearchReceipt,
  isSearchStatus,
  isSearchUpdate,
  type SearchReceipt,
  type SearchResult,
  type SearchUpdate,
} from '@daban/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { privateMetadata } from './private-files.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

const writes = vi.hoisted(() => ({
  failRename: false,
  heldRename: undefined as
    | { file: string; entered: () => unknown; release: Promise<unknown>; skip?: number }
    | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (writes.failRename)
        throw Object.assign(new Error('Synthetic rename failure'), { code: 'EACCES' });
      const held = writes.heldRename;
      if (held && String(args[1]) === held.file) {
        if (held.skip) {
          held.skip--;
          return actual.rename(...args);
        }
        held.entered();
        await held.release;
      }
      return actual.rename(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  writes.failRename = false;
  writes.heldRename = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-settings-'));
  roots.push(root);
  const models = new ModelSettings(path.join(root, 'models.json'), async () => {
    throw new Error('Unexpected model network');
  });
  const search = new SearchSettings(path.join(root, 'search.json'), models);
  return { root, models, search };
}
const update = (overrides: Partial<SearchUpdate> = {}): SearchUpdate => ({
  requestId: 'mock-save',
  revision: 0,
  enabled: true,
  provider: 'brave',
  key: 'synthetic-brave-key',
  ...overrides,
});

async function savedLegacy(search: SearchSettings, connection = 'deepseek-official') {
  await writeFile(
    search.file,
    JSON.stringify({
      version: 1,
      revision: 0,
      checkRevision: 0,
      enabled: true,
      provider: 'deepseek',
      credential: { kind: 'legacy-linked', connection },
    }),
    { mode: 0o600 },
  );
}

test('a missing configuration initializes locally without claiming credentials', async () => {
  const { search } = await fixture();
  expect(await search.status()).toMatchObject({
    revision: 0,
    checkRevision: 0,
    credentialConfigured: false,
    credentialSource: 'none',
    health: 'unchecked',
    provider: 'bing',
  });
});
test('saved legacy key-only credentials stay as a fixed reference and are never copied', async () => {
  const { root, models, search } = await fixture();
  await writeFile(models.file, JSON.stringify({ apiKey: 'synthetic-legacy-key' }), { mode: 0o600 });
  await savedLegacy(search);
  expect(await search.status()).toMatchObject({
    enabled: true,
    provider: 'deepseek',
    credentialConfigured: true,
    credentialSource: 'legacy-linked',
  });
  const text = await readFile(search.file, 'utf8');
  expect(text).toContain('deepseek-official');
  expect(text).not.toContain('synthetic-legacy-key');
  expect(await privateMetadata(search.file, await stat(search.file), 0o600)).toBe(true);
  expect(await privateMetadata(root, await stat(root), 0o700)).toBe(true);
});
test('same-ID saves replay their original receipt; conflicts and stale writes cannot replace it', async () => {
  const { search } = await fixture();
  const input = update();
  const first = await search.configure(input);
  expect(first).toMatchObject({
    kind: 'configure',
    requestId: input.requestId,
    phase: 'saved',
    revision: 1,
    status: { health: 'unchecked' },
  });
  expect(await search.configure(input)).toEqual(first);
  expect(await search.saved({ kind: 'configure', requestId: input.requestId })).toEqual(first);
  await expect(search.configure({ ...input, key: 'synthetic-other-key' })).rejects.toMatchObject({
    code: 'SEARCH_REQUEST_CONFLICT',
  });
  await expect(search.configure({ ...input, requestId: 'mock-stale' })).rejects.toMatchObject({
    code: 'SEARCH_SETTINGS_CONFLICT',
  });
  expect(JSON.stringify(first)).not.toContain(input.key);
});
test('an empty key keeps same-provider credentials but a provider change requires its own key', async () => {
  const { search } = await fixture();
  await search.configure(update());
  await search.configure(
    update({ requestId: 'mock-disable', revision: 1, enabled: false, key: '' }),
  );
  expect(await search.status()).toMatchObject({
    revision: 2,
    enabled: false,
    credentialConfigured: true,
    health: 'disabled',
  });
  await expect(
    search.configure(
      update({ requestId: 'mock-switch', revision: 2, provider: 'deepseek', key: '' }),
    ),
  ).rejects.toMatchObject({ code: 'SEARCH_CREDENTIAL_REQUIRED' });
  expect(await search.status()).toMatchObject({ revision: 2, provider: 'brave' });
});
test('configuration persists across restart and older receipt IDs are superseded', async () => {
  const { models, search } = await fixture();
  await search.configure(update());
  await search.configure(
    update({ revision: 1, requestId: 'mock-next', enabled: false, key: undefined }),
  );
  const restarted = new SearchSettings(search.file, models);
  expect(await restarted.status()).toMatchObject({
    revision: 2,
    provider: 'brave',
    enabled: false,
  });
  expect(await restarted.saved({ kind: 'configure', requestId: 'mock-save' })).toEqual({
    kind: 'configure',
    requestId: 'mock-save',
    phase: 'superseded',
  });
});
test('corrupt and linked private files fail closed without rewriting the target', async () => {
  const { root, search } = await fixture();
  await writeFile(search.file, '{broken', { mode: 0o600 });
  await expect(search.status()).rejects.toMatchObject({ code: 'SEARCH_CONFIG_UNAVAILABLE' });
  expect(await readFile(search.file, 'utf8')).toBe('{broken');
  await rm(search.file);
  const target = path.join(root, 'target.json');
  await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, search.file);
  await expect(new SearchSettings(search.file, search.models).status()).rejects.toMatchObject({
    code: 'SEARCH_CONFIG_UNAVAILABLE',
  });
  expect(await readFile(target, 'utf8')).toBe('{}');
});
test('search wire validators reject secret reflection and unknown fields', () => {
  expect(isSearchUpdate(update())).toBe(true);
  expect(isSearchUpdate({ ...update(), endpoint: 'https://foreign.example.test' })).toBe(false);
  expect(isSearchCheckRequest({ requestId: 'mock-check', revision: 1, checkRevision: 0 })).toBe(
    true,
  );
  expect(
    isSearchCheckRequest({
      requestId: 'mock-check',
      revision: 1,
      checkRevision: 0,
      query: 'private',
    }),
  ).toBe(false);
  const status = {
    revision: 1,
    checkRevision: 0,
    enabled: true,
    provider: 'brave',
    credentialConfigured: true,
    credentialSource: 'independent',
    health: 'unchecked',
  };
  expect(isSearchStatus(status)).toBe(true);
  expect(isSearchStatus({ ...status, key: 'synthetic-secret' })).toBe(false);
  expect(
    isSearchReceipt({
      kind: 'check',
      requestId: 'mock-check',
      phase: 'settled',
      revision: 1,
      checkRevision: 1,
      status: { ...status, checkRevision: 1 },
    }),
  ).toBe(true);
});

test('explicit checks claim before one dispatch and replay without sharing the save receipt', async () => {
  const { models, search } = await fixture();
  const calls: string[] = [];
  const checked = new SearchSettings(search.file, models, {
    query: async (provider, key, query) => {
      calls.push(`${provider}:${query}`);
      expect(key).toBe('synthetic-brave-key');
      return { sources: [], truncated: false };
    },
  });
  const saved = await checked.configure(update());
  const request = { requestId: 'mock-check', revision: 1, checkRevision: 0 };
  const [a, b] = await Promise.all([checked.check(request), checked.check(request)]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ phase: 'settled', checkRevision: 1, status: { health: 'empty' } });
  expect(calls).toEqual(['brave:synthetic search connectivity test']);
  expect(await checked.check(request)).toEqual(a);
  expect(await checked.saved({ kind: 'configure', requestId: 'mock-save' })).toEqual(saved);
  await expect(checked.check({ ...request, requestId: 'mock-stale' })).rejects.toMatchObject({
    code: 'SEARCH_CHECK_CONFLICT',
  });
});
test('pending checks reject another claim and restart converts the original claim to unknown', async () => {
  const { models, search } = await fixture();
  let release: ((result: SearchResult) => unknown) | undefined;
  const response = new Promise<SearchResult>((resolve) => {
    release = resolve;
  });
  let dispatched = 0;
  const checked = new SearchSettings(search.file, models, {
    query: async () => {
      dispatched++;
      return response;
    },
  });
  await checked.configure(update());
  const request = { requestId: 'mock-pending', revision: 1, checkRevision: 0 };
  const pending = checked.check(request);
  for (let i = 0; i < 100 && !dispatched; i++)
    await new Promise<unknown>((resolve) => setTimeout(resolve, 2));
  expect(dispatched).toBe(1);
  expect(await checked.saved({ kind: 'check', requestId: request.requestId })).toMatchObject({
    phase: 'claimed',
  });
  await expect(
    checked.check({ ...request, requestId: 'mock-second', checkRevision: 1 }),
  ).rejects.toMatchObject({ code: 'SEARCH_CHECK_PENDING' });
  const restarted = new SearchSettings(search.file, models, {
    query: async () => {
      throw new Error('Must not repeat unknown search');
    },
  });
  expect(await restarted.check(request)).toMatchObject({
    phase: 'unknown',
    status: { health: 'unknown', error: 'SEARCH_OUTCOME_UNKNOWN' },
  });
  release?.({ sources: [], truncated: false });
  expect(await pending).toMatchObject({ phase: 'unknown' });
});
test('a late check keeps its own changed-config outcome without overwriting newer health', async () => {
  const { models, search } = await fixture();
  let release: ((result: SearchResult) => unknown) | undefined;
  const response = new Promise<SearchResult>((resolve) => {
    release = resolve;
  });
  let dispatched = false;
  const checked = new SearchSettings(search.file, models, {
    query: async () => {
      dispatched = true;
      return response;
    },
  });
  await checked.configure(update());
  const pending = checked.check({ requestId: 'mock-late', revision: 1, checkRevision: 0 });
  for (let i = 0; i < 100 && !dispatched; i++)
    await new Promise<unknown>((resolve) => setTimeout(resolve, 2));
  await checked.configure(update({ requestId: 'mock-new', revision: 1, key: 'synthetic-new-key' }));
  release?.({ sources: [], truncated: false });
  expect(await pending).toMatchObject({
    phase: 'settled',
    revision: 1,
    status: { health: 'config-changed' },
  });
  expect(await checked.status()).toMatchObject({ revision: 2, health: 'unchecked' });
});

const connection = (id: string, baseURL = 'https://api.deepseek.com/v1') => ({
  id,
  name: 'Synthetic provider',
  baseURL,
  apiKey: `synthetic-key-${id}`,
  models: [
    {
      id: 'mock-model',
      name: 'Synthetic model',
      vision: false,
      contextWindow: 64000,
      maxTokens: 4096,
    },
  ],
});
async function catalog(
  file: string,
  connections: ReturnType<typeof connection>[],
  selected: string,
) {
  const current = connections.find((item) => item.id === selected)!;
  await writeFile(
    file,
    JSON.stringify({
      apiKey: current.apiKey,
      model: `provider:${selected}:mock-model`,
      provider: selected,
      revision: 7,
      connections,
    }),
    { mode: 0o600 },
  );
}

test('a saved legacy link pins the selected official connection across model selection and restart', async () => {
  const { models, search } = await fixture();
  const connections = [
    connection('mock-first'),
    connection('deepseek-official'),
    connection('mock-selected', 'https://api.deepseek.com/v1/'),
  ];
  await catalog(models.file, connections, 'mock-selected');
  await savedLegacy(search, 'mock-selected');
  await search.status();
  expect(
    (JSON.parse(await readFile(search.file, 'utf8')) as { credential: { connection: string } })
      .credential.connection,
  ).toBe('mock-selected');
  await catalog(models.file, connections, 'mock-first');
  const restarted = new SearchSettings(search.file, models, {
    query: async (_provider, key) => {
      expect(key).toBe('synthetic-key-mock-selected');
      return { sources: [], truncated: false };
    },
  });
  await restarted.query(await restarted.capture(), 'synthetic lookup');
});
test('legacy resolution preserves official-ID priority while missing search files default keyless', async () => {
  const { models, search } = await fixture();
  await catalog(
    models.file,
    [
      connection('mock-first'),
      connection('deepseek-official'),
      connection('mock-chat', 'https://chat.example.test/v1'),
    ],
    'mock-chat',
  );
  expect((await models.searchConnection())?.id).toBe('deepseek-official');
  expect(await search.status()).toMatchObject({
    provider: 'bing',
    credentialConfigured: false,
  });
  for (const foreign of [
    { ...connection('mock-lookalike', 'https://foreign.example.test/v1'), name: 'DeepSeek' },
    { ...connection('mock-lookalike'), name: 'DeepSeek', api: 'anthropic-messages' },
  ]) {
    await rm(search.file);
    await catalog(models.file, [foreign], foreign.id);
    expect(await new SearchSettings(search.file, models).status()).toMatchObject({
      credentialConfigured: false,
      health: 'unchecked',
      provider: 'bing',
    });
  }
});
test('a later model configuration does not silently migrate an already initialized unconfigured search', async () => {
  const { models, search } = await fixture();
  expect(await search.status()).toMatchObject({ credentialConfigured: false });
  await writeFile(models.file, JSON.stringify({ apiKey: 'synthetic-later-model-key' }), {
    mode: 0o600,
  });
  expect(await search.status()).toMatchObject({ credentialConfigured: false });
});
test('legacy endpoint edits are blocked before any model request receives the replacement key', async () => {
  const { root } = await fixture();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'mock-model' }] }));
  const models = new ModelSettings(path.join(root, 'protected-model.json'), fetcher);
  const original = connection('mock-protected');
  await catalog(models.file, [original], original.id);
  const search = new SearchSettings(path.join(root, 'protected-search.json'), models);
  const { apiKey: _key, ...metadata } = original;
  await savedLegacy(search, original.id);
  await search.status();
  await expect(
    models.configure({
      requestId: 'mock-edit-endpoint',
      revision: 7,
      model: `provider:${original.id}:mock-model`,
      connection: { ...metadata, baseURL: 'https://foreign.example.test/v1' },
      apiKey: 'synthetic-replacement-key',
    }),
  ).rejects.toMatchObject({ code: 'SEARCH_LEGACY_IN_USE' });
  expect(fetcher).not.toHaveBeenCalled();
});
test('an externally invalidated legacy destination reports unavailable locally and never dispatches its key', async () => {
  const { models, search } = await fixture();
  const original = connection('mock-legacy');
  await catalog(models.file, [original], original.id);
  await savedLegacy(search, original.id);
  await search.status();
  await catalog(
    models.file,
    [{ ...original, baseURL: 'https://foreign.example.test/v1' }],
    original.id,
  );
  expect(await search.status()).toMatchObject({
    credentialSource: 'legacy-linked',
    health: 'unavailable',
    error: 'SEARCH_LEGACY_UNAVAILABLE',
  });
  const client = {
    query: vi.fn(async (): Promise<SearchResult> => ({ sources: [], truncated: false })),
  };
  const owner = new SearchSettings(search.file, models, client);
  const captured = await owner.capture();
  expect(captured.available).toBe(false);
  await expect(owner.query(captured, 'synthetic lookup')).rejects.toMatchObject({
    code: 'SEARCH_NOT_CONFIGURED',
  });
  expect(client.query).not.toHaveBeenCalled();
});
test('a legacy key rotation rejects captured and late results without changing the provider', async () => {
  const { models, search } = await fixture();
  await writeFile(models.file, JSON.stringify({ apiKey: 'synthetic-before-key' }), { mode: 0o600 });
  await savedLegacy(search);
  await search.status();
  let release: ((result: SearchResult) => unknown) | undefined;
  const response = new Promise<SearchResult>((resolve) => {
    release = resolve;
  });
  const client = { query: vi.fn(async () => response) };
  const owner = new SearchSettings(search.file, models, client);
  const captured = await owner.capture();
  const pending = owner.query(captured, 'synthetic lookup');
  await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(1));
  await writeFile(models.file, JSON.stringify({ apiKey: 'synthetic-after-key' }), { mode: 0o600 });
  release?.({ sources: [{ url: 'https://source.example.test/original' }], truncated: false });
  await expect(pending).rejects.toMatchObject({ code: 'SEARCH_CONFIG_CHANGED' });
  await expect(owner.query(captured, 'synthetic later')).rejects.toMatchObject({
    code: 'SEARCH_CONFIG_CHANGED',
  });
  expect(client.query).toHaveBeenCalledTimes(1);
  expect((await owner.capture()).provider).toBe('deepseek');
});
test('a successful later check clears the previous error and Retry-After', async () => {
  const { models, search } = await fixture();
  let rateLimited = true;
  const owner = new SearchSettings(search.file, models, {
    query: async () => {
      if (rateLimited) throw Object.assign(new Fault('SEARCH_RATE_LIMITED'), { retryAfter: 12 });
      return { sources: [], truncated: false };
    },
  });
  await owner.configure(update());
  const failed = await owner.check({
    requestId: 'mock-rate-limited',
    revision: 1,
    checkRevision: 0,
  });
  expect(failed.status).toMatchObject({
    health: 'rate-limited',
    error: 'SEARCH_RATE_LIMITED',
    retryAfter: 12,
  });
  rateLimited = false;
  const success = await owner.check({ requestId: 'mock-success', revision: 1, checkRevision: 1 });
  expect(success.status?.health).toBe('empty');
  expect(success.status?.error).toBeUndefined();
  expect(success.status?.retryAfter).toBeUndefined();
  const latest = await owner.status();
  expect(latest.error).toBeUndefined();
  expect(latest.retryAfter).toBeUndefined();
});
test('check IDs bind their fingerprint while pending and after settlement', async () => {
  const { models, search } = await fixture();
  let release: ((result: SearchResult) => unknown) | undefined;
  const response = new Promise<SearchResult>((resolve) => {
    release = resolve;
  });
  const client = { query: vi.fn(async () => response) };
  const owner = new SearchSettings(search.file, models, client);
  await owner.configure(update());
  const request = { requestId: 'mock-bound-check', revision: 1, checkRevision: 0 };
  const pending = owner.check(request);
  await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(1));
  await expect(owner.check({ ...request, checkRevision: 1 })).rejects.toMatchObject({
    code: 'SEARCH_REQUEST_CONFLICT',
  });
  release?.({ sources: [], truncated: false });
  await pending;
  await expect(owner.check({ ...request, checkRevision: 1 })).rejects.toMatchObject({
    code: 'SEARCH_REQUEST_CONFLICT',
  });
  expect(client.query).toHaveBeenCalledTimes(1);
});
test('hardlinked and oversized search files fail closed without replacing their bytes', async () => {
  const { root, models, search } = await fixture();
  await search.configure(update());
  await link(search.file, path.join(root, 'hardlink.json'));
  await expect(search.status()).rejects.toMatchObject({ code: 'SEARCH_CONFIG_UNAVAILABLE' });
  await rm(search.file);
  await writeFile(search.file, 'x'.repeat(65537), { mode: 0o600 });
  await expect(new SearchSettings(search.file, models).status()).rejects.toMatchObject({
    code: 'SEARCH_CONFIG_UNAVAILABLE',
  });
  expect((await readFile(search.file)).length).toBe(65537);
});
test('an atomic replacement failure preserves the prior configuration and receipt', async () => {
  const { root, search } = await fixture();
  const prior = await search.configure(update());
  const before = await readFile(search.file, 'utf8');
  writes.failRename = true;
  await expect(
    search.configure(
      update({ requestId: 'mock-failed-write', revision: 1, key: 'synthetic-uncommitted-key' }),
    ),
  ).rejects.toMatchObject({ code: 'SEARCH_CONFIG_UNAVAILABLE' });
  writes.failRename = false;
  expect(await readFile(search.file, 'utf8')).toBe(before);
  expect(await search.saved({ kind: 'configure', requestId: 'mock-save' })).toEqual(prior);
  expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
});
test('corrupt saved receipt counters are rejected rather than exposing impossible future state', async () => {
  const { models, search } = await fixture();
  await search.configure(update());
  const text = await readFile(search.file, 'utf8');
  const config = JSON.parse(text) as { receipt: { result: SearchReceipt } };
  const result = config.receipt.result;
  config.receipt.result = {
    ...result,
    revision: 999,
    status: { ...result.status!, revision: 999 },
  };
  await writeFile(search.file, JSON.stringify(config), { mode: 0o600 });
  await expect(new SearchSettings(search.file, models).status()).rejects.toMatchObject({
    code: 'SEARCH_CONFIG_UNAVAILABLE',
  });
});
test('public status rejects a Brave legacy reference and impossible disabled health', () => {
  const status = {
    revision: 1,
    checkRevision: 0,
    enabled: true,
    provider: 'brave',
    credentialConfigured: true,
    credentialSource: 'legacy-linked',
    health: 'unchecked',
  };
  expect(isSearchStatus(status)).toBe(false);
  expect(
    isSearchStatus({ ...status, credentialSource: 'independent', enabled: false, health: 'ready' }),
  ).toBe(false);
});

test('restart recovery does not attach an earlier rate-limit delay to an unknown claim', async () => {
  const { models, search } = await fixture();
  let release: ((result: SearchResult) => unknown) | undefined;
  const response = new Promise<SearchResult>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const owner = new SearchSettings(search.file, models, {
    query: async () => {
      if (++calls === 1) throw Object.assign(new Fault('SEARCH_RATE_LIMITED'), { retryAfter: 12 });
      return response;
    },
  });
  await owner.configure(update());
  await owner.check({ requestId: 'mock-earlier-rate-limit', revision: 1, checkRevision: 0 });
  const pending = owner.check({ requestId: 'mock-crashed-check', revision: 1, checkRevision: 1 });
  await vi.waitFor(() => expect(calls).toBe(2));
  try {
    const restarted = new SearchSettings(search.file, models);
    const status = await restarted.status();
    expect(status).toMatchObject({ health: 'unknown', error: 'SEARCH_OUTCOME_UNKNOWN' });
    expect(status.retryAfter).toBeUndefined();
  } finally {
    release?.({ sources: [], truncated: false });
    await pending;
  }
});

async function disabledLegacy() {
  const { root } = await fixture();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'mock-model' }] }));
  const models = new ModelSettings(path.join(root, 'linked-models.json'), fetcher);
  const original = connection('mock-linked-model');
  await catalog(models.file, [original], original.id);
  const client = {
    query: vi.fn(async (): Promise<SearchResult> => ({ sources: [], truncated: false })),
  };
  const search = new SearchSettings(path.join(root, 'linked-search.json'), models, client);
  await savedLegacy(search, original.id);
  await search.status();
  await search.configure(
    update({
      requestId: 'mock-disable-legacy',
      revision: 0,
      provider: 'deepseek',
      enabled: false,
      key: undefined,
    }),
  );
  const { apiKey: _key, ...metadata } = original;
  const edit = {
    requestId: 'mock-change-linked-destination',
    revision: 7,
    model: `provider:${original.id}:mock-model`,
    connection: { ...metadata, baseURL: 'https://foreign.example.test/v1' },
    apiKey: 'synthetic-authorized-model-replacement',
  };
  return { models, search, client, fetcher, edit };
}

test('reenabling a changed legacy destination requires an independent replacement without modifying its saved receipt', async () => {
  const { models, search, client, edit } = await disabledLegacy();
  await models.configure(edit);
  const before = await readFile(search.file, 'utf8');
  const receipt = await search.saved({ kind: 'configure', requestId: 'mock-disable-legacy' });
  await expect(
    search.configure(
      update({
        requestId: 'mock-invalid-reenable',
        revision: 1,
        provider: 'deepseek',
        key: undefined,
      }),
    ),
  ).rejects.toMatchObject({ code: 'SEARCH_CREDENTIAL_REQUIRED' });
  expect(await readFile(search.file, 'utf8')).toBe(before);
  expect(await search.saved({ kind: 'configure', requestId: 'mock-disable-legacy' })).toEqual(
    receipt,
  );
  expect(await search.status()).toMatchObject({
    revision: 1,
    enabled: false,
    credentialSource: 'legacy-linked',
  });
  const replaced = await search.configure(
    update({
      requestId: 'mock-independent-reenable',
      revision: 1,
      provider: 'deepseek',
      key: 'synthetic-independent-replacement',
    }),
  );
  expect(replaced).toMatchObject({
    revision: 2,
    status: { enabled: true, credentialSource: 'independent', health: 'unchecked' },
  });
  expect(client.query).not.toHaveBeenCalled();
});

test('a model destination commit and concurrent legacy reenable cannot both accept an invalid enabled reference', async () => {
  const { models, search, client, edit } = await disabledLegacy();
  let entered: (() => unknown) | undefined;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release: (() => unknown) | undefined;
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  writes.heldRename = { file: models.file, entered: () => entered?.(), release: held, skip: 1 };
  const modelChange = models.configure(edit);
  await started;
  const enabling = search.configure(
    update({
      requestId: 'mock-concurrent-reenable',
      revision: 1,
      provider: 'deepseek',
      key: undefined,
    }),
  );
  // The old check-only hook can settle here; an atomic wrapper keeps this queued until the held model rename finishes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      enabling.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    release?.();
  }
  const [modelResult, searchResult] = await Promise.allSettled([modelChange, enabling]);
  expect(modelResult.status).toBe('fulfilled');
  expect(searchResult).toMatchObject({
    status: 'rejected',
    reason: { code: 'SEARCH_CREDENTIAL_REQUIRED' },
  });
  expect(await search.status()).toMatchObject({
    revision: 1,
    enabled: false,
    credentialSource: 'legacy-linked',
  });
  expect(client.query).not.toHaveBeenCalled();
});

test('a model probe releases search ownership and a newly enabled legacy reference becomes a known failed model receipt', async () => {
  const { models, search, fetcher, edit } = await disabledLegacy();
  const scope = (await models.status(true)).modelAccess!.scope;
  let entered = () => {};
  const started = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release = () => {};
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  fetcher.mockImplementation(async () => {
    entered();
    await gate;
    return Response.json({ data: [{ id: 'mock-model' }] });
  });
  const pending = models.configure(edit);
  const refused = expect(pending).rejects.toMatchObject({ code: 'SEARCH_LEGACY_IN_USE' });
  await started;
  try {
    await search.configure(
      update({
        requestId: 'mock-enable-during-probe',
        revision: 1,
        provider: 'deepseek',
        key: undefined,
      }),
    );
  } finally {
    release();
  }
  await refused;
  const receipt = await models.saved({
    scope,
    requestId: edit.requestId,
    revision: edit.revision,
    connection: edit.connection.id,
    model: edit.model,
  });
  expect(receipt).toMatchObject({
    phase: 'failed',
    error: 'SEARCH_LEGACY_IN_USE',
    current: { revision: 7 },
  });
  await expect(models.configure(edit)).rejects.toMatchObject({ code: 'SEARCH_LEGACY_IN_USE' });
  const restarted = new ModelSettings(models.file, fetcher);
  await expect(restarted.configure(edit)).rejects.toMatchObject({ code: 'SEARCH_LEGACY_IN_USE' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('the last model disconnect records the active legacy search reference and only an independent replacement permits a new removal', async () => {
  const { models, search } = await fixture();
  await writeFile(
    models.file,
    JSON.stringify({ apiKey: 'synthetic-last-model-key', revision: 1 }),
    {
      mode: 0o600,
    },
  );
  await savedLegacy(search);
  await search.status();
  const request = {
    scope: (await models.status(true)).modelAccess!.scope,
    requestId: 'mock-linked-last-disconnect',
    revision: 1,
    connection: 'deepseek-official',
    disconnect: true,
  };
  const refused = await models.remove(request);
  expect(refused).toMatchObject({
    phase: 'failed',
    error: 'MODEL_CONNECTION_REFERENCED',
    references: ['search'],
    current: { configured: true, revision: 1 },
  });
  await search.configure(update());
  expect(await models.remove(request)).toEqual(refused);
  expect(
    await models.remove({ ...request, requestId: 'mock-independent-last-disconnect' }),
  ).toMatchObject({
    phase: 'committed',
    current: { configured: false, revision: 2 },
  });
});

test('an independent search key does not retain an unrelated official model but canonical references still refuse its removal', async () => {
  const { models, search } = await fixture();
  const official = connection('mock-search-official');
  const selected = connection('mock-default', 'https://model.example.test/v1');
  await catalog(models.file, [official, selected], selected.id);
  await search.status();
  await search.configure(update());
  const request = {
    scope: (await models.status(true)).modelAccess!.scope,
    requestId: 'mock-remove-running-official',
    revision: 7,
    connection: official.id,
  };
  const unregister = models.registerReferences(async () => ['running']);
  expect(await models.remove(request)).toMatchObject({
    phase: 'failed',
    references: ['running'],
  });
  unregister();
  expect(
    await models.remove({ ...request, requestId: 'mock-remove-independent-official' }),
  ).toMatchObject({
    phase: 'committed',
    current: { revision: 8, provider: selected.id },
  });
});

test('a last model disconnect holds search ownership through durable removal before a legacy enable can be accepted', async () => {
  const { models, search } = await disabledLegacy();
  const request = {
    scope: (await models.status(true)).modelAccess!.scope,
    requestId: 'mock-last-model-removal-race',
    revision: 7,
    connection: 'mock-linked-model',
    disconnect: true,
  };
  let entered = () => {};
  const started = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release = () => {};
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  writes.heldRename = { file: models.file, entered, release: gate };
  const removing = models.remove(request);
  await started;
  const enabling = search.configure(
    update({
      requestId: 'mock-enable-during-remove',
      revision: 1,
      provider: 'deepseek',
      key: undefined,
    }),
  );
  const enabled = enabling.then(
    () => undefined,
    (error: unknown) => error,
  );
  await new Promise<unknown>((resolve) => setTimeout(resolve, 30));
  release();
  expect(await removing).toMatchObject({ phase: 'committed' });
  expect(await enabled).toMatchObject({ code: 'SEARCH_CREDENTIAL_REQUIRED' });
  expect(await search.status()).toMatchObject({ enabled: false, revision: 1 });
});

test('captured fallback model credentials and binding do not inherit a search route annotation', async () => {
  const { models } = await fixture();
  const primary = connection('mock-primary', 'https://primary.example.test/v1');
  const backup = connection('mock-backup', 'https://backup.example.test/v1');
  await catalog(models.file, [primary, backup], primary.id);
  await models.fallback({
    scope: (await models.status(true)).modelAccess!.scope,
    requestId: 'mock-select-backup',
    revision: 7,
    model: `provider:${backup.id}:mock-model`,
  });
  const captured = await models.capture();
  expect(captured.fallback).not.toHaveProperty('searchApiKey');
  expect(captured.fallback?.binding).toBe(
    (await models.resolve(`provider:${backup.id}:mock-model`)).binding,
  );
});

test('a model edit enters the search owner before any probe or credential commit', async () => {
  const { root } = await fixture();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'mock-model' }] }));
  const models = new ModelSettings(path.join(root, 'guarded-model.json'), fetcher);
  const original = connection('mock-guarded');
  await catalog(models.file, [original], original.id);
  models.withConnectionChange = async () => {
    throw new Fault('SEARCH_LEGACY_IN_USE');
  };
  const { apiKey: _key, ...metadata } = original;
  await expect(
    models.configure({
      requestId: 'mock-guarded-edit',
      revision: 7,
      model: `provider:${original.id}:mock-model`,
      connection: { ...metadata, baseURL: 'https://foreign.example.test/v1' },
      apiKey: 'synthetic-replacement-key',
    }),
  ).rejects.toMatchObject({ code: 'SEARCH_LEGACY_IN_USE' });
  expect(fetcher).not.toHaveBeenCalled();
});
