import { expect, test, vi } from 'vitest';
import { callBridge } from './bridge.js';
import { apply } from './statistics.js';

vi.mock('./bridge.js', () => ({ callBridge: vi.fn() }));

test('statistics coalesce behind a slow bridge and ignore child or replaced-root sessions', async () => {
  const session = { id: 'mock-root-session' };
  const stats = {
    turns: 1,
    steps: 1,
    llmMs: 1,
    toolMs: 0,
    ttftMs: 1,
    ttftSteps: 1,
    decodeMs: 0,
    decodeTokens: 1,
  };
  let receive!: (session: { id: string }, key: string, value: unknown, seq: number) => unknown;
  let close!: () => Promise<unknown>;
  let release!: () => unknown;
  const first = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  vi.mocked(callBridge)
    .mockImplementationOnce(() => first)
    .mockResolvedValue({ accepted: true });
  apply(
    {
      agents: { roots: () => [{ session }] },
      sessionProjections: {
        onChanged: (listener) => {
          receive = listener;
        },
      },
      effect: (factory) => {
        close = factory();
      },
    },
    { url: 'http://127.0.0.1:12345/mcp/mock-bot', capability: 'mock-capability' },
  );
  receive({ id: 'mock-child-session' }, 'sessionStats', stats, 1);
  receive({ id: session.id }, 'sessionStats', stats, 1);
  receive(session, 'other', stats, 1);
  receive(session, 'sessionStats', stats, 2);
  await Promise.resolve();
  receive(session, 'sessionStats', stats, 3);
  receive(session, 'sessionStats', { ...stats, steps: 3 }, 4);
  release();
  await close();
  expect(vi.mocked(callBridge).mock.calls.map((call) => call[2])).toStrictEqual([
    { sessionId: session.id, seq: 2, stats },
    { sessionId: session.id, seq: 4, stats: { ...stats, steps: 3 } },
  ]);
});
