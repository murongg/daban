import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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

export const galleryUsers = sqliteTable('gallery_auth_users', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
export const galleryAuthSessions = sqliteTable(
  'gallery_auth_sessions',
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => galleryUsers.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [index('gallery_auth_session_user').on(table.userId)],
);
export const galleryAccounts = sqliteTable(
  'gallery_auth_accounts',
  {
    id: text().primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => galleryUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text(),
    password: text(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('gallery_auth_provider_account').on(table.providerId, table.accountId),
    index('gallery_auth_account_user').on(table.userId),
  ],
);
export const galleryVerifications = sqliteTable(
  'gallery_auth_verifications',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('gallery_auth_verification_identifier').on(table.identifier)],
);
export const galleryRateLimits = sqliteTable('gallery_auth_rate_limits', {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: integer('last_request').notNull(),
});
export const galleryNamespaces = sqliteTable('gallery_namespaces', {
  namespace: text().primaryKey(),
  // Legacy names and deleted-user tombstones remain reserved; they must never be auto-claimed.
  userId: text('user_id').unique(),
});
