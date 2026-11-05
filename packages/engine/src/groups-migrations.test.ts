import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { migrate } from './database.js';
import { Groups } from './groups.js';
import { migrations } from './groups-migrations.js';

const historical = new Map([
  ['20261103131026_baseline', '8705404575e4b0f0e81e16dea21658f37cfb03c39412f39a4b53e991ccfb6999'],
  [
    '20261104110815_delivery-reference',
    'c2725ed1a22a373fa6331400c96f8caf3dc2bed8417eda602708f07b4ccaa345',
  ],
  [
    '20261104145941_automation-origin',
    'bf74740e706e8977cc94315b6cbced57c582f3851f018354a5376e348774909a',
  ],
  ['20261104160301_budgets', '73a6b4ae1371df4c37c14e465519149ef857f6b61dfa7db1d0259f81067bd4d2'],
  [
    '20261104164751_goal-target',
    '3dbc311e82a8b80a9075c60975db32c22f888e584a27e7116d0ef2e380292e5a',
  ],
]);
const reference = { workId: 'mock-work', attemptId: 'mock-claim', requestId: 'mock-request' };
const budget = { budgetId: 'mock-budget', revision: 1 };
const automation = {
  scheduleId: 'mock-schedule',
  firingId: 'mock-firing',
  configRevision: 1,
  trigger: 'time',
  policy: { kind: 'all' },
};
const target = {
  owner: { bot: 'mock-alpha', conversationId: 'mock-group' },
  sessionId: 'mock-session',
  goalId: 'mock-goal',
  goalRevision: 1,
  humanEpoch: 1,
  budget,
};

test('the generated Groups merge snapshot contains both historical leaves without rewriting their SQL hashes', async () => {
  for (const [name, hash] of historical)
    expect(migrations.find((row) => row.name === name)?.hash).toBe(hash);
  const latest = migrations.at(-1);
  expect.assert(latest);
  const snapshot = JSON.parse(
    await readFile(
      path.resolve('packages/engine/drizzle/groups', latest.name, 'snapshot.json'),
      'utf8',
    ),
  ) as { prevIds: string[]; ddl: { entityType: string; table?: string; name: string }[] };
  for (const [table, name] of [
    ['group_collaborations', 'delivery'],
    ['group_turns', 'automation'],
    ['group_turns', 'budget'],
    ['group_deliveries', 'retryOf'],
    ['group_deliveries', 'retryStage'],
    ['group_deliveries', 'goalResume'],
  ]) {
    expect(
      snapshot.ddl.some(
        (row) => row.entityType === 'columns' && row.table === table && row.name === name,
      ),
      `${table}.${name}`,
    ).toBe(true);
  }
  expect(new Set(snapshot.prevIds)).toEqual(
    new Set([
      '1e2412a4-6094-4be9-9b54-ba8fc8547dea',
      '5a7f99f8-afec-4675-806e-63ead81bbfcb',
      'eaf29594-dc93-4ec5-bdc9-41f639167e1e',
    ]),
  );
  expect(latest.sql.every((sql) => !sql.trim())).toBe(true);
});

for (const mode of ['released', 'budget-only', 'delivery-only', 'combined'] as const)
  test(`a synthetic ${mode} Groups file upgrades and reopens twice without losing accepted metadata or replaying`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-group-upgrade-'));
    const file = path.join(root, 'groups.sqlite');
    const includesBudget = mode === 'budget-only' || mode === 'combined';
    const includesDelivery = mode === 'delivery-only' || mode === 'combined';
    const previous = migrations.filter(
      (row) =>
        historical.has(row.name) &&
        (row.name.endsWith('_baseline') ||
          (row.name.endsWith('_delivery-reference') ? includesDelivery : includesBudget)),
    );
    const old = new DatabaseSync(file);
    migrate(old, previous);
    const at = '2026-01-01T00:00:00Z';
    const group = {
      id: 'mock-group',
      name: 'Synthetic group',
      members: ['mock-alpha', 'mock-beta'],
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    old
      .prepare('INSERT INTO group_defs(id,value) VALUES(?,?)')
      .run(group.id, JSON.stringify(group));
    old.prepare('INSERT INTO group_meta VALUES(1,1)').run();
    old
      .prepare(
        "INSERT INTO group_turns(grp,id,prompt,recipients,signature,created,state) VALUES(?,?,?,?,?,?,'completed')",
      )
      .run(group.id, 'mock-turn', 'Synthetic task', '["mock-alpha"]', 'mock-signature', at);
    old
      .prepare('INSERT INTO group_collaborations(source,grp,turn,signature) VALUES(?,?,?,?)')
      .run('mock-origin', group.id, 'mock-turn', 'mock-signature');
    old
      .prepare(
        "INSERT INTO group_deliveries(id,grp,source,bot,position,state) VALUES(?,?,?,?,0,'completed')",
      )
      .run('mock-stage', group.id, 'mock-turn', 'mock-alpha');
    if (includesBudget) {
      old
        .prepare('UPDATE group_turns SET budget=?,automation=?')
        .run(JSON.stringify(budget), JSON.stringify(automation));
      old.prepare('UPDATE group_deliveries SET goalResume=?').run(JSON.stringify(target));
    }
    if (includesDelivery)
      old.prepare('UPDATE group_collaborations SET delivery=?').run(JSON.stringify(reference));
    old.close();
    let calls = 0;
    try {
      for (let round = 0; round < 2; round++) {
        const groups = new Groups(file, {
          member: async (id) => ({ id, name: id }),
          running: () => false,
          findRequest: () => undefined,
          start: async () => {
            calls++;
          },
          stopRequest: async () => {},
        });
        try {
          await groups.ready;
          expect((await groups.status()).available).toBe(true);
          await groups.tick();
        } finally {
          await groups.close();
        }
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const turn = db.prepare('SELECT budget,automation FROM group_turns').get();
          expect(turn?.budget).toBe(includesBudget ? JSON.stringify(budget) : null);
          expect(turn?.automation).toBe(includesBudget ? JSON.stringify(automation) : null);
          expect(db.prepare('SELECT delivery FROM group_collaborations').get()?.delivery).toBe(
            includesDelivery ? JSON.stringify(reference) : null,
          );
          expect(db.prepare('SELECT goalResume FROM group_deliveries').get()?.goalResume).toBe(
            includesBudget ? JSON.stringify(target) : null,
          );
          const journal = db.prepare('SELECT name,hash FROM __drizzle_migrations').all();
          expect(journal).toHaveLength(migrations.length);
          for (const row of journal)
            expect(row.hash).toBe(
              migrations.find((migration) => migration.name === row.name)?.hash,
            );
        } finally {
          db.close();
        }
      }
      expect(calls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
