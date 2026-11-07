import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SearchResult } from '@daban/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-health-'));
  roots.push(root);
  const models = new ModelSettings(path.join(root, 'models.json'));
  const query = vi.fn<() => Promise<SearchResult>>(async () => ({
    sources: [{ url: 'https://source.example.test/' }],
    truncated: false,
  }));
  const search = new SearchSettings(path.join(root, 'search.json'), models, { query });
  await search.configure({
    requestId: 'mock-keyless',
    revision: 0,
    enabled: true,
    provider: 'duckduckgo',
  });
  return { search, models, query, capture: await search.capture() };
}

test('an actual task failure replaces a previous successful check and survives reopening without altering its receipt', async () => {
  const f = await fixture();
  const check = await f.search.check({ requestId: 'mock-check', revision: 1, checkRevision: 0 });
  f.query.mockRejectedValueOnce(new Fault('SEARCH_FORBIDDEN', 403));
  await expect(f.search.query(f.capture, 'synthetic task query')).rejects.toMatchObject({
    code: 'SEARCH_FORBIDDEN',
  });
  const status = await f.search.status();
  expect(status).toMatchObject({ health: 'forbidden', error: 'SEARCH_FORBIDDEN' });
  expect(status.checkRevision).toBeGreaterThan(check.checkRevision!);
  expect(await f.search.saved({ kind: 'check', requestId: 'mock-check' })).toEqual(check);
  const reopened = new SearchSettings(f.search.file, f.models, { query: f.query });
  expect(await reopened.status()).toEqual(status);
  await reopened.query(await reopened.capture(), 'synthetic later query');
  expect(await reopened.status()).toMatchObject({ health: 'ready' });
  expect((await reopened.status()).error).toBeUndefined();
});

test('a late older task cannot clear a newer task failure', async () => {
  const f = await fixture();
  let finish: (result: SearchResult) => unknown = () => {};
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const older = f.search.query(f.capture, 'synthetic older');
  await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  f.query.mockRejectedValueOnce(new Fault('SEARCH_FORBIDDEN', 403));
  await expect(f.search.query(f.capture, 'synthetic newer')).rejects.toMatchObject({
    code: 'SEARCH_FORBIDDEN',
  });
  finish({ sources: [], truncated: false });
  await older;
  expect(await f.search.status()).toMatchObject({ health: 'forbidden', error: 'SEARCH_FORBIDDEN' });
});

test('an older check settles its own receipt without replacing a newer task failure', async () => {
  const f = await fixture();
  let finish: (result: SearchResult) => unknown = () => {};
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.search.check({ requestId: 'mock-late-check', revision: 1, checkRevision: 0 });
  await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  f.query.mockRejectedValueOnce(new Fault('SEARCH_RATE_LIMITED', 429));
  await expect(f.search.query(f.capture, 'synthetic newer')).rejects.toMatchObject({
    code: 'SEARCH_RATE_LIMITED',
  });
  finish({ sources: [], truncated: false });
  expect(await pending).toMatchObject({ phase: 'settled', status: { health: 'empty' } });
  expect(await f.search.status()).toMatchObject({
    health: 'rate-limited',
    error: 'SEARCH_RATE_LIMITED',
  });
});

test('a retired configuration and cancelled task never publish provider health', async () => {
  const f = await fixture();
  const before = await f.search.status();
  f.query.mockRejectedValueOnce(new Fault('SEARCH_CANCELLED'));
  await expect(f.search.query(f.capture, 'synthetic cancelled')).rejects.toMatchObject({
    code: 'SEARCH_CANCELLED',
  });
  expect(await f.search.status()).toEqual(before);
  await f.search.configure({
    requestId: 'mock-disable',
    revision: 1,
    enabled: false,
    provider: 'duckduckgo',
  });
  await expect(f.search.query(f.capture, 'synthetic retired')).rejects.toMatchObject({
    code: 'SEARCH_CONFIG_CHANGED',
  });
  expect(await f.search.status()).toMatchObject({ health: 'disabled' });
});

test('recovering an interrupted older check retains the newer task diagnosis', async () => {
  const f = await fixture();
  let finish: (result: SearchResult) => unknown = () => {};
  f.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.search.check({
    requestId: 'mock-interrupted-check',
    revision: 1,
    checkRevision: 0,
  });
  await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(1));
  f.query.mockRejectedValueOnce(new Fault('SEARCH_FORBIDDEN', 403));
  await expect(f.search.query(f.capture, 'synthetic newer failure')).rejects.toMatchObject({
    code: 'SEARCH_FORBIDDEN',
  });
  const reopened = new SearchSettings(f.search.file, f.models, { query: f.query });
  expect(await reopened.status()).toMatchObject({ health: 'forbidden', error: 'SEARCH_FORBIDDEN' });
  expect(
    await reopened.saved({ kind: 'check', requestId: 'mock-interrupted-check' }),
  ).toMatchObject({ phase: 'unknown' });
  finish({ sources: [], truncated: false });
  expect(await pending).toMatchObject({ phase: 'unknown' });
  expect(await reopened.status()).toMatchObject({ health: 'forbidden' });
});
