import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projectItems = sqliteTable('project_items', {
  id: text().primaryKey(),
  value: text().notNull(),
  revision: integer().notNull(),
});
export const projectBindings = sqliteTable('project_bindings', {
  project: text().primaryKey(),
  value: text().notNull(),
});
export const projectOperations = sqliteTable('project_operations', {
  id: text().primaryKey(),
  signature: text().notNull(),
  request: text().notNull(),
  resources: text().notNull(),
  receipt: text().notNull(),
});
