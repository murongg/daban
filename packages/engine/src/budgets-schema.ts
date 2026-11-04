import type {
  BudgetPolicy,
  BudgetPrice,
  BudgetView,
  BudgetSettings,
  TokenUsage,
  UsagePurpose,
} from '@daban/protocol';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const budgetTasks = sqliteTable(
  'budget_tasks',
  {
    id: text().primaryKey(),
    root: text().notNull(),
    revision: integer().notNull(),
    policy: text({ mode: 'json' }).$type<BudgetPolicy>().notNull(),
    prices: text({ mode: 'json' }).$type<BudgetPrice[]>().notNull(),
    state: text().$type<BudgetView['state']>().notNull(),
    warned: integer({ mode: 'boolean' }).notNull().default(false),
    historyUnmetered: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('budget_root').on(t.root)],
);
export const budgetReceipts = sqliteTable('budget_receipts', {
  id: text().primaryKey(),
  budget: text()
    .notNull()
    .references(() => budgetTasks.id),
  revision: integer().notNull(),
  run: text().notNull(),
  modelAttempt: text().notNull(),
  session: text().notNull(),
  rootSession: text().notNull(),
  purpose: text().$type<UsagePurpose>().notNull(),
  route: text().notNull(),
  auth: text().notNull(),
  fingerprint: text().notNull(),
  phase: text().$type<'reserved' | 'dispatched' | 'settled' | 'released' | 'unknown'>().notNull(),
  tokens: integer().notNull(),
  micros: integer(),
  estimated: integer(),
  price: text({ mode: 'json' }).$type<BudgetPrice>(),
  usage: text({ mode: 'json' }).$type<TokenUsage>(),
  created: text().notNull(),
});
export const budgetSettings = sqliteTable('budget_settings', {
  scope: text().notNull().default(''),
  id: integer().primaryKey(),
  revision: integer().notNull(),
  policy: text({ mode: 'json' }).$type<BudgetPolicy>().notNull(),
  prices: text({ mode: 'json' }).$type<BudgetPrice[]>().notNull(),
});
export const budgetActions = sqliteTable('budget_actions', {
  id: text().primaryKey(),
  fingerprint: text().notNull(),
  result: text({ mode: 'json' }).$type<BudgetView | BudgetSettings>().notNull(),
});
export const budgetRuns = sqliteTable('budget_runs', {
  id: text().primaryKey(),
  budget: text()
    .notNull()
    .references(() => budgetTasks.id),
  activeMs: integer().notNull().default(0),
  coverage: text({ mode: 'json' }).$type<Record<string, boolean>>().notNull().default({}),
});
export const budgetTools = sqliteTable('budget_tools', {
  id: text().primaryKey(),
  budget: text()
    .notNull()
    .references(() => budgetTasks.id),
});

export const budgetPrices = sqliteTable('budget_prices', {
  id: text().primaryKey(),
  snapshot: text({ mode: 'json' }).$type<BudgetPrice>().notNull(),
});
