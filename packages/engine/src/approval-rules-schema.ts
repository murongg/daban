import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const approvalRules = sqliteTable('approval_rules', {
  id: text().primaryKey(),
  bot: text().notNull(),
  revision: integer().notNull(),
  deleted: integer().notNull(),
  value: text().notNull(),
});
export const approvalRuleEdits = sqliteTable('approval_rule_edits', {
  id: text().primaryKey(),
  bot: text().notNull(),
  hash: text().notNull(),
  receipt: text().notNull(),
});
export const approvalRuleMeta = sqliteTable('approval_rule_meta', {
  id: integer().primaryKey(),
  revision: integer().notNull(),
});
