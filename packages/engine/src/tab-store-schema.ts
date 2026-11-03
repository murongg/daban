import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const browserTabs = sqliteTable('browser_tabs', {
  id: text().primaryKey(),
  bot: text().notNull(),
  url: text().notNull(),
  title: text().notNull(),
  position: integer().notNull(),
});

export const browserActive = sqliteTable('browser_active', {
  bot: text().primaryKey(),
  tab: text().notNull(),
});

export const browserCommands = sqliteTable('browser_commands', {
  id: text().primaryKey(),
  bot: text().notNull(),
  signature: text().notNull(),
  phase: text().notNull(),
  error: text(),
  uncertain: integer(),
});

export const browserMeta = sqliteTable(
  'browser_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('browser_meta_singleton', sql`${table.id} = 1`)],
);
