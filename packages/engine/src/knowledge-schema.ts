import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const documents = sqliteTable(
  'documents',
  {
    id: text().primaryKey(),
    bot: text().notNull(),
    path: text().notNull(),
    revision: integer().notNull(),
    content: text().notNull(),
    bytes: integer().notNull(),
    deleted: integer().notNull(),
    created: text().notNull(),
    updated: text().notNull(),
  },
  (table) => [
    unique('documents_bot_path').on(table.bot, table.path),
    index('document_owner').on(table.bot, table.deleted, table.updated),
  ],
);

export const revisions = sqliteTable(
  'revisions',
  {
    document: text().notNull(),
    revision: integer().notNull(),
    path: text().notNull(),
    content: text().notNull(),
    bytes: integer().notNull(),
    deleted: integer().notNull(),
    at: text().notNull(),
    actor: text().notNull(),
    run: text(),
  },
  (table) => [primaryKey({ columns: [table.document, table.revision] })],
);

export const sources = sqliteTable(
  'sources',
  {
    document: text().primaryKey(),
    bot: text().notNull(),
    name: text().notNull(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    data: blob({ mode: 'buffer' }).notNull(),
  },
  (table) => [unique('sources_bot_name').on(table.bot, table.name)],
);

export const knowledgeImports = sqliteTable('knowledge_imports', {
  bot: text().primaryKey(),
  digest: text().notNull(),
});

export const projectDocuments = sqliteTable(
  'project_documents',
  {
    id: text().primaryKey(),
    project: text().notNull(),
    kind: text().notNull(),
    title: text().notNull(),
    revision: integer().notNull(),
    content: text().notNull(),
    bytes: integer().notNull(),
    deleted: integer().notNull(),
    origin: text(),
    created: text().notNull(),
    updated: text().notNull(),
  },
  (table) => [index('project_document_owner').on(table.project, table.deleted, table.updated)],
);

export const projectRevisions = sqliteTable(
  'project_revisions',
  {
    project: text().notNull(),
    document: text().notNull(),
    revision: integer().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    bytes: integer().notNull(),
    deleted: integer().notNull(),
    origin: text(),
    at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.project, table.document, table.revision] })],
);

export const projectCandidates = sqliteTable(
  'project_candidates',
  {
    id: text().primaryKey(),
    project: text().notNull(),
    scopeRevision: integer().notNull(),
    proposer: text().notNull(),
    revision: integer().notNull(),
    state: text().notNull(),
    content: text().notNull(),
    reason: text().notNull(),
    refs: text().notNull(),
    digest: text().notNull(),
    created: text().notNull(),
    updated: text().notNull(),
    reviewed: text(),
  },
  (table) => [
    unique('project_candidate_dedup').on(
      table.project,
      table.scopeRevision,
      table.proposer,
      table.digest,
    ),
    index('project_candidate_owner').on(table.project, table.proposer, table.state),
  ],
);

export const projectMemoryOperations = sqliteTable(
  'project_memory_operations',
  {
    project: text().notNull(),
    actor: text().notNull(),
    request: text().notNull(),
    signature: text().notNull(),
    result: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.project, table.actor, table.request] })],
);
