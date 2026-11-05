import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const documents = sqliteTable(
  'documents',
  {
    id: text().primaryKey(),
    bot: text().notNull(),
    path: text().notNull(),
    revision: integer().notNull(),
    content: text().notNull(),
    bytes: integer().notNull(),
    deleted: integer().notNull(),
    created: text().notNull(),
    updated: text().notNull(),
  },
  (table) => [
    unique('documents_bot_path').on(table.bot, table.path),
    index('document_owner').on(table.bot, table.deleted, table.updated),
  ],
);

export const revisions = sqliteTable(
  'revisions',
  {
    document: text().notNull(),
    revision: integer().notNull(),
    path: text().notNull(),
    content: text().notNull(),
    bytes: integer().notNull(),
    deleted: integer().notNull(),
    at: text().notNull(),
    actor: text().notNull(),
    run: text(),
  },
  (table) => [primaryKey({ columns: [table.document, table.revision] })],
);

export const sources = sqliteTable(
  'sources',
  {
    document: text().primaryKey(),
    bot: text().notNull(),
    name: text().notNull(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    data: blob({ mode: 'buffer' }).notNull(),
  },
  (table) => [unique('sources_bot_name').on(table.bot, table.name)],
);

export const knowledgeImports = sqliteTable('knowledge_imports', {
  bot: text().primaryKey(),
  digest: text().notNull(),
});
