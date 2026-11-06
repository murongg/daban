import {
  disconnected,
  type RuntimeCommand,
  type RuntimeSnapshot,
  type SearchReceipt,
  type SearchStatus,
  type SearchUpdate,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const status: SearchStatus = {
  revision: 2,
  checkRevision: 4,
  enabled: true,
  provider: 'brave',
  credentialConfigured: true,
  credentialSource: 'independent',
  health: 'unchecked',
};
const update: SearchUpdate = {
  requestId: 'mock-search-save',
  revision: 1,
  enabled: true,
  provider: 'brave',
  key: 'synthetic-search-secret',
};
const configured: SearchReceipt = {
  kind: 'configure',
  requestId: update.requestId,
  phase: 'saved',
  revision: 2,
  checkRevision: 4,
  status,
};
const check = { requestId: 'mock-search-check', revision: 2, checkRevision: 4 };
const checked: SearchReceipt = {
  kind: 'check',
  requestId: check.requestId,
  phase: 'settled',
  revision: 2,
  checkRevision: 5,
  status: { ...status, checkRevision: 5, health: 'ready', checkedAt: '2026-01-02T00:00:00.000Z' },
};
const commands: RuntimeCommand[] = [
  { type: 'search.status' },
  { type: 'search.configure', input: update },
  { type: 'search.check', input: check },
  { type: 'search.saved', query: { kind: 'configure', requestId: update.requestId } },
];

function fixture(value: unknown = configured) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(value));
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot: RuntimeSnapshot = { ...disconnected('ready'), searchSettings: true };
  vi.spyOn(runtime, 'status').mockResolvedValue(snapshot);
  return { runtime, fetcher, snapshot };
}

test('search IPC accepts only its closed public command contract', () => {
  for (const command of commands) {
    expect(parseCommand(command)).toStrictEqual(command);
    expect(() => parseCommand({ ...command, owner: 'mock-other' })).toThrow('INVALID_COMMAND');
  }
  for (const command of [
    { type: 'search.configure', input: { ...update, endpoint: 'https://attacker.example.test' } },
    { type: 'search.configure', input: { ...update, provider: 'custom' } },
    { type: 'search.check', input: { ...check, key: 'synthetic-forged' } },
    { type: 'search.check', input: { ...check, checkRevision: -1 } },
    { type: 'search.saved', query: { kind: 'check', requestId: '../mock-other' } },
    { type: 'search.query', query: 'model RPC is private' },
  ])
    expect(() => parseCommand(command)).toThrow('INVALID_COMMAND');
});

