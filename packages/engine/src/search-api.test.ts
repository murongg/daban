import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSearchReceipt,
  isSearchStatus,
  managedProtocol,
  type SearchResult,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { secureDirectory } from './private-files.js';
import { SearchClient } from './search.js';
import { startPrototype } from './server.js';

async function fixture(corrupt = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-search-api-'));
  // Match Host boot: validate the private root before publishing any control token.
  await secureDirectory(root);
  const modelDir = path.join(root, 'model');
  if (corrupt) {
    await mkdir(modelDir, { mode: 0o700 });
    await writeFile(path.join(modelDir, 'search.json'), 'SYNTHETIC CORRUPT SEARCH', {
      mode: 0o600,
    });
  }
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const call = async (
    action: string,
    input?: unknown,
    options: { method?: string; token?: string; query?: string; signal?: AbortSignal } = {},
  ) => {
    const method = options.method ?? (action === 'status' ? 'GET' : 'POST');
    const response = await fetch(`${app.url}/api/search/${action}${options.query ?? ''}`, {
      method,
      headers: {
        'x-prototype-token': options.token ?? app.token,
        'content-type': 'application/json',
        'x-daban-client-protocol': String(managedProtocol),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }),
      signal: options.signal,
    });
    return { status: response.status, value: (await response.json()) as unknown };
  };
  return {
    app,
    root,
    call,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('search HTTP advertises capability, authenticates and closes method/query/body contracts without probing', async () => {
  const query = vi
    .spyOn(SearchClient.prototype, 'query')
    .mockResolvedValue({ sources: [], truncated: false });
  const f = await fixture();
  try {
    const advertised: unknown = await (
      await fetch(`${f.app.url}/api/state`, { headers: { 'x-prototype-token': f.app.token } })
    ).json();
    expect(advertised).toHaveProperty('searchSettings', true);
    const first = await f.call('status');
    expect(first.status).toBe(200);
    expect(isSearchStatus(first.value)).toBe(true);
    expect((await f.call('status', undefined, { token: 'synthetic-denied' })).status).toBe(403);
    for (const action of ['status', 'configure', 'check', 'saved']) {
      expect(
        (await f.call(action, {}, { method: action === 'status' ? 'POST' : 'GET' })).status,
      ).toBe(405);
      expect((await f.call(action, {}, { query: '?extra=1' })).status).toBe(400);
    }
    const input = {
      requestId: 'mock-configure',
      revision: 0,
      enabled: true,
      provider: 'brave',
      key: 'synthetic-api-key',
    };
    for (const extra of [
      { endpoint: 'https://attacker.example.test' },
      { actor: 'mock-other' },
      { type: 'search.check' },
    ])
      expect((await f.call('configure', { ...input, ...extra })).status).toBe(400);
    const saved = await f.call('configure', input);
    expect(saved.status).toBe(200);
    expect(isSearchReceipt(saved.value)).toBe(true);
    expect(saved.value).toMatchObject({
      kind: 'configure',
      requestId: input.requestId,
      phase: 'saved',
      revision: 1,
    });
    expect(JSON.stringify(saved.value)).not.toContain(input.key);
    expect(await f.call('saved', { kind: 'configure', requestId: input.requestId })).toStrictEqual(
      saved,
    );
    expect(
      (
        await f.call('check', {
          requestId: 'mock-check',
          revision: 1,
          checkRevision: 0,
          provider: 'deepseek',
        })
      ).status,
    ).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(f.app.models!.jobs.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('duplicate HTTP checks share one paid dispatch and expose their claimed and settled receipt', async () => {
  let release: (value: SearchResult) => unknown = () => {};
  const query = vi.spyOn(SearchClient.prototype, 'query').mockImplementation(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = await fixture();
  try {
    await f.call('configure', {
      requestId: 'mock-configure',
      revision: 0,
      enabled: true,
      provider: 'brave',
      key: 'synthetic-api-key',
    });
    const input = { requestId: 'mock-check', revision: 1, checkRevision: 0 };
    const first = f.call('check', input);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const duplicate = f.call('check', input);
    const claimed = await f.call('saved', { kind: 'check', requestId: input.requestId });
    expect(claimed.value).toMatchObject({ phase: 'claimed', revision: 1, checkRevision: 1 });
    release({ sources: [], truncated: false });
    const result = await first;
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ phase: 'settled', status: { health: 'empty' } });
    expect(await duplicate).toStrictEqual(result);
    expect(await f.call('saved', { kind: 'check', requestId: input.requestId })).toStrictEqual(
      result,
    );
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    release({ sources: [], truncated: false });
    await f.close();
  }
});

test('disconnecting the check requester leaves the accepted Host operation running for receipt recovery', async () => {
  let release: (value: SearchResult) => unknown = () => {};
  const query = vi.spyOn(SearchClient.prototype, 'query').mockImplementation(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const f = await fixture();
  try {
    await f.call('configure', {
      requestId: 'mock-configure',
      revision: 0,
      enabled: true,
      provider: 'brave',
      key: 'synthetic-api-key',
    });
    const input = { requestId: 'mock-check-disconnected', revision: 1, checkRevision: 0 };
    const abort = new AbortController();
    const pending = f.call('check', input, { signal: abort.signal });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(pending).rejects.toThrow();
    release({ sources: [], truncated: false });
    await vi.waitFor(async () =>
      expect(
        (await f.call('saved', { kind: 'check', requestId: input.requestId })).value,
      ).toMatchObject({ phase: 'settled', status: { health: 'empty' } }),
    );
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    release({ sources: [], truncated: false });
    await f.close();
  }
});

test('a corrupt search file leaves ordinary Host state available and remains untouched', async () => {
  const f = await fixture(true);
  try {
    const response = await fetch(`${f.app.url}/api/state`, {
      headers: { 'x-prototype-token': f.app.token },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('searchSettings', true);
    expect(await f.call('status')).toStrictEqual({
      status: 503,
      value: { error: 'SEARCH_CONFIG_UNAVAILABLE' },
    });
    expect(await readFile(path.join(f.root, 'model/search.json'), 'utf8')).toBe(
      'SYNTHETIC CORRUPT SEARCH',
    );
  } finally {
    await f.close();
  }
});

test('recovery permits local search status and receipts while fencing saves and paid checks', async () => {
  const f = await fixture();
  try {
    expect.assert(f.app.recovery);
    vi.spyOn(f.app.recovery, 'admit').mockReturnValue(false);
    vi.spyOn(f.app.recovery, 'enter').mockImplementation(() => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    expect((await f.call('status')).status).toBe(200);
    expect((await f.call('saved', { kind: 'check', requestId: 'mock-unknown' })).status).toBe(200);
    for (const action of ['configure', 'check'])
      expect(await f.call(action, {})).toStrictEqual({
        status: 409,
        value: { error: 'RUNTIME_RECOVERY_PENDING' },
      });
  } finally {
    await f.close();
  }
});
