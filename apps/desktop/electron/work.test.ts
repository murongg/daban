import { disconnected, type RuntimeSnapshot, recoveryReader } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const request = {
  id: 'mock-human-create',
  item: 'mock-shared-work',
  action: 'create',
  revision: 0,
  value: { title: '合成共享待办', description: '', progress: '', status: 'todo' },
};
const actor = { kind: 'human' };
const item = {
  id: request.item,
  ...request.value,
  revision: 2,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  createdBy: actor,
  updatedBy: { kind: 'bot', bot: 'mock-alpha' },
};
const complete = {
  state: 'complete',
  request,
  actor,
  acceptedRevision: 1,
  acceptedAt: '2026-01-01T00:00:00Z',
  item,
};
function client(value: unknown = complete, protocol = 36) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(value));
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.work = { available: true, revision: 2, count: 1 };
  vi.spyOn(runtime, 'status').mockResolvedValue(snapshot);
  return { runtime, fetcher, snapshot };
}

it('closes shared-work IPC commands and permits only local readers during recovery', () => {
  const commands = [
    { type: 'work.list', query: {} },
    { type: 'work.read', id: item.id },
    { type: 'work.write', request },
    { type: 'work.receipt', request },
  ];
  for (const value of commands) {
    const command = parseCommand(value);
    expect(command).toEqual(value);
    expect(recoveryReader(command)).toBe(value.type !== 'work.write');
    expect(() => parseCommand({ ...value, bot: 'mock-forged' })).toThrow('INVALID_COMMAND');
  }
  for (const value of [
    { type: 'work.write', request: { ...request, actor } },
    { type: 'work.write', request: { ...request, value: { ...request.value, updatedBy: actor } } },
    { type: 'work.list', query: { limit: 51 } },
    { type: 'work.read', id: '../mock-private' },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
});

it('gates all shared-work commands before old or unavailable runtime calls', async () => {
  const values = [
    { type: 'work.list', query: {} },
    { type: 'work.read', id: item.id },
    { type: 'work.write', request },
    { type: 'work.receipt', request },
  ];
  const old = client(complete, 35);
  for (const value of values)
    await expect(old.runtime.invoke(parseCommand(value))).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(old.fetcher).not.toHaveBeenCalled();
  const broken = client();
  broken.snapshot.work = { available: false, error: 'WORK_CORRUPT' };
  for (const value of values)
    await expect(broken.runtime.invoke(parseCommand(value))).rejects.toThrow('WORK_CORRUPT');
  expect(broken.fetcher).not.toHaveBeenCalled();
});

it('binds work mutation and receipt acknowledgements to the exact human intent, accepting newer current state', async () => {
  const current = client();
  expect(await current.runtime.invoke(parseCommand({ type: 'work.write', request }))).toEqual(
    complete,
  );
  expect(current.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:18766/api/work/write');
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual(request);
  for (const value of [
    { ...complete, actor: { kind: 'bot', bot: 'mock-alpha' } },
    { ...complete, request: { ...request, id: 'mock-other-op' } },
    { ...complete, request: { ...request, value: { ...request.value, title: '合成不同意图' } } },
    { ...complete, item: { ...item, id: 'mock-other-item' } },
    { ...complete, signature: 'MOCK PRIVATE HASH' },
  ]) {
    await expect(
      client(value).runtime.invoke(parseCommand({ type: 'work.receipt', request })),
    ).rejects.toThrow('INVALID_WORK_ACK');
  }
  const unknown = { state: 'unknown', request, actor };
  expect(
    await client(unknown).runtime.invoke(parseCommand({ type: 'work.receipt', request })),
  ).toEqual(unknown);
  await expect(
    client(unknown).runtime.invoke(parseCommand({ type: 'work.write', request })),
  ).rejects.toThrow('INVALID_WORK_ACK');
});

it('binds item reads and bounded list replies to the captured query without exposing full descriptions', async () => {
  expect(
    await client(item).runtime.invoke(parseCommand({ type: 'work.read', id: item.id })),
  ).toEqual(item);
  await expect(
    client({ ...item, id: 'mock-other' }).runtime.invoke(
      parseCommand({ type: 'work.read', id: item.id }),
    ),
  ).rejects.toThrow('INVALID_WORK_ITEM');
  const { description: _description, ...summary } = item;
  const query = { filter: 'open', limit: 1, before: 20 };
  const list = {
    query,
    page: { revision: 2, items: [{ ...summary, progressTruncated: false }], nextBefore: 10 },
  };
  expect(await client(list).runtime.invoke(parseCommand({ type: 'work.list', query }))).toEqual(
    list,
  );
  for (const value of [
    { ...list, query: { ...query, filter: 'trash' } },
    { ...list, page: { ...list.page, nextBefore: 20 } },
    {
      ...list,
      page: {
        ...list.page,
        items: [{ ...summary, progressTruncated: false, description: 'MOCK FULL DETAIL' }],
      },
    },
    {
      ...list,
      page: { ...list.page, items: [{ ...summary, progressTruncated: false, deleted: true }] },
    },
    { ...list, page: { ...list.page, items: Array(2).fill(list.page.items[0]) } },
  ])
    await expect(
      client(value).runtime.invoke(parseCommand({ type: 'work.list', query })),
    ).rejects.toThrow('INVALID_WORK_PAGE');
});

it('captures work operations before asynchronous status checks and never retries an ambiguous mutation', async () => {
  const current = client();
  let finish: ((snapshot: RuntimeSnapshot) => unknown) | undefined;
  vi.spyOn(current.runtime, 'status').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const mutable = structuredClone(request);
  const pending = current.runtime.invoke(parseCommand({ type: 'work.write', request: mutable }));
  mutable.value.title = 'MOCK LATE MUTATION';
  finish!(current.snapshot);
  expect(await pending).toEqual(complete);
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual(request);
  const denied = client();
  denied.fetcher.mockResolvedValue(Response.json({ error: 'UNAUTHORIZED' }, { status: 403 }));
  await expect(
    denied.runtime.invoke(parseCommand({ type: 'work.write', request })),
  ).rejects.toThrow('RUNTIME_SESSION_CHANGED');
  expect(denied.fetcher).toHaveBeenCalledTimes(1);
});

it('keeps broken shared-work metadata separate from ordinary Agent availability and ignores old-runtime claims', async () => {
  let protocol = 36;
  let work: unknown = { available: true, revision: 0, count: 0 };
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) =>
      Response.json(
        url.endsWith('/api/model/settings')
          ? {
              provider: 'deepseek-official',
              model: 'deepseek-flash',
              configured: false,
              revision: 0,
            }
          : {
              mode: 'agent',
              clientProtocol: protocol,
              bots: {},
              work,
              computers: { available: true, revision: 0, limit: 2, items: [] },
              recovery: { available: true, revision: 0 },
              skills: { available: true, revision: 0 },
              mcp: { available: true, revision: 0 },
              chats: { available: true, revision: 0, items: [] },
              model: {
                available: true,
                provider: 'deepseek-official',
                model: 'deepseek-flash',
                bots: {},
              },
            },
      ),
  });
  expect((await runtime.status()).work).toEqual(work);
  for (const invalid of [
    undefined,
    { available: true, revision: -1, count: 0 },
    { available: true, revision: 0, count: 0, privatePath: '/mock-private' },
    { available: false, error: 'MOCK PRIVATE DETAIL' },
  ]) {
    work = invalid;
    const snapshot = await runtime.status();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.work).toEqual({ available: false, error: 'INVALID_WORK_METADATA' });
  }
  work = { available: false, error: 'WORK_CORRUPT' };
  expect((await runtime.status()).work).toEqual(work);
  protocol = 35;
  expect((await runtime.status()).work).toBeUndefined();
});

