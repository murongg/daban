import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const integrations = sqliteTable(
  'integrations',
  {
    id: text().primaryKey(),
    revision: integer().notNull(),
    name: text().notNull(),
    nameKey: text('name_key').notNull(),
    endpoint: text().notNull(),
    bearer: text(),
    authKind: text('auth_kind').notNull().default('bearer'),
    credentialEpoch: integer('credential_epoch').notNull().default(0),
    deleted: integer().notNull(),
    health: text().notNull(),
    catalog: text().notNull(),
    digest: text(),
    checked: text(),
    error: text(),
    created: text().notNull(),
    updated: text().notNull(),
    owner: text(),
  },
  (table) => [
    uniqueIndex('integration_owner_name').on(sql`COALESCE(${table.owner},'')`, table.nameKey),
  ],
);

export const oauthGrants = sqliteTable('oauth_grants', {
  connection: text().primaryKey(),
  app: text().notNull().default('notion'),
  epoch: integer().notNull(),
  state: text().notNull(),
  issuer: text().notNull(),
  resource: text().notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret'),
  redirectUri: text('redirect_uri').notNull(),
  tokenEndpoint: text('token_endpoint').notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at'),
  scope: text().notNull(),
  identity: text(),
});
export const oauthAttempts = sqliteTable('oauth_attempts', {
  requestId: text('request_id').primaryKey(),
  attempt: text().notNull().unique(),
  hash: text().notNull(),
  bot: text().notNull(),
  connection: text().notNull(),
  app: text().notNull().default('notion'),
  clientId: text('client_id'),
  clientSecret: text('client_secret'),
  redirectUri: text('redirect_uri'),
  revision: integer().notNull(),
  name: text().notNull(),
  nameKey: text('name_key').notNull(),
  phase: text().notNull(),
  deadline: integer().notNull(),
  error: text(),
});

export const integrationBindings = sqliteTable(
  'integration_bindings',
  {
    bot: text().notNull(),
    connection: text().notNull(),
    revision: integer().notNull(),
    configRevision: integer('config_revision').notNull(),
    digest: text(),
    tools: text().notNull(),
    enabled: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.connection] })],
);

export const configCommands = sqliteTable('config_commands', {
  id: text().primaryKey(),
  hash: text().notNull(),
  connection: text().notNull(),
  revision: integer().notNull(),
});

export const callReceipts = sqliteTable(
  'call_receipts',
  {
    id: text().primaryKey(),
    hash: text().notNull(),
    semantic: text().notNull(),
    bot: text().notNull(),
    run: text().notNull(),
    session: text().notNull(),
    connection: text().notNull(),
    configRevision: integer('config_revision').notNull(),
    tool: text().notNull(),
    phase: text().notNull(),
    preview: text().notNull(),
    // Retain the historical column and migration so existing receipt databases still open.
    policyDecision: text(),
    result: text(),
    error: text(),
    created: text().notNull(),
    updated: text().notNull(),
  },
  (table) => [index('receipt_owner').on(table.bot, table.run, table.semantic)],
);

export const integrationMeta = sqliteTable(
  'integration_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('integration_meta_singleton', sql`${table.id} = 1`)],
);
