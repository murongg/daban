import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const computers = sqliteTable('computers', {
  bot: text().primaryKey(),
  revision: integer().notNull(),
  phase: text().notNull(),
  desired: integer().notNull(),
  slot: integer().unique(),
  instance: text(),
  boot: text().notNull(),
  error: text(),
  recovery: text(),
  updated: text().notNull(),
});

export const computerCommands = sqliteTable('computer_commands', {
  id: text().primaryKey(),
  bot: text().notNull(),
  signature: text().notNull(),
  action: text().notNull(),
  phase: text().notNull(),
  error: text(),
  uncertain: integer().notNull().default(0),
});

export const computerMeta = sqliteTable(
  'computer_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('computer_meta_singleton', sql`${table.id} = 1`)],
);
