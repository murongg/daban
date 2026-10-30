import { disconnected, type RuntimeSnapshot, recoveryReader } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const actor = { kind: 'human' };
const request = { id: 'mock-comment-op', item: 'mock-work', revision: 1, body: '合成人工评论' };
const at = '2026-01-02T00:00:00Z';
const item = {
  id: request.item,
  title: '合成任务',
  description: '',
  progress: '',
  status: 'todo',
  revision: 3,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: at,
  createdBy: actor,
  updatedBy: actor,
};
const comment = {
  id: request.id,
  item: request.item,
  body: request.body,
  createdAt: at,
  createdBy: actor,
};
const complete = {
  state: 'complete',
  request,
  actor,
  acceptedRevision: 2,
  acceptedAt: at,
  item,
  comment,
};
function client(value: unknown = complete, protocol = 38) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(value));
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  snapshot.work = { available: true, revision: 3, count: 1 };
  vi.spyOn(runtime, 'status').mockResolvedValue(snapshot);
  return { runtime, fetcher, snapshot };
}
it('closes discussion IPC and permits only list/receipt recovery readers', () => {
  for (const value of [
    { type: 'work.comments', query: { item: request.item } },
    { type: 'work.comment', request },
    { type: 'work.comment-receipt', request },
  ]) {
    const parsed = parseCommand(value);
    expect(parsed).toEqual(value);
    expect(recoveryReader(parsed)).toBe(value.type !== 'work.comment');
    expect(() => parseCommand({ ...value, actor })).toThrow('INVALID_COMMAND');
  }
  for (const value of [
    { type: 'work.comment', request: { ...request, createdBy: actor } },
    { type: 'work.comments', query: { item: request.item, limit: 51 } },
    { type: 'work.comments', query: { item: request.item, bot: 'mock-forged' } },
    { type: 'work.comment', request: { ...request, revision: 0 } },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
});
it('requires runtime38 and available Work before issuing discussion requests', async () => {
  for (const command of [
    { type: 'work.comments', query: { item: request.item } },
    { type: 'work.comment', request },
    { type: 'work.comment-receipt', request },
  ]) {
    const old = client(complete, 37);
    await expect(old.runtime.invoke(parseCommand(command))).rejects.toThrow('RUNTIME_TOO_OLD');
    expect(old.fetcher).not.toHaveBeenCalled();
    const broken = client();
    broken.snapshot.work = { available: false, error: 'WORK_CORRUPT' };
    await expect(broken.runtime.invoke(parseCommand(command))).rejects.toThrow('WORK_CORRUPT');
    expect(broken.fetcher).not.toHaveBeenCalled();
  }
});
it('binds comment acknowledgement and current item to exact Human intent', async () => {
  const current = client();
  expect(await current.runtime.invoke(parseCommand({ type: 'work.comment', request }))).toEqual(
    complete,
  );
  expect(current.fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:18766/api/work/comment');
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual(request);
  for (const value of [
    { ...complete, actor: { kind: 'bot', bot: 'mock-alpha' } },
    { ...complete, request: { ...request, id: 'mock-other' } },
    { ...complete, comment: { ...comment, body: 'MOCK OTHER' } },
    { ...complete, item: { ...item, id: 'mock-other' } },
  ])
    await expect(
      client(value).runtime.invoke(parseCommand({ type: 'work.comment-receipt', request })),
    ).rejects.toThrow('INVALID_WORK_COMMENT_ACK');
  const unknown = { state: 'unknown', request, actor };
  expect(
    await client(unknown).runtime.invoke(parseCommand({ type: 'work.comment-receipt', request })),
  ).toEqual(unknown);
  await expect(
    client(unknown).runtime.invoke(parseCommand({ type: 'work.comment', request })),
  ).rejects.toThrow('INVALID_WORK_COMMENT_ACK');
});
it('validates exact query echo, cursor and item on a discussion list', async () => {
  const query = { item: request.item, before: 20, limit: 1 };
  const list = {
    query,
    page: { item: request.item, revision: 3, comments: [comment], nextBefore: 10 },
  };
  expect(await client(list).runtime.invoke(parseCommand({ type: 'work.comments', query }))).toEqual(
    list,
  );
  for (const value of [
    { ...list, query: { ...query, item: 'mock-other' } },
    { ...list, page: { ...list.page, item: 'mock-other' } },
    { ...list, page: { ...list.page, nextBefore: 20 } },
    { ...list, page: { ...list.page, comments: [comment, comment] } },
  ])
    await expect(
      client(value).runtime.invoke(parseCommand({ type: 'work.comments', query })),
    ).rejects.toThrow('INVALID_WORK_COMMENT_PAGE');
});
it('captures comment intent before status yields and keeps uncertain mutations single-send', async () => {
  const current = client();
  let finish!: (snapshot: RuntimeSnapshot) => unknown;
  vi.spyOn(current.runtime, 'status').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const mutable = structuredClone(request);
  const pending = current.runtime.invoke(parseCommand({ type: 'work.comment', request: mutable }));
  mutable.body = 'MOCK LATE CHANGE';
  finish(current.snapshot);
  expect(await pending).toEqual(complete);
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual(request);
  const denied = client();
  denied.fetcher.mockResolvedValue(Response.json({ error: 'UNAUTHORIZED' }, { status: 403 }));
  await expect(
    denied.runtime.invoke(parseCommand({ type: 'work.comment', request })),
  ).rejects.toThrow('RUNTIME_SESSION_CHANGED');
  expect(denied.fetcher).toHaveBeenCalledTimes(1);
  const recovery = client();
  recovery.snapshot.recovery = { available: false, error: 'RECOVERY_STORE_UNAVAILABLE' };
  await expect(
    recovery.runtime.invoke(parseCommand({ type: 'work.comment', request })),
  ).rejects.toThrow('RUNTIME_RECOVERY_PENDING');
  expect(recovery.fetcher).not.toHaveBeenCalled();
  expect(
    await recovery.runtime.invoke(parseCommand({ type: 'work.comment-receipt', request })),
  ).toEqual(complete);
});
