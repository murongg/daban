import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const integrations = sqliteTable(
  'integrations',
  {
    id: text().primaryKey(),
    revision: integer().notNull(),
    name: text().notNull(),
    nameKey: text('name_key').notNull(),
    endpoint: text().notNull(),
    bearer: text(),
    deleted: integer().notNull(),
    health: text().notNull(),
    catalog: text().notNull(),
    digest: text(),
    checked: text(),
    error: text(),
    created: text().notNull(),
    updated: text().notNull(),
    owner: text(),
  },
  (table) => [
    uniqueIndex('integration_owner_name').on(sql`COALESCE(${table.owner},'')`, table.nameKey),
  ],
);

export const integrationBindings = sqliteTable(
  'integration_bindings',
  {
    bot: text().notNull(),
    connection: text().notNull(),
    revision: integer().notNull(),
    configRevision: integer('config_revision').notNull(),
    digest: text(),
    tools: text().notNull(),
    enabled: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.connection] })],
);

export const configCommands = sqliteTable('config_commands', {
  id: text().primaryKey(),
  hash: text().notNull(),
  connection: text().notNull(),
  revision: integer().notNull(),
});

export const callReceipts = sqliteTable(
  'call_receipts',
  {
    id: text().primaryKey(),
    hash: text().notNull(),
    semantic: text().notNull(),
    bot: text().notNull(),
    run: text().notNull(),
    session: text().notNull(),
    connection: text().notNull(),
    configRevision: integer('config_revision').notNull(),
    tool: text().notNull(),
    phase: text().notNull(),
    preview: text().notNull(),
    // Retain the historical column and migration so existing receipt databases still open.
    policyDecision: text(),
    result: text(),
    error: text(),
    created: text().notNull(),
    updated: text().notNull(),
  },
  (table) => [index('receipt_owner').on(table.bot, table.run, table.semantic)],
);

export const integrationMeta = sqliteTable(
  'integration_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('integration_meta_singleton', sql`${table.id} = 1`)],
);
