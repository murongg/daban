import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const gallerySettings = sqliteTable('gallery_settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
export const galleryTokens = sqliteTable('gallery_tokens', {
  id: text().primaryKey(),
  hash: text().notNull().unique(),
  principal: text().notNull(),
});
export const gallerySessions = sqliteTable('gallery_sessions', {
  hash: text().primaryKey(),
  token: text().notNull(),
  csrf: text().notNull(),
  expires: integer().notNull(),
});
export const galleryTemplates = sqliteTable(
  'gallery_templates',
  {
    revision: integer().notNull().default(1),
    state: text().notNull().default('active'),
    id: text().primaryKey(),
    namespace: text().notNull(),
    slug: text().notNull(),
    content: text().notNull(),
  },
  (table) => [uniqueIndex('gallery_namespace_slug').on(table.namespace, table.slug)],
);
export const galleryReleases = sqliteTable(
  'gallery_releases',
  {
    template: text().notNull(),
    version: text().notNull(),
    content: text().notNull(),
    revision: integer().notNull().default(1),
    mutation: text().notNull().default(''),
  },
  (table) => [primaryKey({ columns: [table.template, table.version] })],
);
export const galleryRequests = sqliteTable('gallery_requests', {
  key: text().primaryKey(),
  fingerprint: text().notNull(),
  result: text().notNull(),
});
