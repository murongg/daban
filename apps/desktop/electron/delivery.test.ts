import { expect, test } from 'vitest';
import { parseCommand } from './ipc';

const write = {
  requestId: 'mock-checklist-write',
  workId: 'mock-work',
  workRevision: 1,
  checklistRevision: 0,
  items: [{ id: 'mock-file', text: 'Synthetic report', kind: 'file', required: true }],
};
const bind = {
  requestId: 'mock-file-bind',
  workId: 'mock-work',
  workRevision: 2,
  attemptId: 'mock-attempt',
  attemptRevision: 1,
  criterionId: 'mock-file',
  output: { bot: 'mock-bot', runId: 'mock-run', path: 'mock-run/report.txt' },
};
for (const command of [
  { type: 'delivery.checklist.get', query: { workId: 'mock-work' } },
  { type: 'delivery.checklist.write', request: write },
  { type: 'delivery.checklist.receipt', request: write },
  { type: 'delivery.file.bind', request: bind },
  { type: 'delivery.file.bind-receipt', request: bind },
])
  test(`${command.type} accepts the exact synthetic DTO`, () => {
    expect(parseCommand(command)).toEqual(command);
  });
const invalid: unknown[] = [
  { ...write, actor: { kind: 'human' } },
  { ...write, workRevision: 0 },
  { ...write, checklistRevision: -1 },
  { ...write, items: [write.items[0], write.items[0]] },
  {
    ...write,
    items: Array.from({ length: 21 }, (_, i) => ({ ...write.items[0], id: `mock-${i}` })),
  },
  { ...write, items: [{ ...write.items[0], text: 'x'.repeat(301) }] },
];
for (const [index, request] of invalid.entries())
  test(`rejects malformed checklist ${index}`, () => {
    expect(() => parseCommand({ type: 'delivery.checklist.write', request })).toThrow(
      'INVALID_COMMAND',
    );
  });
test('rejects client digest and escaping artifact paths', () => {
  for (const output of [
    { ...bind.output, sha256: '0'.repeat(64) },
    { ...bind.output, path: '../mock-private' },
  ])
    expect(() =>
      parseCommand({ type: 'delivery.file.bind', request: { ...bind, output } }),
    ).toThrow('INVALID_COMMAND');
});

import { disconnected, managedProtocol } from '@daban/protocol';
import { vi } from 'vitest';
import { RuntimeClient } from './runtime';

function client(reply: unknown, supported = true) {
  const fetcher = vi.fn(async () => Response.json(reply));
  const runtime = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher,
  });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = managedProtocol;
  if (supported) snapshot.delivery = true;
  vi.spyOn(runtime, 'status').mockResolvedValue(snapshot);
  return { runtime, fetcher, snapshot };
}
test('delivery transport gates capability and binds exact checklist receipt without execution', async () => {
  const ack = {
    state: 'complete',
    request: write,
    checklist: { workId: write.workId, revision: 1, items: write.items },
  };
  const command = parseCommand({ type: 'delivery.checklist.write', request: write });
  const old = client(ack, false);
  await expect(old.runtime.invoke(command)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(old.fetcher).not.toHaveBeenCalled();
  const current = client(ack);
  expect(await current.runtime.invoke(command)).toEqual(ack);
  expect(current.fetcher).toHaveBeenCalledTimes(1);
  const wrong = client({ ...ack, request: { ...write, requestId: 'mock-other' } });
  await expect(wrong.runtime.invoke(command)).rejects.toThrow('INVALID_DELIVERY_RECEIPT');
});
