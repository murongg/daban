import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const schedules = sqliteTable('schedules', {
  id: text().primaryKey(),
  bot: text().notNull(),
  input: text().notNull(),
  record: text().notNull(),
  revision: integer().notNull(),
  enabled: integer().notNull(),
  deleted: integer().notNull().default(0),
  created: text().notNull(),
  updated: text().notNull(),
});

export const firings = sqliteTable(
  'firings',
  {
    id: text().primaryKey(),
    schedule: text().notNull(),
    bot: text().notNull(),
    occurrence: text().notNull(),
    created: text().notNull(),
    state: text().notNull(),
    prompt: text().notNull(),
    run: text(),
    error: text(),
  },
  (table) => [
    index('firing_schedule').on(table.schedule, table.created),
    index('firing_pending').on(table.state, table.created),
  ],
);
