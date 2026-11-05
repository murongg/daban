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

test.each(['known', 'wrong-hash', 'unknown-name', 'unclaimed-tables', 'extra-table'] as const)(
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
      if (mode === 'extra-table') db.exec('CREATE TABLE unknown_records(opaque TEXT)');
      db.close();
      if (mode !== 'unclaimed-tables')
        pastMigration(file, {
          ...workMigration,
          name: mode === 'unknown-name' ? '20261104110319_unknown' : workMigration.name,
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

test.each(['known', 'wrong-hash', 'unknown-name'] as const)(
  'ordinary Bot knowledge checks the exact closed project-memory migration: %s',
  async (mode) => {
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
        name: mode === 'unknown-name' ? '20261104182542_unknown' : '20261104182542_project-memory',
        hash:
          mode === 'wrong-hash'
            ? '0'.repeat(64)
            : '400df9992d2b2580a503ea138acbd6f35cd332c02c44483e188c1768ea2570b4',
      });
      store = new Knowledge(file);
      if (mode === 'known') {
        await store.ready;
        expect((await store.read('mock-alpha', document.id)).content).toBe(
          'SYNTHETIC RETAINED TEXT',
        );
      } else await expect(store.ready).rejects.toMatchObject({ code: 'KNOWLEDGE_CORRUPT' });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(['known', 'wrong-hash', 'unknown-name'] as const)(
  'ordinary Groups check closed Delivery metadata migrations: %s',
  async (mode) => {
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
        name:
          mode === 'unknown-name' ? '20261104110815_unknown' : '20261104110815_delivery-reference',
        hash:
          mode === 'wrong-hash'
            ? '0'.repeat(64)
            : 'c2725ed1a22a373fa6331400c96f8caf3dc2bed8417eda602708f07b4ccaa345',
      });
      pastMigration(file, {
        name: '20261105075222_delivery-origins',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });
      store = new Groups(file, runner);
      if (mode === 'known') {
        await store.ready;
        expect((await store.status()).available).toBe(true);
      } else await expect(store.ready).rejects.toThrow('DATABASE_NEWER');
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([{ opaque: 'synthetic retired provenance' }, null, false])(
  'archived Delivery provenance %j stays visible and blocks the whole retry chain',
  async (delivery) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-task-'));
    try {
      const journal = new TaskJournal(root);
      const record = {
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
        delivery,
      };
      await journal.put(record);
      const ordinary = { ...record, runId: 'mock-ordinary', delivery: undefined };
      const retry = {
        ...record,
        runId: 'mock-retry',
        intentId: 'mock-run',
        delivery: undefined,
      };
      await journal.put(ordinary);
      await journal.put(retry);
      const reopened = new TaskJournal(root);
      await reopened.load();
      expect(await reopened.read('mock-alpha', 'mock-run')).toHaveProperty('delivery');
      expect((await reopened.recovery('mock-alpha', 'mock-run'))?.blocked).toBe(true);
      expect((await reopened.recovery('mock-alpha', 'mock-retry'))?.blocked).toBe(true);
      expect((await reopened.recovery('mock-alpha', 'mock-ordinary'))?.blocked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(['pending', 'claimed', 'running'])(
  'an old Delivery group turn in %s cannot auto-dispatch while fresh ordinary messages execute',
  async (state) => {
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
      db.prepare('UPDATE group_deliveries SET state=? WHERE source=?').run(state, 'mock-old-turn');
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
      const revision = (await store.status()).revision;
      await store.close();
      store = new Groups(file, runner);
      await store.ready;
      expect((await store.status()).revision).toBe(revision);
      const archived = new DatabaseSync(file);
      expect(
        archived
          .prepare('SELECT delivery FROM group_collaborations WHERE source=?')
          .get('mock-old-source')?.delivery,
      ).toBe('{"opaque":"synthetic provenance"}');
      expect(
        archived
          .prepare('SELECT state,error FROM group_deliveries WHERE source=?')
          .get('mock-old-turn'),
      ).toEqual({ state: 'cancelled', error: 'DELIVERY_RETIRED' });
      archived.close();
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
