import {
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const noteItems = sqliteTable(
  'note_items',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    bot: text().notNull(),
    id: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    status: text().notNull(),
    revision: integer().notNull(),
    deleted: integer().notNull(),
    created: text().notNull(),
    updated: text().notNull(),
    completed: text(),
    creator: text().notNull(),
    editor: text().notNull(),
  },
  (table) => [unique().on(table.bot, table.id)],
);

export const noteOperations = sqliteTable(
  'note_operations',
  {
    bot: text().notNull(),
    id: text().notNull(),
    note: text().notNull(),
    signature: text().notNull(),
    revision: integer().notNull(),
    at: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bot, table.id] }),
    foreignKey({
      columns: [table.bot, table.note],
      foreignColumns: [noteItems.bot, noteItems.id],
    }),
  ],
);

export const noteMeta = sqliteTable('note_meta', {
  bot: text().primaryKey(),
  revision: integer().notNull(),
});
