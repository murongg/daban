import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const releasePackages = sqliteTable('release_packages', {
  digest: text().primaryKey(),
  bytes: integer().notNull(),
});
export const releaseDrafts = sqliteTable('release_drafts', {
  bot: text().unique(),
  template: text().primaryKey(),
  revision: integer().notNull(),
  content: text().notNull(),
});
export const releaseSources = sqliteTable('release_sources', {
  origin: text().primaryKey(),
  sourceId: text().notNull(),
  name: text().notNull(),
  token: text(),
});
export const releaseSnapshots = sqliteTable('release_snapshots', {
  digest: text().primaryKey(),
  content: text().notNull(),
});
export const releaseInstallations = sqliteTable('release_installations', {
  bot: text().primaryKey(),
  template: text().notNull(),
  version: text().notNull(),
  base: text().notNull(),
  snapshot: text().notNull(),
  source: text(),
  revision: integer().notNull(),
});
export const releaseHistory = sqliteTable(
  'release_history',
  {
    at: text().notNull().default(''),
    bot: text().notNull(),
    revision: integer().notNull(),
    snapshot: text().notNull(),
    base: text().notNull(),
    version: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.revision] })],
);
export const releaseOperations = sqliteTable('release_operations', {
  id: text().primaryKey(),
  fingerprint: text().notNull(),
  result: text().notNull(),
});
export const releasePlans = sqliteTable('release_plans', {
  cancelled: integer().notNull().default(0),
  committed: text(),
  id: text().primaryKey(),
  bot: text().notNull(),
  revision: integer().notNull(),
  content: text().notNull(),
});
export const releaseReservations = sqliteTable('release_reservations', {
  id: text().primaryKey(),
  fingerprint: text().notNull(),
  bot: text().notNull(),
});
export const authoredReleases = sqliteTable(
  'authored_releases',
  {
    template: text().notNull(),
    version: text().notNull(),
    digest: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.template, table.version] })],
);
