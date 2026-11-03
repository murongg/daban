import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { configure, type Migration, migrate, tables } from './database.js';

const baseline: Migration = {
  name: '20260101000000_baseline',
  folderMillis: 1767225600000,
  hash: 'baseline',
  bps: true,
  sql: ['CREATE TABLE items(id TEXT PRIMARY KEY,label TEXT NOT NULL);\n', '\n'],
};
const extra: Migration = {
  name: '20260102000000_extra',
  folderMillis: 1767312000000,
  hash: 'extra',
  bps: true,
  sql: ['ALTER TABLE items ADD COLUMN size INTEGER;\n'],
};

async function scratch(run: (file: string) => unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-database-'));
  try {
    await run(path.join(directory, 'store.db'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function columns(client: DatabaseSync) {
  return client
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all('items')
    .map((row) => String(row.name));
}

function journal(client: DatabaseSync) {
  return client
    .prepare('SELECT name FROM __drizzle_migrations ORDER BY id')
    .all()
    .map((row) => String(row.name));
}

test('fresh files run every migration once and record them', async () => {
  await scratch((file) => {
    const client = new DatabaseSync(file);
    configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
    const db = migrate(client, [baseline, extra]);
    expect(tables(db)).toEqual(['items']);
    expect(columns(client)).toEqual(['id', 'label', 'size']);
    expect(journal(client)).toEqual([baseline.name, extra.name]);
    migrate(client, [baseline, extra]);
    expect(journal(client)).toEqual([baseline.name, extra.name]);
    expect(client.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    client.close();
  });
});

test('pre-ORM files are upgraded by the legacy step and then baselined', async () => {
  await scratch((file) => {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE items(id TEXT PRIMARY KEY);INSERT INTO items VALUES('a');");
    old.close();
    const client = new DatabaseSync(file);
    const db = migrate(client, [baseline, extra], (legacy) => {
      legacy.exec("ALTER TABLE items ADD COLUMN label TEXT NOT NULL DEFAULT ''");
    });
    expect(columns(client)).toEqual(['id', 'label', 'size']);
    expect(journal(client)).toEqual([baseline.name, extra.name]);
    expect(db.all(sql`SELECT id FROM items`)).toEqual([{ id: 'a' }]);
    client.close();
  });
});

test('unversioned files without a legacy step and newer files are refused', async () => {
  await scratch((file) => {
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE items(id TEXT PRIMARY KEY);');
    expect(() => migrate(old, [baseline])).toThrow('DATABASE_UNVERSIONED');
    expect(tables(old)).toEqual(['items']);
    old.close();
  });
  await scratch((file) => {
    const client = new DatabaseSync(file);
    migrate(client, [baseline, extra]);
    expect(() => migrate(client, [baseline])).toThrow('DATABASE_NEWER');
    client.close();
  });
});

test('a failing legacy step leaves the file untouched', async () => {
  await scratch((file) => {
    const client = new DatabaseSync(file);
    client.exec('CREATE TABLE items(id TEXT PRIMARY KEY);');
    expect(() =>
      migrate(client, [baseline], (legacy) => {
        legacy.exec('CREATE TABLE partial(id TEXT)');
        throw new Error('LEGACY_CORRUPT');
      }),
    ).toThrow('LEGACY_CORRUPT');
    expect(tables(client)).toEqual(['items']);
    expect(
      client.prepare("SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'").get(),
    ).toBeUndefined();
    client.close();
  });
});
