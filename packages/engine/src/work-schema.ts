import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workItems = sqliteTable(
  'work_items',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    title: text().notNull(),
    description: text().notNull(),
    progress: text().notNull(),
    status: text().notNull(),
    revision: integer().notNull(),
    deleted: integer().notNull(),
    created: text().notNull(),
    updated: text().notNull(),
    completed: text(),
    creator: text().notNull(),
    editor: text().notNull(),
    priority: text().notNull().default('normal'),
    assignee: text(),
  },
  (table) => [
    check('work_items_priority', sql`${table.priority} IN ('low','normal','high','urgent')`),
  ],
);

export const workOperations = sqliteTable('work_operations', {
  id: text().primaryKey(),
  item: text()
    .notNull()
    .references(() => workItems.id),
  signature: text().notNull(),
  revision: integer().notNull(),
  at: text().notNull(),
});

export const workMeta = sqliteTable(
  'work_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
    comments: integer().notNull().default(0),
  },
  (table) => [
    check('work_meta_singleton', sql`${table.id} = 1`),
    check('work_meta_comments', sql`${table.comments} >= 0`),
  ],
);

export const workComments = sqliteTable('work_comments', {
  seq: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  item: text()
    .notNull()
    .references(() => workItems.id),
  body: text().notNull(),
  creator: text().notNull(),
  signature: text().notNull(),
  revision: integer().notNull(),
  at: text().notNull(),
});

export const workChecklists = sqliteTable('work_checklists', {
  workId: text()
    .primaryKey()
    .references(() => workItems.id),
  revision: integer().notNull(),
  items: text().notNull(),
});
export const workDeliveries = sqliteTable('work_deliveries', {
  seq: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  workId: text()
    .notNull()
    .references(() => workItems.id),
  requestId: text().notNull().unique(),
  activeWorkId: text().unique(),
  value: text().notNull(),
});
export const workDecisions = sqliteTable('work_decisions', {
  attemptId: text()
    .primaryKey()
    .references(() => workDeliveries.id),
  requestId: text().notNull().unique(),
  value: text().notNull(),
});
export const workDeliveryOperations = sqliteTable('work_delivery_operations', {
  id: text().primaryKey(),
  workId: text()
    .notNull()
    .references(() => workItems.id),
  signature: text().notNull(),
  value: text().notNull(),
});