test('every search command requires its explicit capability and an online Host before any request', async () => {
  for (const command of commands) {
    const old = fixture();
    delete old.snapshot.searchSettings;
    old.snapshot.protocolVersion = 999;
    await expect(old.runtime.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
    expect(old.fetcher).not.toHaveBeenCalled();
    const offline = fixture();
    offline.snapshot.phase = 'offline';
    await expect(offline.runtime.invoke(command)).rejects.toThrow('RUNTIME_OFFLINE');
    expect(offline.fetcher).not.toHaveBeenCalled();
  }
});

test('search status uses a local GET and rejects secret-bearing or malformed public projections', async () => {
  const current = fixture(status);
  expect(await current.runtime.invoke(commands[0])).toStrictEqual(status);
  expect(current.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:18766/api/search/status');
  expect(current.fetcher.mock.calls[0][1]?.method).toBe('GET');
  for (const value of [
    { ...status, key: update.key },
    { ...status, provider: 'custom' },
  ])
    await expect(fixture(value).runtime.invoke(commands[0])).rejects.toThrow(
      'INVALID_RUNTIME_STATE',
    );
});

test('configure sends its exact captured intent once and validates the original acknowledgement', async () => {
  const current = fixture();
  let release: (value: typeof current.snapshot) => unknown = () => {};
  vi.spyOn(current.runtime, 'status').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const mutable = { ...update };
  const pending = current.runtime.invoke({ type: 'search.configure', input: mutable });
  mutable.provider = 'deepseek';
  mutable.key = 'synthetic-late-edit';
  release(current.snapshot);
  expect(await pending).toStrictEqual(configured);
  expect(current.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toStrictEqual(update);
  for (const value of [
    { ...configured, requestId: 'mock-other' },
    { ...configured, revision: 3, status: { ...status, revision: 3 } },
    { ...configured, status: { ...status, provider: 'deepseek' } },
    { ...configured, status: { ...status, enabled: false, health: 'disabled' } },
    { ...configured, key: update.key },
  ])
    await expect(fixture(value).runtime.invoke(commands[1])).rejects.toThrow(
      'INVALID_RUNTIME_STATE',
    );
});

test('check binds its request and both revisions without confusing a later current configuration', async () => {
  const current = fixture(checked);
  expect(await current.runtime.invoke(commands[2])).toStrictEqual(checked);
  expect(current.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:18766/api/search/check');
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toStrictEqual(check);
  for (const value of [
    { ...checked, requestId: 'mock-other' },
    { ...checked, revision: 3, status: { ...checked.status!, revision: 3 } },
    { ...checked, checkRevision: 6, status: { ...checked.status!, checkRevision: 6 } },
    { ...configured, requestId: check.requestId },
  ])
    await expect(fixture(value).runtime.invoke(commands[2])).rejects.toThrow(
      'INVALID_RUNTIME_STATE',
    );
  const unknown = {
    ...checked,
    phase: 'unknown',
    status: { ...checked.status!, health: 'unknown', error: 'SEARCH_OUTCOME_UNKNOWN' },
  };
  expect(await fixture(unknown).runtime.invoke(commands[2])).toStrictEqual(unknown);
});

test('saved queries bind kind and ID and accept superseded without resubmitting configuration', async () => {
  const current = fixture();
  expect(await current.runtime.invoke(commands[3])).toStrictEqual(configured);
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toStrictEqual({
    kind: 'configure',
    requestId: update.requestId,
  });
  expect(current.fetcher).toHaveBeenCalledTimes(1);
  const superseded = { kind: 'configure', requestId: update.requestId, phase: 'superseded' };
  expect(await fixture(superseded).runtime.invoke(commands[3])).toStrictEqual(superseded);
  for (const value of [{ ...configured, requestId: 'mock-other' }, checked])
    await expect(fixture(value).runtime.invoke(commands[3])).rejects.toThrow(
      'INVALID_RUNTIME_STATE',
    );
});

test('an ambiguous check or save is never automatically sent again after an authentication change', async () => {
  for (const command of [commands[1], commands[2]]) {
    const current = fixture();
    current.fetcher.mockResolvedValue(Response.json({ error: 'UNAUTHORIZED' }, { status: 403 }));
    await expect(current.runtime.invoke(command)).rejects.toThrow('RUNTIME_SESSION_CHANGED');
    expect(current.fetcher).toHaveBeenCalledTimes(1);
  }
});

test('recovery allows status and original receipts but blocks configuration changes and paid checks', async () => {
  for (const command of [commands[1], commands[2]]) {
    const current = fixture();
    current.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
    await expect(current.runtime.invoke(command)).rejects.toThrow('RUNTIME_RECOVERY_PENDING');
    expect(current.fetcher).not.toHaveBeenCalled();
  }
  const current = fixture();
  current.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
  expect(await current.runtime.invoke(commands[3])).toStrictEqual(configured);
});

test('ordinary status polling projects capability only and never calls the search service', async () => {
  const requests: string[] = [];
  const settings = {
    configured: false,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    revision: 0,
  };
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) => {
      requests.push(url);
      return Response.json(
        url.endsWith('/api/model/settings')
          ? settings
          : {
              clientProtocol: 18,
              mode: 'agent',
              computerError: 'COMPUTER_START_FAILED',
              sharedLogin: false,
              viewport: { width: 1280, height: 800 },
              bots: {},
              model: { ...settings, available: true, bots: {} },
              searchSettings: true,
            },
      );
    },
  });
  expect(await runtime.status()).toMatchObject({ phase: 'ready', searchSettings: true });
  expect(requests).toHaveLength(2);
  expect(requests.every((url) => !url.includes('/api/search/'))).toBe(true);
});
