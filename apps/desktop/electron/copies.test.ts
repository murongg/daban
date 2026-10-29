import { disconnected, type RuntimeSnapshot, recoveryReader } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const request = {
  id: 'mock-copy-target',
  bot: 'mock-copy-source',
  revision: 1,
  name: '合成复制结果',
  memory: true,
};
const profile = {
  id: request.id,
  name: request.name,
  instructions: 'MOCK-ROLE',
  memory: 'MOCK-PREFERENCE',
  color: 'mint',
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const complete = { request, state: 'complete', profile };

function client(value: unknown = complete, protocol = 34) {
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

it('closes both copy commands at IPC without accepting extra authority or malformed requests', () => {
  for (const type of ['bot.copy', 'bot.copy.receipt']) {
    expect(parseCommand({ type, request })).toEqual({ type, request });
    expect(recoveryReader(parseCommand({ type, request }))).toBe(type === 'bot.copy.receipt');
    for (const command of [
      { type, request, allowComputer: true },
      { type, request: { ...request, token: 'MOCK-TOKEN' } },
      { type, request: { ...request, id: request.bot } },
      { type, request: { ...request, id: 'research' } },
      { type, request: { ...request, id: 'writer' } },
      { type, request: { ...request, revision: 0 } },
      { type, request: { ...request, name: '' } },
    ])
      expect(() => parseCommand(command)).toThrow('INVALID_COMMAND');
  }
});

it('rejects old runtimes before POST and routes complete and unknown receipts to their exact source', async () => {
  const old = client(complete, 33);
  await expect(old.runtime.invoke(parseCommand({ type: 'bot.copy', request }))).rejects.toThrow(
    'RUNTIME_TOO_OLD',
  );
  await expect(
    old.runtime.invoke(parseCommand({ type: 'bot.copy.receipt', request })),
  ).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(old.fetcher).not.toHaveBeenCalled();
  const current = client();
  expect(await current.runtime.invoke(parseCommand({ type: 'bot.copy', request }))).toEqual(
    complete,
  );
  expect(current.fetcher.mock.calls[0][0]).toBe(
    `http://127.0.0.1:18766/api/bots/${request.bot}/copy`,
  );
  const unknown = { request, state: 'unknown' };
  const reading = client(unknown);
  expect(await reading.runtime.invoke(parseCommand({ type: 'bot.copy.receipt', request }))).toEqual(
    unknown,
  );
  const copying = client(unknown);
  await expect(copying.runtime.invoke(parseCommand({ type: 'bot.copy', request }))).rejects.toThrow(
    'INVALID_BOT_COPY_ACK',
  );
});

it('rejects receipts for a different operation or target instead of publishing another Bot', async () => {
  const changes = [
    { id: 'mock-other' },
    { bot: 'mock-other' },
    { revision: 2 },
    { name: '合成其他请求' },
    { memory: false },
  ];
  for (const value of [
    ...changes.map((change) => ({ ...complete, request: { ...request, ...change } })),
    { ...complete, profile: { ...profile, id: 'mock-foreign' } },
    { ...complete, credentials: 'MOCK-PRIVATE' },
  ]) {
    const current = client(value);
    await expect(
      current.runtime.invoke(parseCommand({ type: 'bot.copy.receipt', request })),
    ).rejects.toThrow('INVALID_BOT_COPY_ACK');
  }
});

it('captures the exact request before awaiting status and never retries a rejected mutation session', async () => {
  const current = client();
  let finish: ((snapshot: RuntimeSnapshot) => unknown) | undefined;
  vi.spyOn(current.runtime, 'status').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const mutable = { ...request };
  const pending = current.runtime.invoke(parseCommand({ type: 'bot.copy', request: mutable }));
  mutable.name = 'MOCK-LATE-MUTATION';
  finish!(current.snapshot);
  expect(await pending).toEqual(complete);
  const init = current.fetcher.mock.calls[0][1];
  expect(JSON.parse(String(init?.body))).toEqual(request);
  const denied = client();
  denied.fetcher.mockResolvedValue(
    new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 403 }),
  );
  await expect(denied.runtime.invoke(parseCommand({ type: 'bot.copy', request }))).rejects.toThrow(
    'RUNTIME_SESSION_CHANGED',
  );
  expect(denied.fetcher).toHaveBeenCalledTimes(1);
});
