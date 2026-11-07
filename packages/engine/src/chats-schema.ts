import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const chats = sqliteTable('chats', {
  bot: text().primaryKey(),
  value: text().notNull(),
});

export const chatReceipts = sqliteTable('chat_receipts', {
  id: text().primaryKey(),
  bot: text().notNull(),
  value: text().notNull(),
});

export const conversationStates = sqliteTable(
  'conversation_states',
  {
    bot: text().notNull(),
    revision: integer().notNull(),
    value: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.revision] })],
);

export const conversationReceipts = sqliteTable('conversation_receipts', {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const chatMeta = sqliteTable(
  'chat_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('chat_meta_singleton', sql`${table.id} = 1`)],
);
