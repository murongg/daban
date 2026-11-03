import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const uploads = sqliteTable(
  'uploads',
  {
    bot: text().notNull(),
    id: text().notNull(),
    name: text().notNull(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    data: blob({ mode: 'buffer' }).notNull(),
    content: text().notNull(),
    deleted: integer().notNull().default(0),
    version: text(),
    previous: text(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.id] })],
);

export const purges = sqliteTable(
  'purges',
  {
    bot: text().notNull(),
    id: text().notNull(),
    version: text().notNull(),
    confirmation: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.id, table.version] })],
);
