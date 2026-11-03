import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const commands = sqliteTable('commands', {
  id: text().primaryKey(),
  fingerprint: text().notNull(),
  request: text().notNull(),
  phase: text().notNull(),
  decision: text(),
  result: text(),
});
