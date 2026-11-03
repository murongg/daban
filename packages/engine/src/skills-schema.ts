import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Resource bytes are returned exactly as node:sqlite reads them so corrupt non-BLOB values stay detectable.
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'blob',
});

export const skills = sqliteTable(
  'skills',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    revision: integer().notNull(),
    content: text().notNull(),
    deleted: integer().notNull(),
    created: text().notNull(),
    updated: text().notNull(),
    resources: text(),
    owner: text(),
  },
  (table) => [uniqueIndex('skill_owner_name').on(sql`COALESCE(${table.owner}, '')`, table.name)],
);

export const skillBindings = sqliteTable(
  'skill_bindings',
  {
    bot: text().notNull(),
    skill: text().notNull(),
    revision: integer().notNull(),
    enabled: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.bot, table.skill] })],
);

export const skillMeta = sqliteTable(
  'skill_meta',
  {
    id: integer().primaryKey(),
    revision: integer().notNull(),
  },
  (table) => [check('skill_meta_singleton', sql`${table.id} = 1`)],
);

export const skillPackages = sqliteTable('skill_packages', {
  digest: text().primaryKey(),
  manifest: text().notNull(),
  bytes: integer().notNull(),
});

export const skillFiles = sqliteTable(
  'skill_files',
  {
    package: text().notNull(),
    path: text().notNull(),
    data: bytes().notNull(),
    sha: text().notNull(),
    executable: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.package, table.path] })],
);
