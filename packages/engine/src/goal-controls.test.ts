import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { GoalControls } from './goal-controls.js';

test('repeated shutdown preserves Human epochs and consumed Goal grants across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-goal-restart-'));
  const file = path.join(root, 'goals.sqlite');
  let store = new GoalControls(file);
  try {
    await store.ready;
    const owner = { bot: 'synthetic-bot', chatRevision: 0 };
    store.observe(owner, 'synthetic-session', { id: 'synthetic-goal', revision: 1 }, true);
    const grant = store.accept(store.prepare(owner)!, 'synthetic-human', 'synthetic-run');
    const initial = store;
    initial.close();
    store = new GoalControls(file);
    await store.ready;
    expect(() => initial.close()).not.toThrow();
    expect(store.epoch(owner)).toBe(1);
    expect(store.claim(grant.id, 'synthetic-run', 'synthetic-session', 'synthetic-goal', 1)).toBe(
      true,
    );
    const claimed = store;
    claimed.close();
    store = new GoalControls(file);
    await store.ready;
    expect(() => claimed.close()).not.toThrow();
    expect(store.noteHuman(owner, 'synthetic-human')).toBe(1);
    expect(store.claim(grant.id, 'synthetic-run', 'synthetic-session', 'synthetic-goal', 1)).toBe(
      false,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Human Goal grants bind target and Human turn; observations never grant resume', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-goal-controls-'));
  const store = new GoalControls(path.join(root, 'goals.sqlite'));
  try {
    await store.ready;
    const owner = { bot: 'mock-bot', chatRevision: 0 };
    const goals = store;
    goals.observe(owner, 'synthetic-session', { id: 'synthetic-goal', revision: 1 }, true);
    const target = goals.prepare(owner)!;
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
    expect(() => goals.accept(fresh, 'synthetic-old-target', 'synthetic-old-run')).toThrow();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('project-scoped Goal targets keep distinct native sessions and preserve legacy owner keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-goal-controls-'));
  const store = new GoalControls(path.join(root, 'goals.sqlite'));
  try {
    await store.ready;
    const legacy = { bot: 'mock-bot', chatRevision: 0 };
    const alpha = { ...legacy, project: { projectId: 'mock-alpha', revision: 1 } };
    const beta = { ...legacy, project: { projectId: 'mock-beta', revision: 1 } };
    for (const [index, owner] of [legacy, alpha, beta].entries())
      store.observe(
        owner,
        `synthetic-session-${index}`,
        { id: `synthetic-goal-${index}`, revision: 1 },
        true,
      );
    expect(store.prepare(legacy)).toMatchObject({
      sessionId: 'synthetic-session-0',
    });
    expect(store.prepare(alpha)).toMatchObject({
      owner: alpha,
      sessionId: 'synthetic-session-1',
    });
    expect(store.prepare(beta)).toMatchObject({
      owner: beta,
      sessionId: 'synthetic-session-2',
    });
    const target = store.prepare(alpha)!;
    const grant = store.accept(target, 'synthetic-alpha-human', 'synthetic-alpha-run');
    store.noteHuman(beta, 'synthetic-beta-human');
    expect(
      store.claim(
        grant.id,
        'synthetic-alpha-run',
        target.sessionId,
        target.goalId,
        target.goalRevision,
      ),
    ).toBe(true);
    expect(
      store.claim(
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
