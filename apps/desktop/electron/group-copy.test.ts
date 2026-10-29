import { disconnected, type RuntimeSnapshot, recoveryReader } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const request = {
  id: 'mock-target-group',
  group: 'mock-source-group',
  revision: 1,
  name: '合成群聊副本',
};
const group = {
  id: request.id,
  name: '合成后续编辑',
  members: ['mock-alpha', 'mock-beta'],
  revision: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};
const complete = { request, state: 'complete', group };
function client(value: unknown = complete, protocol = 35) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(value));
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = protocol;
  vi.spyOn(runtime, 'status').mockResolvedValue(snapshot);
  return { runtime, fetcher, snapshot };
}

it('closes group copy IPC shapes and admits only receipt inspection during recovery', () => {
  for (const type of ['group.copy', 'group.copy.receipt']) {
    const command = parseCommand({ type, request });
    expect(command).toEqual({ type, request });
    expect(recoveryReader(command)).toBe(type === 'group.copy.receipt');
    for (const value of [
      { type, request, extra: true },
      { type, request: { ...request, members: group.members } },
      { type, request: { ...request, id: 'research' } },
      { type, request: { ...request, revision: 0 } },
    ])
      expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
  }
});

it('gates old runtimes before POST and binds the source, receipt and every material echo field', async () => {
  const old = client(complete, 34);
  for (const type of ['group.copy', 'group.copy.receipt'])
    await expect(old.runtime.invoke(parseCommand({ type, request }))).rejects.toThrow(
      'RUNTIME_TOO_OLD',
    );
  expect(old.fetcher).not.toHaveBeenCalled();
  const current = client();
  expect(await current.runtime.invoke(parseCommand({ type: 'group.copy', request }))).toEqual(
    complete,
  );
  expect(current.fetcher.mock.calls[0][0]).toBe(
    `http://127.0.0.1:18766/api/groups/${request.group}/copy`,
  );
  for (const change of [
    { id: 'mock-other' },
    { group: 'mock-other' },
    { revision: 2 },
    { name: '合成其他名称' },
  ]) {
    const wrong = client({ ...complete, request: { ...request, ...change } });
    await expect(
      wrong.runtime.invoke(parseCommand({ type: 'group.copy.receipt', request })),
    ).rejects.toThrow('INVALID_GROUP_COPY_ACK');
  }
  const foreign = client({ ...complete, group: { ...group, id: 'mock-foreign' } });
  await expect(
    foreign.runtime.invoke(parseCommand({ type: 'group.copy', request })),
  ).rejects.toThrow('INVALID_GROUP_COPY_ACK');
});

it('accepts unknown receipts only from reads and captures the operation before an asynchronous status check', async () => {
  const reading = client({ request, state: 'unknown' });
  expect(
    await reading.runtime.invoke(parseCommand({ type: 'group.copy.receipt', request })),
  ).toEqual({ request, state: 'unknown' });
  await expect(
    reading.runtime.invoke(parseCommand({ type: 'group.copy', request })),
  ).rejects.toThrow('INVALID_GROUP_COPY_ACK');
  const current = client();
  let finish: ((snapshot: RuntimeSnapshot) => unknown) | undefined;
  vi.spyOn(current.runtime, 'status').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const mutable = { ...request };
  const pending = current.runtime.invoke(parseCommand({ type: 'group.copy', request: mutable }));
  mutable.name = 'MOCK LATE MUTATION';
  finish!(current.snapshot);
  expect(await pending).toEqual(complete);
  expect(JSON.parse(String(current.fetcher.mock.calls[0][1]?.body))).toEqual(request);
});

it('never retries a group copy mutation after a stale authentication session', async () => {
  const denied = client();
  denied.fetcher.mockResolvedValue(
    new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 403 }),
  );
  await expect(
    denied.runtime.invoke(parseCommand({ type: 'group.copy', request })),
  ).rejects.toThrow('RUNTIME_SESSION_CHANGED');
  expect(denied.fetcher).toHaveBeenCalledTimes(1);
});
