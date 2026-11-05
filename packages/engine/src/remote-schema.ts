import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const remoteDevices = sqliteTable('remote_devices', {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  name: text().notNull(),
  role: text().notNull(),
  server: text().notNull(),
  workspace: text().notNull(),
  platform: text().notNull(),
});
export const remoteSettings = sqliteTable('remote_settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
export const remoteReceipts = sqliteTable(
  'remote_receipts',
  {
    device: text().notNull(),
    id: text().notNull(),
    fingerprint: text().notNull(),
    phase: text().notNull(),
    result: text(),
    created: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.device, table.id] })],
);
