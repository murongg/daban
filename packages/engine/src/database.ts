import type { DatabaseSync } from 'node:sqlite';
import { and, DrizzleQueryError, eq, like, ne, not, sql } from 'drizzle-orm';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export type Migration = MigrationMeta;
export type Database = ReturnType<typeof connect>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface Pragmas {
  journal?: 'WAL';
  synchronous?: 'FULL' | 'NORMAL';
  foreignKeys?: boolean;
  busyTimeout?: number;
  secureDelete?: boolean;
}

const journalName = '__drizzle_migrations';
const journal = sqliteTable(journalName, {
  id: integer().primaryKey(),
  hash: text().notNull(),
  createdAt: integer('created_at'),
  name: text(),
  appliedAt: text('applied_at'),
});
const master = sqliteTable('sqlite_master', { type: text().notNull(), name: text().notNull() });

function connect(client: DatabaseSync) {
  return drizzle({ client });
}

// Callers keep receiving the SQLite failure itself rather than Drizzle's query wrapper.
export function unwrap(error: unknown) {
  return error instanceof DrizzleQueryError && error.cause instanceof Error ? error.cause : error;
}
export function configure(client: DatabaseSync, pragmas: Pragmas) {
  const settings: string[] = [];
  if (pragmas.journal) settings.push(`journal_mode=${pragmas.journal}`);
  if (pragmas.synchronous) settings.push(`synchronous=${pragmas.synchronous}`);
  if (pragmas.foreignKeys) settings.push('foreign_keys=ON');
  if (pragmas.busyTimeout !== undefined)
    settings.push(`busy_timeout=${Math.trunc(pragmas.busyTimeout)}`);
  if (pragmas.secureDelete) settings.push('secure_delete=ON');
  if (settings.length) client.exec(settings.map((setting) => `PRAGMA ${setting};`).join(''));
}

export function tables(client: DatabaseSync | Database) {
  const db = 'prepare' in client ? connect(client) : client;
  return db
    .select({ name: master.name })
    .from(master)
    .where(
      and(
        eq(master.type, 'table'),
        not(like(master.name, 'sqlite_%')),
        ne(master.name, journalName),
      ),
    )
    .orderBy(master.name)
    .all()
    .map((row) => row.name);
}

export function migrationApplied(db: Database, migration: { name: string; hash: string }) {
  return !!db
    .select({ name: journal.name })
    .from(journal)
    .where(and(eq(journal.name, migration.name), eq(journal.hash, migration.hash)))
    .get();
}

export function checkpoint(db: Database) {
  const row = db.$client.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  return row?.busy === 0;
}

function record(migration: Migration) {
  return {
    hash: migration.hash,
    createdAt: migration.folderMillis,
    name: migration.name,
    appliedAt: new Date().toISOString(),
  };
}

// Pre-ORM files have tables but no journal: `legacy` brings them to the first migration's schema.
export function migrate(
  client: DatabaseSync,
  migrations: readonly Migration[],
  legacy?: (client: DatabaseSync) => unknown,
  retired: readonly { name: string; hash: string }[] = [],
) {
  const db = connect(client);
  const [baseline] = migrations;
  if (!baseline) throw new Error('DATABASE_MIGRATIONS_MISSING');
  db.transaction(
    (tx) => {
      const journaled = tx
        .select({ name: master.name })
        .from(master)
        .where(and(eq(master.type, 'table'), eq(master.name, journalName)))
        .get();
      if (!journaled) {
        const existing = tables(db).length > 0;
        if (existing && !legacy) throw new Error('DATABASE_UNVERSIONED');
        tx.run(
          sql.raw(
            `CREATE TABLE ${journalName}(id INTEGER PRIMARY KEY,hash text NOT NULL,created_at numeric,name text,applied_at TEXT)`,
          ),
        );
        if (existing) {
          legacy?.(client);
          tx.insert(journal).values(record(baseline)).run();
        }
      }
      const applied = tx.select({ name: journal.name, hash: journal.hash }).from(journal).all();
      const known = new Set(migrations.map((migration) => migration.name));
      // Retired feature migrations are recognized only as existing data; never execute them on new files.
      if (
        applied.some(
          (row) =>
            row.name === null ||
            (!known.has(row.name) &&
              !retired.some(
                (migration) => migration.name === row.name && migration.hash === row.hash,
              )),
        )
      )
        throw new Error('DATABASE_NEWER');
      const done = new Set(applied.map((row) => row.name));
      for (const migration of migrations) {
        if (done.has(migration.name)) continue;
        for (const statement of migration.sql) if (statement.trim()) tx.run(sql.raw(statement));
        tx.insert(journal).values(record(migration)).run();
      }
    },
    { behavior: 'immediate' },
  );
  return db;
}
