import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { callBridge } from './bridge.js';
import { apply } from './context-bridge.js';

vi.mock('./bridge.js', () => ({ callBridge: vi.fn() }));

test('only the exact live root publishes public values with the turn frozen before coalescing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-bridge-'));
  const turnFile = path.join(root, 'turn.json');
  const session = { id: 'mock-root' };
  let receive: (session: { id: string }, key: string, value: unknown, seq: number) => unknown =
    () => {};
  let close: () => Promise<unknown> = async () => {};
  let release: () => unknown = () => {};
  const slow = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  vi.mocked(callBridge)
    .mockReset()
    .mockImplementationOnce(() => slow)
    .mockResolvedValue({ accepted: true });
  try {
    await writeFile(turnFile, JSON.stringify({ id: 'mock-turn-a' }));
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
      { url: 'http://127.0.0.1:12345/mcp/mock-bot', capability: 'mock-capability', turnFile },
    );
    const value = { systemTokens: 2, toolsTokens: 3, messageTokens: 4 };
    receive({ id: session.id }, 'contextBreakdown', value, 1);
    receive(session, 'tokenUsage', value, 1);
    receive(session, 'contextBreakdown', { ...value, rawOutput: 'SYNTHETIC PRIVATE' }, 1);
    receive(session, 'contextBreakdown', value, 1);
    expect(callBridge).toHaveBeenCalledTimes(1);
    receive(session, 'contextBreakdown', { ...value, messageTokens: 6 }, 2);
    await writeFile(turnFile, JSON.stringify({ id: 'mock-turn-b' }));
    release();
    await close();
    expect(vi.mocked(callBridge).mock.calls.map((call) => call[2])).toEqual([
      { sessionId: session.id, turnId: 'mock-turn-a', key: 'contextBreakdown', seq: 1, value },
      {
        sessionId: session.id,
        turnId: 'mock-turn-a',
        key: 'contextBreakdown',
        seq: 2,
        value: { ...value, messageTokens: 6 },
      },
    ]);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});
