import type { GoalResumeTarget } from '@daban/protocol';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const goalLinks = sqliteTable('goal_links', {
  owner: text().primaryKey(),
  session: text().notNull(),
  goal: text().notNull(),
  revision: integer().notNull(),
});
export const goalHumans = sqliteTable('goal_humans', {
  owner: text().primaryKey(),
  epoch: integer().notNull(),
});
export const goalHumanTurns = sqliteTable('goal_human_turns', {
  id: text().primaryKey(),
  owner: text().notNull(),
  epoch: integer().notNull(),
});
export const goalGrants = sqliteTable('goal_grants', {
  id: text().primaryKey(),
  owner: text().notNull(),
  run: text().notNull(),
  target: text({ mode: 'json' }).$type<GoalResumeTarget>().notNull(),
  epoch: integer().notNull(),
  fingerprint: text().notNull(),
  claimed: integer({ mode: 'boolean' }).notNull().default(false),
});
