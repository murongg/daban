import { disconnected, type RuntimeSnapshot, recoveryReader } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const bot = 'mock-alpha',
  other = 'mock-beta';
const request = {
  id: 'mock-create',
  note: 'mock-note',
  revision: 0,
  action: 'create',
  value: { title: '合成便笺', body: 'MOCK BODY', status: 'open' },
};
const actor = { kind: 'human' };
const item = {
  bot,
  id: request.note,
  ...request.value,
  revision: 2,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  createdBy: actor,
  updatedBy: actor,
};
const complete = {
  state: 'complete',
  bot,
  request,
  actor,
  acceptedRevision: 1,
  acceptedAt: item.createdAt,
  item,
};
function client(value: unknown = complete, protocol = 37) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(value));
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot: RuntimeSnapshot = { ...disconnected('ready'), notes: { available: true } };
  snapshot.protocolVersion = protocol;
  vi.spyOn(runtime, 'status').mockResolvedValue(snapshot);
  return { runtime, fetcher, snapshot };
}
const commands = [
  { type: 'notes.status', bot },
  { type: 'notes.list', bot, query: {} },
  { type: 'notes.read', bot, id: request.note },
  { type: 'notes.write', bot, request },
  { type: 'notes.receipt', bot, request },
];

it('closes notes commands with explicit Bot binding and marks only readers as recovery-safe', () => {
  for (const value of commands) {
    const parsed = parseCommand(value);
    expect(parsed).toEqual(value);
    expect(recoveryReader(parsed)).toBe(value.type !== 'notes.write');
    expect(() => parseCommand({ ...value, actor })).toThrow('INVALID_COMMAND');
    expect(() => parseCommand({ ...value, bot: '../mock-private' })).toThrow('INVALID_COMMAND');
  }
  for (const value of [
    { type: 'notes.list', bot, query: { bot: other } },
    { type: 'notes.list', bot, query: { filter: ['active'] } },
    { type: 'notes.write', bot, request: { ...request, bot: other } },
    { type: 'notes.read', bot, id: '../mock-private' },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
});

it('gates old runtimes before requests and treats failed optional metadata separately', async () => {
  const old = client(complete, 36);
  for (const command of commands)
    await expect(old.runtime.invoke(parseCommand(command))).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(old.fetcher).not.toHaveBeenCalled();
  const broken = client();
  broken.snapshot.notes = { available: false, error: 'NOTES_CORRUPT' };
  for (const command of commands)
    await expect(broken.runtime.invoke(parseCommand(command))).rejects.toThrow('NOTES_CORRUPT');
  expect(broken.fetcher).not.toHaveBeenCalled();
});

it('keeps invalid optional note metadata local to notes and ignores old-runtime claims', async () => {
  let protocol = 37,
    notes: unknown = { available: true };
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
              notes,
              work: { available: true, revision: 0, count: 0 },
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
  expect((await runtime.status()).notes).toEqual(notes);
  for (const invalid of [
    undefined,
    { available: true, privatePath: '/mock-private' },
    { available: true, count: 1, revision: 1 },
    { available: false, error: 'MOCK PRIVATE ERROR' },
  ]) {
    notes = invalid;
    const snapshot = await runtime.status();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.notes).toEqual({ available: false, error: 'INVALID_NOTE_METADATA' });
  }
  notes = { available: false, error: 'NOTES_CORRUPT' };
  expect((await runtime.status()).notes).toEqual(notes);
  protocol = 36;
  expect((await runtime.status()).notes).toBeUndefined();
});

it('binds note writes and receipt inspection to exact captured Human intent and owner', async () => {
  const current = client();
  expect(await current.runtime.invoke(parseCommand({ type: 'notes.write', bot, request }))).toEqual(
    complete,
  );
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual({ bot, request });
  for (const value of [
    { ...complete, bot: other },
    { ...complete, item: { ...item, bot: other } },
    { ...complete, actor: { kind: 'bot', bot } },
    { ...complete, request: { ...request, id: 'mock-different' } },
    { ...complete, signature: 'MOCK PRIVATE FINGERPRINT' },
  ])
    await expect(
      client(value).runtime.invoke(parseCommand({ type: 'notes.receipt', bot, request })),
    ).rejects.toThrow('INVALID_NOTE_ACK');
  const unknown = { state: 'unknown', bot, request, actor };
  expect(
    await client(unknown).runtime.invoke(parseCommand({ type: 'notes.receipt', bot, request })),
  ).toEqual(unknown);
  await expect(
    client(unknown).runtime.invoke(parseCommand({ type: 'notes.write', bot, request })),
  ).rejects.toThrow('INVALID_NOTE_ACK');
});

it('validates bounded list query, item and status echoes without accepting another Bot', async () => {
  expect(
    await client(item).runtime.invoke(parseCommand({ type: 'notes.read', bot, id: item.id })),
  ).toEqual(item);
  await expect(
    client({ ...item, bot: other }).runtime.invoke(
      parseCommand({ type: 'notes.read', bot, id: item.id }),
    ),
  ).rejects.toThrow('INVALID_NOTE_ITEM');
  const query = { filter: 'active', before: 20, limit: 1 };
  const list = {
    bot,
    query,
    page: { bot, revision: 2, items: [{ ...item, bodyTruncated: false }], nextBefore: 10 },
  };
  expect(
    await client(list).runtime.invoke(parseCommand({ type: 'notes.list', bot, query })),
  ).toEqual(list);
  for (const value of [
    { ...list, bot: other },
    { ...list, query: { ...query, filter: 'trash' } },
    { ...list, page: { ...list.page, nextBefore: 20 } },
    { ...list, page: { ...list.page, items: [{ ...item, deleted: true, bodyTruncated: false }] } },
    {
      ...list,
      page: { ...list.page, items: [{ ...item, body: 'x'.repeat(201), bodyTruncated: true }] },
    },
  ])
    await expect(
      client(value).runtime.invoke(parseCommand({ type: 'notes.list', bot, query })),
    ).rejects.toThrow('INVALID_NOTE_PAGE');
  const status = { bot, status: { available: true, revision: 2, count: 1 } };
  expect(await client(status).runtime.invoke(parseCommand({ type: 'notes.status', bot }))).toEqual(
    status,
  );
  await expect(
    client({ ...status, bot: other }).runtime.invoke(parseCommand({ type: 'notes.status', bot })),
  ).rejects.toThrow('INVALID_NOTE_METADATA');
});

it('captures Bot and request before status yields and never retries an ambiguous write', async () => {
  const current = client();
  let finish: ((value: RuntimeSnapshot) => unknown) | undefined;
  vi.spyOn(current.runtime, 'status').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const command = { type: 'notes.write', bot, request: structuredClone(request) };
  const pending = current.runtime.invoke(parseCommand(command));
  command.bot = other;
  command.request.value.body = 'MOCK LATE BODY';
  finish!(current.snapshot);
  expect(await pending).toEqual(complete);
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual({ bot, request });
  const denied = client();
  denied.fetcher.mockResolvedValue(Response.json({ error: 'UNAUTHORIZED' }, { status: 403 }));
  await expect(
    denied.runtime.invoke(parseCommand({ type: 'notes.write', bot, request })),
  ).rejects.toThrow('RUNTIME_SESSION_CHANGED');
  expect(denied.fetcher).toHaveBeenCalledTimes(1);
});

it('recovers a lost write response by reading its receipt without resending the mutation', async () => {
  const current = client();
  current.fetcher.mockImplementation(async (url) => {
    if (url.endsWith('/write')) throw new Error('MOCK_LOST_WRITE_RESPONSE');
    return Response.json(complete);
  });
  await expect(
    current.runtime.invoke(parseCommand({ type: 'notes.write', bot, request })),
  ).rejects.toThrow('MOCK_LOST_WRITE_RESPONSE');
  expect(current.fetcher).toHaveBeenCalledTimes(1);
  expect(
    await current.runtime.invoke(parseCommand({ type: 'notes.receipt', bot, request })),
  ).toEqual(complete);
  expect(current.fetcher.mock.calls.map(([url]) => url)).toEqual([
    'http://127.0.0.1:18766/api/notes/write',
    'http://127.0.0.1:18766/api/notes/receipt',
  ]);
});
