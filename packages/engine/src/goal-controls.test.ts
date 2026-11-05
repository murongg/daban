import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type TestContext, test } from 'vitest';
import { migrate } from './database.js';
import { GoalControls, goalOwnerKey } from './goal-controls.js';
import { migrations } from './goal-controls-migrations.js';
import { goalGrants, goalHumans, goalLinks } from './goal-controls-schema.js';

async function retiredGoalFixture(t: TestContext, strippedScope = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-goal-'));
  const file = path.join(root, 'goals.sqlite');
  const owner = {
    bot: 'mock-retired-bot',
    chatRevision: 0,
    project: { projectId: 'mock-retired-project', revision: 1 },
  };
  const target = {
    owner,
    sessionId: 'mock-retired-session',
    goalId: 'mock-retired-goal',
    goalRevision: 1,
    humanEpoch: 0,
  };
  const client = new DatabaseSync(file);
  try {
    const db = migrate(client, migrations);
    const key = goalOwnerKey(owner);
    db.insert(goalLinks)
      .values({ owner: key, session: target.sessionId, goal: target.goalId, revision: 1 })
      .run();
    db.insert(goalHumans).values({ owner: key, epoch: 0 }).run();
    db.insert(goalGrants)
      .values({
        id: 'mock-retired-grant',
        owner: key,
        run: 'mock-retired-run',
        target: strippedScope ? { ...target, owner: { bot: owner.bot, chatRevision: 0 } } : target,
        epoch: 0,
        fingerprint: 'synthetic-legacy-fingerprint',
        claimed: false,
      })
      .run();
  } finally {
    client.close();
  }
  await chmod(file, 0o600);
  const store = new GoalControls(file);
  t.onTestFinished(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.ready;
  return { store, owner, target };
}

test.for(['epoch', 'prepare', 'noteHuman', 'observe', 'accept'] as const)(
  'a retired Goal owner cannot acquire current authority through %s',
  async (operation, t) => {
    const { store, owner, target } = await retiredGoalFixture(t);
    const actions = {
      epoch: () => store.epoch(owner),
      prepare: () => store.prepare(owner),
      noteHuman: () => store.noteHuman(owner, 'mock-new-human'),
      observe: () =>
        store.observe(owner, target.sessionId, { id: target.goalId, revision: 2 }, true),
      accept: () => store.accept(target, 'mock-new-human', 'mock-new-run'),
    };
    expect(actions[operation]).toThrowError(expect.objectContaining({ code: 'PROJECT_RETIRED' }));
    expect(store.prepare({ bot: owner.bot, chatRevision: 0 })).toBeUndefined();
  },
);

test.for([false, true])(
  'a stored retired-project Goal grant cannot be claimed or aliased (stripped scope=%s)',
  async (strippedScope, t) => {
    const { store, owner, target } = await retiredGoalFixture(t, strippedScope);
    expect(
      store.claim('mock-retired-grant', 'mock-retired-run', target.sessionId, target.goalId, 1),
    ).toBe(false);
    expect(store.prepare({ bot: owner.bot, chatRevision: 0 })).toBeUndefined();
  },
);

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