it('selects the richer work wire format only after proving runtime39 support', async () => {
  const modern = client(
    { ...item, status: 'blocked', priority: 'high', assignee: 'mock-beta' },
    39,
  );
  await modern.runtime.invoke(parseCommand({ type: 'work.read', id: item.id }));
  expect(new Headers(modern.fetcher.mock.calls[0][1]?.headers).get('x-daban-client-protocol')).toBe(
    '39',
  );
  const old = client(item, 38);
  await old.runtime.invoke(parseCommand({ type: 'work.read', id: item.id }));
  expect(new Headers(old.fetcher.mock.calls[0][1]?.headers).get('x-daban-client-protocol')).toBe(
    '28',
  );
  const unsupported = client(complete, 38);
  for (const value of [
    {
      type: 'work.write',
      request: { ...request, value: { ...request.value, priority: 'urgent' } },
    },
    {
      type: 'work.receipt',
      request: { ...request, value: { ...request.value, assignee: 'mock-beta' } },
    },
    { type: 'work.list', query: { status: 'review' } },
    {
      type: 'work.write',
      request: { id: 'mock-reopen', item: item.id, revision: 2, action: 'reopen' },
    },
  ])
    await expect(unsupported.runtime.invoke(parseCommand(value))).rejects.toThrow(
      'RUNTIME_TOO_OLD',
    );
  expect(unsupported.fetcher).not.toHaveBeenCalled();
});
