import type { GoalResumeTarget } from '@daban/protocol';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const groupDefs = sqliteTable('group_defs', {
  id: text().primaryKey(),
  value: text().notNull(),
  copyOrigin: text('copy_origin'),
});

export const groupActions = sqliteTable(
  'group_actions',
  {
    id: text().primaryKey(),
    grp: text().notNull(),
    value: text().notNull(),
  },
  (table) => [index('group_actions_owner').on(table.grp)],
);

export const groupTurns = sqliteTable(
  'group_turns',
  {
    grp: text().notNull(),
    id: text().notNull(),
    // Retain the shipped column so removing the product never deletes existing user data.
    legacyBudget: text('budget', { mode: 'json' }).$type<unknown>(),
    prompt: text().notNull(),
    recipients: text().notNull(),
    signature: text().notNull(),
    seq: integer(),
    created: text().notNull(),
    state: text().notNull(),
    inputs: text().notNull().default('[]'),
    automation: text(),
  },
  (table) => [primaryKey({ columns: [table.grp, table.id] })],
);

export const groupMessages = sqliteTable(
  'group_messages',
  {
    seq: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull(),
    grp: text().notNull(),
    source: text().notNull(),
    role: text().notNull(),
    text: text().notNull(),
    created: text().notNull(),
    author: text(),
    name: text(),
    phase: text(),
    model: text(),
    files: text(),
    run: text(),
  },
  (table) => [
    unique('group_messages_grp_id').on(table.grp, table.id),
    index('group_messages_page').on(table.grp, table.seq),
  ],
);

export const groupDeliveries = sqliteTable(
  'group_deliveries',
  {
    id: text().primaryKey(),
    grp: text().notNull(),
    source: text().notNull(),
    bot: text().notNull(),
    position: integer().notNull(),
    state: text().notNull(),
    run: text(),
    retryOf: text(),
    retryStage: text(),
    goalResume: text({ mode: 'json' }).$type<GoalResumeTarget>(),
    context: text(),
    name: text(),
    error: text(),
  },
  (table) => [index('group_deliveries_queue').on(table.grp, table.source, table.position)],
);

export const groupHandoffs = sqliteTable('group_handoffs', {
  source: text().primaryKey(),
  signature: text().notNull(),
  target: text().notNull(),
});

export const groupCollaborations = sqliteTable('group_collaborations', {
  source: text().primaryKey(),
  grp: text().notNull(),
  turn: text().notNull(),
  signature: text().notNull(),
});

export const groupMeta = sqliteTable(
  'group_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('group_meta_singleton', sql`${table.id} = 1`)],
);

export const legacyBudgetResumes = sqliteTable('group_budget_resumes', {
  id: text().primaryKey(),
  signature: text().notNull(),
});
