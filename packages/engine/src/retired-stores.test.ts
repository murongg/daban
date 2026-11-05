import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { type GroupReceipt, type GroupRunner, Groups } from './groups.js';
import { Knowledge } from './knowledge.js';
import { TaskJournal } from './tasks.js';
import { Work } from './work.js';

const workMigration = {
  name: '20261104110319_delivery',
  hash: '953f308483fe2f9ba2aaa249640be39844a56b8bcf0fc6c24ad8a77c724b80d2',
};
function pastMigration(file: string, migration: { name: string; hash: string }) {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO __drizzle_migrations(hash,name,created_at) VALUES(?,?,?)').run(
    migration.hash,
    migration.name,
    1790000000000,
  );
  db.close();
}

test.each(['known', 'wrong-hash', 'unclaimed-tables'] as const)(
  'ordinary Work survives only a recognized retired schema: %s',
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-work-'));
    const file = path.join(root, 'work.sqlite');
    let store = new Work(file);
    try {
      await store.write(
        {
          id: 'mock-create',
          item: 'mock-item',
          revision: 0,
          action: 'create',
          value: {
            title: 'Synthetic retained work',
            description: '',
            progress: '',
            status: 'todo',
          },
        },
        { kind: 'human' },
      );
      await store.close();
      const db = new DatabaseSync(file);
      for (const table of [
        'work_checklists',
        'work_decisions',
        'work_deliveries',
        'work_delivery_operations',
      ])
        db.exec(`CREATE TABLE ${table}(opaque TEXT)`);
      db.exec("INSERT INTO work_deliveries VALUES('synthetic archived payload')");
      db.close();
      if (mode !== 'unclaimed-tables')
        pastMigration(file, {
          ...workMigration,
          hash: mode === 'known' ? workMigration.hash : '0'.repeat(64),
        });
      store = new Work(file);
      if (mode === 'known') {
        await store.ready;
        expect((await store.list()).items[0].title).toBe('Synthetic retained work');
        const history = new DatabaseSync(file);
        expect(history.prepare('SELECT opaque FROM work_deliveries').get()?.opaque).toBe(
          'synthetic archived payload',
        );
        history.close();
      } else await expect(store.ready).rejects.toMatchObject({ code: 'WORK_CORRUPT' });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('ordinary Bot knowledge remains readable after the exact closed project-memory migration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-knowledge-'));
  const file = path.join(root, 'knowledge.sqlite');
  let store = new Knowledge(file);
  try {
    const document = await store.write('mock-alpha', {
      path: 'mock/retained.md',
      revision: 0,
      content: 'SYNTHETIC RETAINED TEXT',
    });
    await store.close();
    pastMigration(file, {
      name: '20261104182542_project-memory',
      hash: '400df9992d2b2580a503ea138acbd6f35cd332c02c44483e188c1768ea2570b4',
    });
    store = new Knowledge(file);
    await store.ready;
    expect((await store.read('mock-alpha', document.id)).content).toBe('SYNTHETIC RETAINED TEXT');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary Groups keep their catalog after closed Delivery metadata migrations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-groups-'));
  const file = path.join(root, 'groups.sqlite');
  const runner = {
    member: async (id: string) => ({ id, name: 'Synthetic Bot' }),
    running: () => false,
    findRequest: () => undefined,
    start: async () => undefined,
    stopRequest: async () => undefined,
  };
  let store = new Groups(file, runner);
  try {
    await store.ready;
    await store.close();
    const legacy = new DatabaseSync(file);
    legacy.exec('ALTER TABLE group_collaborations ADD COLUMN delivery TEXT');
    legacy.close();
    pastMigration(file, {
      name: '20261104110815_delivery-reference',
      hash: 'c2725ed1a22a373fa6331400c96f8caf3dc2bed8417eda602708f07b4ccaa345',
    });
    pastMigration(file, {
      name: '20261105075222_delivery-origins',
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    store = new Groups(file, runner);
    await store.ready;
    expect((await store.status()).available).toBe(true);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an archived Delivery task stays visible but cannot recover as an ordinary task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-task-'));
  try {
    const journal = new TaskJournal(root);
    await journal.put({
      bot: 'mock-alpha',
      runId: 'mock-run',
      prompt: 'Synthetic archived request',
      phase: 'failed',
      running: false,
      result: '',
      error: 'SYNTHETIC_STOP',
      createdAt: '2026-01-01T00:00:00.000Z',
      files: [],
      trace: [],
      delivery: { opaque: 'synthetic retired provenance' },
    });
    const reopened = new TaskJournal(root);
    await reopened.load();
    expect(await reopened.read('mock-alpha', 'mock-run')).toHaveProperty('delivery');
    expect((await reopened.recovery('mock-alpha', 'mock-run'))?.blocked).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an old Delivery group turn cannot auto-dispatch while fresh ordinary group messages still execute', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-group-queue-'));
  const file = path.join(root, 'groups.sqlite');
  const receipts = new Map<string, GroupReceipt>();
  const started: string[] = [];
  const runner: GroupRunner = {
    member: async (id) => (id === 'mock-group' ? undefined : { id, name: 'Synthetic Bot' }),
    running: () => false,
    findRequest: (_bot, id) => receipts.get(id),
    stopRequest: async () => undefined,
    start: async (_bot, task, scope) => {
      started.push(task.requestId);
      receipts.set(task.requestId, {
        runId: task.requestId,
        phase: 'completed',
        conversationId: scope.id,
        result: 'SYNTHETIC COMPLETE',
      });
    },
  };
  let store = new Groups(file, runner);
  try {
    await store.register({
      id: 'mock-group',
      name: 'Synthetic Group',
      members: ['mock-alpha', 'mock-beta'],
    });
    await store.send({
      id: 'mock-old-turn',
      group: 'mock-group',
      prompt: 'Synthetic retired request',
      recipients: ['mock-alpha'],
    });
    const oldRevision = (await store.status()).revision;
    await store.close();
    const db = new DatabaseSync(file);
    db.exec('ALTER TABLE group_collaborations ADD COLUMN delivery TEXT');
    db.prepare(
      'INSERT INTO group_collaborations(source,grp,turn,signature,delivery) VALUES(?,?,?,?,?)',
    ).run(
      'mock-old-source',
      'mock-group',
      'mock-old-turn',
      'mock-signature',
      '{"opaque":"synthetic provenance"}',
    );
    db.close();
    pastMigration(file, {
      name: '20261104110815_delivery-reference',
      hash: 'c2725ed1a22a373fa6331400c96f8caf3dc2bed8417eda602708f07b4ccaa345',
    });
    store = new Groups(file, runner);
    await store.tick();
    expect(started).toEqual([]);
    expect((await store.status()).revision).toBeGreaterThan(Number(oldRevision));
    await store.send({
      id: 'mock-new-turn',
      group: 'mock-group',
      prompt: 'Synthetic ordinary request',
      recipients: ['mock-alpha'],
    });
    await store.tick();
    expect(started).toHaveLength(1);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
