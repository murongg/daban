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

test('project-scoped Goal targets keep distinct native sessions and preserve legacy owner keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-goal-budget-'));
  const store = new Budgets(path.join(root, 'budgets.sqlite'));
  try {
    await store.ready;
    const legacy = { bot: 'mock-bot', chatRevision: 0 };
    const alpha = { ...legacy, project: { projectId: 'mock-alpha', revision: 1 } };
    const beta = { ...legacy, project: { projectId: 'mock-beta', revision: 1 } };
    const books = [
      store.ensure('synthetic-legacy-goal'),
      store.ensure('synthetic-alpha-goal'),
      store.ensure('synthetic-beta-goal'),
    ];
    for (const [index, owner] of [legacy, alpha, beta].entries())
      store.goals.observe(
        owner,
        `synthetic-session-${index}`,
        { id: `synthetic-goal-${index}`, revision: 1 },
        books[index],
        true,
      );
    expect(store.goals.prepare(legacy)).toMatchObject({
      sessionId: 'synthetic-session-0',
      budget: books[0],
    });
    expect(store.goals.prepare(alpha)).toMatchObject({
      owner: alpha,
      sessionId: 'synthetic-session-1',
      budget: books[1],
    });
    expect(store.goals.prepare(beta)).toMatchObject({
      owner: beta,
      sessionId: 'synthetic-session-2',
      budget: books[2],
    });
    const target = store.goals.prepare(alpha)!;
    const grant = store.goals.accept(target, 'synthetic-alpha-human', 'synthetic-alpha-run');
    store.goals.noteHuman(beta, 'synthetic-beta-human');
    expect(
      store.goals.claim(
        grant.id,
        'synthetic-alpha-run',
        target.sessionId,
        target.goalId,
        target.goalRevision,
      ),
    ).toBe(true);
    expect(
      store.goals.claim(
        grant.id,
        'synthetic-alpha-run',
        target.sessionId,
        target.goalId,
        target.goalRevision,
      ),
    ).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
