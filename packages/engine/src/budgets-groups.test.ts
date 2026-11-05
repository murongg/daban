import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { type GroupReceipt, Groups } from './groups.js';

test('explicit quota continuation retries only the failed group stage and preserves completed stages and receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-groups-'));
  const starts: string[] = [];
  const retryOf: (string | undefined)[] = [];
  const receipts = new Map<string, GroupReceipt>();
  const scope = { budgetId: 'synthetic-budget', revision: 1 };
  let failBot = 'mock-c';
  const store = new Groups(path.join(root, 'groups.sqlite'), {
    member: async (id) =>
      ['mock-a', 'mock-b', 'mock-c'].includes(id) ? { id, name: id } : undefined,
    source: () => ({ intentId: 'synthetic-intent', budget: scope }),
    running: () => false,
    findRequest: (_bot, id) => receipts.get(id),
    start: async (bot, task, context) => {
      starts.push(bot);
      retryOf.push(task.retryOf);
      receipts.set(task.requestId, {
        runId: `run-${starts.length}`,
        phase: bot === failBot ? 'failed' : 'completed',
        conversationId: context.id,
        result: 'SYNTHETIC GROUP RESULT',
        error: bot === failBot ? 'BUDGET_LIMIT_REACHED' : '',
      });
    },
    stopRequest: async () => {},
  });
  try {
    await store.ready;
    await store.collaborate(
      { bot: 'mock-a', runId: 'mock-run' },
      { name: 'Synthetic group', members: ['mock-b', 'mock-c'], message: 'SYNTHETIC SHARED GOAL' },
    );
    await store.tick();
    await store.tick();
    expect(starts).toEqual(['mock-b', 'mock-c']);
    const resume = store.resumeBudget.bind(store);
    failBot = 'mock-a';
    expect(await resume({ ...scope, revision: 2 }, 'synthetic-human-resume')).toBe(true);
    await store.tick();
    await store.tick();
    expect(starts).toEqual(['mock-b', 'mock-c', 'mock-c', 'mock-a']);
    expect(retryOf[2]).toBe('run-2');
    expect(await resume({ ...scope, revision: 2 }, 'synthetic-human-resume')).toBe(true);
    await store.tick();
    expect(starts).toHaveLength(4);
    failBot = '';
    await resume({ ...scope, revision: 3 }, 'synthetic-human-resume-again');
    await store.tick();
    expect(starts).toEqual(['mock-b', 'mock-c', 'mock-c', 'mock-a', 'mock-a']);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
