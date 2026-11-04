import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const schedules = sqliteTable('schedules', {
  id: text().primaryKey(),
  bot: text().notNull(),
  input: text().notNull(),
  record: text().notNull(),
  revision: integer().notNull(),
  enabled: integer().notNull(),
  deleted: integer().notNull().default(0),
  created: text().notNull(),
  updated: text().notNull(),
});

export const firings = sqliteTable(
  'firings',
  {
    id: text().primaryKey(),
    schedule: text().notNull(),
    bot: text().notNull(),
    occurrence: text().notNull(),
    created: text().notNull(),
    state: text().notNull(),
    prompt: text().notNull(),
    run: text(),
    error: text(),
    source: text(),
    monitor: text(),
    unknownAck: integer().notNull().default(0),
  },
  (table) => [
    index('firing_schedule').on(table.schedule, table.created),
    index('firing_pending').on(table.state, table.created),
  ],
);

export const automations = sqliteTable('automations', {
  schedule: text().primaryKey(),
  configRevision: integer().notNull(),
  policy: text().notNull(),
  committed: text(),
  candidate: text(),
  consecutive: integer().notNull().default(0),
  cursor: integer().notNull().default(0),
  nextPoll: integer().notNull().default(0),
  observeError: text(),
  resultDigest: text(),
  resultError: text(),
  noticeRevision: integer().notNull().default(0),
  notice: text(),
});

export const automationEvents = sqliteTable('automation_events', {
  id: text().primaryKey(),
  schedule: text().notNull(),
  configRevision: integer().notNull(),
  cursor: integer().notNull(),
  before: text().notNull(),
  after: text().notNull(),
  paths: text().notNull(),
  observed: text().notNull(),
});
