import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SkillPackage } from '@daban/protocol';
import { expect, test } from 'vitest';
import { tables } from './database.js';
import { Skills } from './skills.js';

const content =
  '---\nname: mock-complete\ndescription: Synthetic complete skill\n---\nRead references/guide.txt and use assets/data.bin.\n';
const bundle = (text = 'SYNTHETIC ORIGINAL'): SkillPackage => ({
  root: 'mock-complete',
  files: [
    { path: 'SKILL.md', data: Buffer.from(content).toString('base64') },
    { path: 'references/guide.txt', data: Buffer.from(text).toString('base64') },
    { path: 'assets/data.bin', data: Buffer.from([0, 1, 255]).toString('base64') },
  ],
});
async function fixture(action: (root: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-store-'));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('migrates legacy skill storage without changing saved content, bindings or revisions', async () =>
  fixture(async (root) => {
    const file = path.join(root, 'skills.sqlite'),
      db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE skills(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,content TEXT NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL); CREATE TABLE skill_bindings(bot TEXT NOT NULL,skill TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(bot,skill)); CREATE TABLE skill_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT INTO skill_meta VALUES(1,7); PRAGMA user_version=1;',
    );
    db.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?,?)').run(
      'mock-id',
      'mock-complete',
      3,
      content,
      0,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare('INSERT INTO skill_bindings VALUES(?,?,?,?)').run('mock-bot', 'mock-id', 2, 1);
    db.close();
    const store = new Skills(file);
    try {
      expect((await store.read('mock-id')).content).toBe(content);
      const item = (await store.list('mock-bot')).items[0];
      expect(item.enabled).toBe(true);
      expect(item.revision).toBe(3);
      expect(item.bindingRevision).toBe(2);
      expect((await store.status()).revision).toBe(7);
      const reader = new DatabaseSync(file, { readOnly: true });
      try {
        expect(tables(reader)).toStrictEqual([
          'skill_bindings',
          'skill_files',
          'skill_meta',
          'skill_packages',
          'skills',
        ]);
      } finally {
        reader.close();
      }
      const owned = await store.importPackage(bundle(), 'mock-bot');
      expect(owned.ownerBot).toBe('mock-bot');
      expect((await store.status()).revision).toBe(8);
    } finally {
      await store.close();
    }
  }));
test('pre-ORM catalog versions 2 and 3 keep packages, bindings and revisions after the schema baseline', async () => {
  for (const version of [2, 3])
    await fixture(async (root) => {
      const file = path.join(root, 'skills.sqlite');
      let store = new Skills(file);
      const skill = await store.importPackage(bundle());
      await store.bind('mock-a', {
        id: skill.id,
        revision: skill.revision,
        bindingRevision: 0,
        enabled: true,
      });
      const before = await store.status();
      await store.close();
      // Rewrite the file into the exact layout a pre-ORM build left behind for this version.
      const old = new DatabaseSync(file);
      old.exec(
        version === 3
          ? 'ALTER TABLE skills DROP COLUMN managed; DROP TABLE __drizzle_migrations; PRAGMA user_version=3;'
          : `DROP TABLE __drizzle_migrations; DROP INDEX skill_owner_name; ALTER TABLE skills RENAME TO skills_v3;
            CREATE TABLE skills(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,content TEXT NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,resources TEXT);
            INSERT INTO skills SELECT id,name,revision,content,deleted,created,updated,resources FROM skills_v3;
            DROP TABLE skills_v3; PRAGMA user_version=2;`,
      );
      old.close();
      store = new Skills(file);
      try {
        expect(await store.read(skill.id), String(version)).toStrictEqual(skill);
        expect(await store.status()).toStrictEqual(before);
        const item = (await store.list('mock-a')).items[0];
        expect(item.enabled).toBe(true);
        expect(item.bindingRevision).toBe(1);
        const resource = await store.readResource(skill.id, skill.revision, 'assets/data.bin');
        expect(Buffer.from(resource.data, 'base64')).toStrictEqual(Buffer.from([0, 1, 255]));
        const owned = await store.importPackage(bundle('SYNTHETIC PRIVATE'), 'mock-a');
        expect(owned.ownerBot).toBe('mock-a');
        expect((await store.list('mock-a')).items.map((entry) => entry.id)).toStrictEqual([
          owned.id,
        ]);
      } finally {
        await store.close();
      }
    });
});
test('retains binary resources, preserves immutable active snapshots and keeps imports disabled', async () =>
  fixture(async (root) => {
    const store = new Skills(path.join(root, 'skills.sqlite'));
    try {
      const imported = await Reflect.apply(store.importBatch, store, [[bundle()]]);
      const skill = imported[0];
      expect.assert(skill.package);
      expect(skill.package.fileCount).toBe(3);
      expect((await store.list('mock-a')).items[0].enabled).toBe(false);
      await store.bind('mock-a', {
        id: skill.id,
        revision: skill.revision,
        bindingRevision: 0,
        enabled: true,
      });
      const captured = await store.capture('mock-a');
      const updated = await Reflect.get(store, 'updatePackage').call(
        store,
        skill.id,
        skill.revision,
        bundle('SYNTHETIC NEW'),
      );
      const old = await Reflect.get(store, 'readCaptured').call(
        store,
        captured,
        'mock-complete',
        'references/guide.txt',
      );
      expect(Buffer.from(old.data, 'base64').toString()).toBe('SYNTHETIC ORIGINAL');
      const current = await Reflect.get(store, 'readResource').call(
        store,
        skill.id,
        updated.revision,
        'references/guide.txt',
      );
      expect(Buffer.from(current.data, 'base64').toString()).toBe('SYNTHETIC NEW');
      const full = await Reflect.get(store, 'exportPackage').call(
        store,
        skill.id,
        updated.revision,
      );
      expect(
        Buffer.from(
          full.files.find((f: { path: string }) => f.path === 'assets/data.bin')!.data,
          'base64',
        ),
      ).toStrictEqual(Buffer.from([0, 1, 255]));
      await Reflect.get(store, 'release').call(store, captured);
      await expect(
        Reflect.get(store, 'readCaptured').call(
          store,
          captured,
          'mock-complete',
          'references/guide.txt',
        ),
      ).rejects.toMatchObject({ code: 'SKILL_SNAPSHOT_EXPIRED' });
      expect((await store.capture('mock-b')).skills.length).toBe(0);
      await expect(
        Reflect.get(store, 'updatePackage').call(store, skill.id, skill.revision, bundle()),
      ).rejects.toMatchObject({ code: 'SKILL_CONFLICT' });
    } finally {
      await store.close();
    }
  }));
