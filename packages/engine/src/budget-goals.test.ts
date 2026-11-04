import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultBudgetPolicy } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Budgets } from './budgets.js';

test('Human Goal grants bind target, accepted budget and Human turn; observations never grant resume', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-goal-budget-'));
  const store = new Budgets(path.join(root, 'budgets.sqlite'));
  try {
    await store.ready;
    const owner = { bot: 'mock-bot', chatRevision: 0 };
    const scope = store.ensure('synthetic-goal-root');
    const goals = store.goals;
    goals.observe(owner, 'synthetic-session', { id: 'synthetic-goal', revision: 1 }, scope, true);
    const target = goals.prepare(owner)!;
    expect(target.budget).toEqual(scope);
    const grant = goals.accept(target, 'synthetic-human', 'synthetic-run');
    expect(goals.claim(grant.id, 'foreign-run', 'synthetic-session', 'synthetic-goal', 1)).toBe(
      false,
    );
    expect(goals.claim(grant.id, 'synthetic-run', 'synthetic-session', 'wrong-goal', 1)).toBe(
      false,
    );
    goals.noteHuman(owner, 'synthetic-newer-human');
    expect(goals.claim(grant.id, 'synthetic-run', 'synthetic-session', 'synthetic-goal', 1)).toBe(
      false,
    );
    const fresh = goals.prepare(owner)!;
    const next = goals.accept(fresh, 'synthetic-explicit-current', 'synthetic-next-run');
    expect(
      goals.claim(next.id, 'synthetic-next-run', 'synthetic-session', 'synthetic-goal', 1),
    ).toBe(true);
    expect(
      goals.claim(next.id, 'synthetic-next-run', 'synthetic-session', 'synthetic-goal', 1),
    ).toBe(false);
    expect(store.view(scope.budgetId).requests).toBe(0);
    const raised = store.increase(scope.budgetId, 1, defaultBudgetPolicy, 'synthetic-quota');
    expect(raised.state).toBe('stopped');
    expect(() => goals.accept(fresh, 'synthetic-old-budget', 'synthetic-old-run')).toThrow();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
