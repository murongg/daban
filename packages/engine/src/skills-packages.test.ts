import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { SkillPackage } from '@daban/protocol';
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
      assert.equal((await store.read('mock-id')).content, content);
      const item = (await store.list('mock-bot')).items[0];
      assert.equal(item.enabled, true);
      assert.equal(item.revision, 3);
      assert.equal(item.bindingRevision, 2);
      assert.equal((await store.status()).revision, 7);
      const reader = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(reader.prepare('PRAGMA user_version').get()!.user_version, 3);
      } finally {
        reader.close();
      }
    } finally {
      await store.close();
    }
  }));
test('retains binary resources, preserves immutable active snapshots and keeps imports disabled', async () =>
  fixture(async (root) => {
    const store = new Skills(path.join(root, 'skills.sqlite'));
    try {
      const imported = await Reflect.apply(store.importBatch, store, [[bundle()]]);
      const skill = imported[0];
      assert.ok(skill.package);
      assert.equal(skill.package.fileCount, 3);
      assert.equal((await store.list('mock-a')).items[0].enabled, false);
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
      assert.equal(Buffer.from(old.data, 'base64').toString(), 'SYNTHETIC ORIGINAL');
      const current = await Reflect.get(store, 'readResource').call(
        store,
        skill.id,
        updated.revision,
        'references/guide.txt',
      );
      assert.equal(Buffer.from(current.data, 'base64').toString(), 'SYNTHETIC NEW');
      const full = await Reflect.get(store, 'exportPackage').call(
        store,
        skill.id,
        updated.revision,
      );
      assert.deepEqual(
        Buffer.from(
          full.files.find((f: { path: string }) => f.path === 'assets/data.bin')!.data,
          'base64',
        ),
        Buffer.from([0, 1, 255]),
      );
      await Reflect.get(store, 'release').call(store, captured);
      await assert.rejects(
        Reflect.get(store, 'readCaptured').call(
          store,
          captured,
          'mock-complete',
          'references/guide.txt',
        ),
        { code: 'SKILL_SNAPSHOT_EXPIRED' },
      );
      assert.equal((await store.capture('mock-b')).skills.length, 0);
      await assert.rejects(
        Reflect.get(store, 'updatePackage').call(store, skill.id, skill.revision, bundle()),
        { code: 'SKILL_CONFLICT' },
      );
    } finally {
      await store.close();
    }
  }));
