import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSearchProvider,
  isSearchStatus,
  isSearchUpdate,
  type SearchProvider,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

const provider = 'duckduckgo' as SearchProvider;
test('the public contract accepts credential-free DuckDuckGo and rejects mismatched credentials', () => {
  const status = {
    revision: 0,
    checkRevision: 0,
    enabled: true,
    provider,
    credentialConfigured: false,
    credentialSource: 'none',
    health: 'unchecked',
  };
  expect(isSearchProvider(provider)).toBe(true);
  expect(isSearchStatus(status)).toBe(true);
  expect(isSearchStatus({ ...status, health: 'ready' })).toBe(true);
  expect(isSearchStatus({ ...status, health: 'unconfigured' })).toBe(false);
  expect(
    isSearchStatus({ ...status, credentialConfigured: true, credentialSource: 'independent' }),
  ).toBe(false);
  expect(
    isSearchUpdate({ requestId: 'synthetic-default', revision: 0, enabled: true, provider }),
  ).toBe(true);
  expect(
    isSearchUpdate({
      requestId: 'synthetic-default',
      revision: 0,
      enabled: true,
      provider,
      key: 'synthetic-secret',
    }),
  ).toBe(false);
});

test('missing search configuration defaults to Bing even with an existing official model key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-keyless-default-'));
  try {
    const models = new ModelSettings(path.join(root, 'models.json'));
    await models.save({ apiKey: 'synthetic-inference-key' });
    const linked = vi.spyOn(models, 'searchConnection');
    const query = vi.fn(async () => ({ sources: [], truncated: false }));
    const search = new SearchSettings(path.join(root, 'search.json'), models, { query });
    expect(await search.status()).toMatchObject({
      enabled: true,
      provider: 'bing',
      health: 'unchecked',
      credentialConfigured: false,
      credentialSource: 'none',
    });
    expect((await search.capture()).available).toBe(true);
    expect(linked).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('switching from Brave removes its key and keyless checks use the original single receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-keyless-settings-'));
  try {
    const models = new ModelSettings(path.join(root, 'models.json'));
    const query = vi.fn(async () => ({ sources: [], truncated: false }));
    const search = new SearchSettings(path.join(root, 'search.json'), models, { query });
    await search.configure({
      requestId: 'synthetic-brave',
      revision: 0,
      enabled: true,
      provider: 'brave',
      key: 'synthetic-brave-key',
    });
    await search.configure({ requestId: 'synthetic-duck', revision: 1, enabled: true, provider });
    expect(await readFile(search.file, 'utf8')).not.toContain('synthetic-brave-key');
    expect(query).not.toHaveBeenCalled();
    const input = { requestId: 'synthetic-check', revision: 2, checkRevision: 0 };
    const [first, second] = await Promise.all([search.check(input), search.check(input)]);
    expect(first).toEqual(second);
    expect(first.status?.health).toBe('empty');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      provider,
      '',
      'synthetic search connectivity test',
      undefined,
      5,
      expect.any(Function),
    ]);
    await expect(
      search.configure({
        requestId: 'synthetic-back',
        revision: 2,
        enabled: true,
        provider: 'brave',
      }),
    ).rejects.toMatchObject({ code: 'SEARCH_CREDENTIAL_REQUIRED' });
    const reopened = new SearchSettings(search.file, models, { query });
    expect(await reopened.status()).toMatchObject({
      provider,
      health: 'empty',
      credentialConfigured: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['deepseek', 'brave'] as const)(
  'a saved %s provider failure never switches to keyless DuckDuckGo',
  async (selected) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-no-search-fallback-'));
    try {
      const { Fault } = await import('./control.js');
      const models = new ModelSettings(path.join(root, 'models.json'));
      const query = vi.fn(async () => {
        throw new Fault('SEARCH_UNAVAILABLE', 503);
      });
      const search = new SearchSettings(path.join(root, 'search.json'), models, { query });
      await search.configure({
        requestId: 'synthetic-provider-choice',
        revision: 0,
        enabled: true,
        provider: selected,
        key: 'synthetic-selected-key',
      });
      const before = await search.capture();
      await expect(search.query(await search.capture(), 'synthetic')).rejects.toMatchObject({
        code: 'SEARCH_UNAVAILABLE',
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]).toEqual([
        selected,
        'synthetic-selected-key',
        'synthetic',
        undefined,
        5,
        expect.any(Function),
      ]);
      expect(await new SearchSettings(search.file, models, { query }).status()).toMatchObject({
        provider: selected,
      });
      expect(await search.capture()).toEqual(before);
      expect(await search.status()).toMatchObject({
        health: 'unavailable',
        error: 'SEARCH_UNAVAILABLE',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('an old auto-created empty DeepSeek configuration adopts the keyless default without a request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-empty-search-upgrade-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const models = new ModelSettings(path.join(root, 'models.json'));
    const file = path.join(root, 'search.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        revision: 0,
        checkRevision: 0,
        enabled: true,
        provider: 'deepseek',
      }),
      { mode: 0o600 },
    );
    const query = vi.fn(async () => ({ sources: [], truncated: false }));
    const search = new SearchSettings(file, models, { query });
    expect(await search.status()).toMatchObject({
      provider: 'bing',
      revision: 1,
      health: 'unchecked',
      credentialConfigured: false,
    });
    expect((await search.capture()).available).toBe(true);
    expect(query).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { provider: 'deepseek', revision: 2, enabled: true },
  { provider: 'deepseek', revision: 0, enabled: false },
  { provider: 'brave', revision: 0, enabled: true },
] as const)(
  'stored provider or disabled choices are not replaced by a keyless default: %j',
  async (choice) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-saved-search-choice-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      const models = new ModelSettings(path.join(root, 'models.json'));
      const file = path.join(root, 'search.json');
      const bytes = JSON.stringify({ version: 1, checkRevision: 0, ...choice });
      await writeFile(file, bytes, { mode: 0o600 });
      const search = new SearchSettings(file, models);
      expect(await search.status()).toMatchObject(choice);
      expect((await search.capture()).available).toBe(false);
      expect(await readFile(file, 'utf8')).toBe(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('an existing DuckDuckGo choice remains selected when Bing becomes the new-user default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-preserved-duckduckgo-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const models = new ModelSettings(path.join(root, 'models.json'));
    const file = path.join(root, 'search.json');
    const bytes = JSON.stringify({
      version: 1,
      revision: 0,
      checkRevision: 0,
      enabled: true,
      provider: 'duckduckgo',
    });
    await writeFile(file, bytes, { mode: 0o600 });
    const search = new SearchSettings(file, models);
    expect(await search.status()).toMatchObject({ provider: 'duckduckgo', health: 'unchecked' });
    expect(await readFile(file, 'utf8')).toBe(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
