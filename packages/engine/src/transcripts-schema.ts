import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const transcriptRuns = sqliteTable('transcript_runs', {
  run: text().primaryKey(),
  scope: text().notNull(),
  state: text().notNull(),
});

export const transcriptEvents = sqliteTable(
  'transcript_events',
  {
    run: text().notNull(),
    seq: integer().notNull(),
    source: text().notNull(),
    meta: text().notNull(),
    body: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.run, table.seq] }),
    unique('transcript_events_run_source').on(table.run, table.source),
  ],
);
