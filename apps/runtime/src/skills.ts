import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isSkillBinding,
  isSkillCatalog,
  isSkillDocument,
  isSkillName,
  type SkillBinding,
  type SkillCatalog,
  type SkillDocument,
  type SkillEntry,
  type SkillInvocation,
  validAgentId,
} from '@daban/protocol';
import { parse } from 'yaml';
import { Fault } from './control.js';

export interface SkillRecipe {
  name: string;
  description: string;
  content: string;
  invocation: SkillInvocation;
}
export interface SkillSnapshot {
  available: boolean;
  key: string;
  skills: SkillRecipe[];
}
const invalid = (): never => {
  throw new Fault('INVALID_SKILL', 400);
};
export function parseSkill(content: unknown) {
  if (
    typeof content !== 'string' ||
    content.length > 100000 ||
    Buffer.byteLength(content) > 200000 ||
    content.includes('\0')
  )
    return invalid();
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return invalid();
  let data: Record<string, unknown>;
  try {
    const value: unknown = parse(match[1], { uniqueKeys: true, maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    data = value as Record<string, unknown>;
  } catch {
    return invalid();
  }
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const body = content.slice(match[0].length).trim();
  if (
    !isSkillName(name) ||
    !description ||
    description.length > 2000 ||
    !body ||
    ['disableModelInvocation', 'modelInvocable', 'userInvocable'].some((key) =>
      Object.hasOwn(data, key),
    )
  )
    return invalid();
  const flag = (key: string, fallback: boolean) => {
    if (!Object.hasOwn(data, key)) return fallback;
    const value = data[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') {
      if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true;
      if (['false', 'no', 'off'].includes(value.toLowerCase())) return false;
    }
    return invalid();
  };
  return {
    name,
    description,
    content,
    body,
    invocation: {
      modelInvocable: !flag('disable-model-invocation', false),
      userInvocable: flag('user-invocable', true),
    },
  };
}
type Row = Record<string, unknown>;
export class Skills {
  // shortcut: one runtime writes a data root; add a process lease before allowing multiple services.
  readonly ready: Promise<unknown>;
  private db?: DatabaseSync;
  private failed = false;
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load().catch(() => {
      this.failed = true;
    });
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Fault('SKILLS_UNAVAILABLE', 503);
    } finally {
      await handle.close();
    }
    await chmod(this.file, 0o600);
    const db = new DatabaseSync(this.file);
    this.db = db;
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
      .sort();
    if (
      (version === 0 && tables.length) ||
      (version !== 0 && version !== 1) ||
      (version === 1 && tables.join(',') !== 'skill_bindings,skill_meta,skills')
    )
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    // An existing catalog is validated, never repaired by re-creating missing consent or revision rows.
    if (version === 0)
      db.exec(`
      CREATE TABLE skills(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,content TEXT NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE skill_bindings(bot TEXT NOT NULL,skill TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(bot,skill));
      CREATE TABLE skill_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT INTO skill_meta VALUES(1,0); PRAGMA user_version=1;`);
    this.revision();
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM skills').get()!.count) > 100)
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    const documents = new Map(
      db
        .prepare('SELECT * FROM skills')
        .all()
        .map((row) => {
          const document = this.document(row);
          return [document.id, document] as const;
        }),
    );
    for (const row of db.prepare('SELECT * FROM skill_bindings').all()) {
      const document = documents.get(String(row.skill));
      if (
        !validAgentId(row.bot) ||
        !document ||
        !Number.isSafeInteger(row.revision) ||
        Number(row.revision) < 1 ||
        ![0, 1].includes(Number(row.enabled)) ||
        (document.deleted && row.enabled === 1)
      )
        throw new Fault('SKILLS_UNAVAILABLE', 503);
    }
  }
  private available() {
    if (this.failed || this.closed || !this.db) throw new Fault('SKILLS_UNAVAILABLE', 503);
    return this.db;
  }
  private revision() {
    const value = this.available()
      .prepare('SELECT revision FROM skill_meta WHERE id=1')
      .get()?.revision;
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    return Number(value);
  }
  private transaction<T>(action: () => T) {
    const db = this.available();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      if (this.revision() >= Number.MAX_SAFE_INTEGER - 1) throw new Fault('SKILL_LIMIT');
      db.prepare('UPDATE skill_meta SET revision=revision+1 WHERE id=1').run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async status() {
    await this.ready;
    try {
      return { available: true, revision: this.revision() };
    } catch {
      return { available: false, error: 'SKILLS_UNAVAILABLE' };
    }
  }
  private row(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_SKILL', 400);
    const row = this.available().prepare('SELECT * FROM skills WHERE id=?').get(id);
    if (!row) throw new Fault('SKILL_NOT_FOUND', 404);
    return row;
  }
  private document(row: Row): SkillDocument {
    const parsed = parseSkill(row.content);
    const result = {
      id: row.id,
      name: parsed.name,
      description: parsed.description,
      revision: row.revision,
      size: Buffer.byteLength(parsed.content),
      deleted: row.deleted === 1,
      createdAt: row.created,
      updatedAt: row.updated,
      content: parsed.content,
      invocation: parsed.invocation,
    };
    if (
      row.name !== result.name ||
      ![0, 1].includes(Number(row.deleted)) ||
      !isSkillDocument(result)
    )
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    return result;
  }
  private entry(bot: string, row: Row): SkillEntry {
    const { content: _content, ...summary } = this.document(row);
    const binding = this.available()
      .prepare('SELECT * FROM skill_bindings WHERE bot=? AND skill=?')
      .get(bot, summary.id);
    return {
      ...summary,
      enabled: !summary.deleted && binding?.enabled === 1,
      bindingRevision: Number(binding?.revision ?? 0),
    };
  }
  async list(bot: string, deleted = false): Promise<SkillCatalog> {
    await this.ready;
    if (!validAgentId(bot) || typeof deleted !== 'boolean') throw new Fault('INVALID_SKILL', 400);
    const result = {
      revision: this.revision(),
      items: this.available()
        .prepare('SELECT * FROM skills WHERE deleted=? ORDER BY name')
        .all(Number(deleted))
        .map((row) => this.entry(bot, row)),
    };
    if (!isSkillCatalog(result)) throw new Fault('SKILLS_UNAVAILABLE', 503);
    return result;
  }
  async read(id: string) {
    await this.ready;
    return this.document(this.row(id));
  }
  private importPlan(contents: string[]) {
    if (!Array.isArray(contents) || contents.length > 20) return invalid();
    const parsed = Array.from(contents).map(parseSkill),
      db = this.available();
    if (new Set(parsed.map((item) => item.name)).size !== parsed.length) return invalid();
    const entries = parsed.map((item) => ({
      item,
      prior: db.prepare('SELECT * FROM skills WHERE name=?').get(item.name),
    }));
    for (const entry of entries) {
      if (entry.prior?.deleted === 1) throw new Fault('SKILL_ARCHIVED');
      if (entry.prior && entry.prior.content !== entry.item.content)
        throw new Fault('SKILL_NAME_CONFLICT');
    }
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM skills').get()!.count);
    if (count + entries.filter((entry) => !entry.prior).length > 100)
      throw new Fault('SKILL_LIMIT');
    return entries;
  }
  async checkImport(contents: string[]) {
    await this.ready;
    this.importPlan(contents);
  }
  async importBatch(contents: string[]) {
    await this.ready;
    const plan = this.importPlan(contents);
    if (plan.every((entry) => entry.prior)) return plan.map((entry) => this.document(entry.prior!));
    return this.transaction(() =>
      plan.map((entry) => {
        if (entry.prior) return this.document(entry.prior);
        const id = randomUUID(),
          now = new Date().toISOString();
        this.available()
          .prepare('INSERT INTO skills VALUES(?,?,1,?,0,?,?)')
          .run(id, entry.item.name, entry.item.content, now, now);
        return this.document(this.row(id));
      }),
    );
  }
  async import(content: string) {
    return (await this.importBatch([content]))[0];
  }
  private check(row: Row, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Fault('INVALID_SKILL', 400);
    if (row.revision !== revision) throw new Fault('SKILL_CONFLICT');
    if (revision >= Number.MAX_SAFE_INTEGER - 1) throw new Fault('SKILL_LIMIT');
  }
  async update(id: string, revision: number, content: string) {
    await this.ready;
    const row = this.row(id);
    this.check(row, revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const parsed = parseSkill(content),
      db = this.available();
    if (db.prepare('SELECT id FROM skills WHERE name=? AND id<>?').get(parsed.name, id))
      throw new Fault('SKILL_NAME_CONFLICT');
    if (row.content !== content)
      this.transaction(() =>
        db
          .prepare('UPDATE skills SET name=?,content=?,revision=revision+1,updated=? WHERE id=?')
          .run(parsed.name, content, new Date().toISOString(), id),
      );
    return this.document(this.row(id));
  }
  private async setDeleted(id: string, revision: number, deleted: boolean) {
    await this.ready;
    const row = this.row(id);
    this.check(row, revision);
    if ((row.deleted === 1) !== deleted)
      this.transaction(() => {
        const db = this.available();
        db.prepare('UPDATE skills SET deleted=?,revision=revision+1,updated=? WHERE id=?').run(
          Number(deleted),
          new Date().toISOString(),
          id,
        );
        // Restoring a document must never restore another Bot's old enablement consent.
        if (deleted)
          db.prepare('UPDATE skill_bindings SET enabled=0,revision=revision+1 WHERE skill=?').run(
            id,
          );
      });
    return this.document(this.row(id));
  }
  recycle(id: string, revision: number) {
    return this.setDeleted(id, revision, true);
  }
  restore(id: string, revision: number) {
    return this.setDeleted(id, revision, false);
  }
  async bind(bot: string, input: SkillBinding) {
    await this.ready;
    if (!validAgentId(bot) || !isSkillBinding(input)) throw new Fault('INVALID_SKILL', 400);
    const row = this.row(input.id);
    this.check(row, input.revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const current = this.entry(bot, row);
    if (current.bindingRevision !== input.bindingRevision)
      throw new Fault('SKILL_BINDING_CONFLICT');
    if (current.enabled !== input.enabled) {
      const db = this.available();
      if (
        input.enabled &&
        Number(
          db
            .prepare('SELECT COUNT(*) AS count FROM skill_bindings WHERE bot=? AND enabled=1')
            .get(bot)!.count,
        ) >= 20
      )
        throw new Fault('SKILL_ACTIVE_LIMIT');
      this.transaction(() =>
        db
          .prepare(
            'INSERT INTO skill_bindings VALUES(?,?,?,?) ON CONFLICT(bot,skill) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled',
          )
          .run(bot, input.id, current.bindingRevision + 1, Number(input.enabled)),
      );
    }
    return this.entry(bot, row);
  }
  async capture(bot: string): Promise<SkillSnapshot> {
    await this.ready;
    if (!validAgentId(bot)) throw new Fault('INVALID_SKILL', 400);
    try {
      const rows = this.available()
        .prepare(
          'SELECT s.* FROM skills s JOIN skill_bindings b ON b.skill=s.id WHERE b.bot=? AND b.enabled=1 AND s.deleted=0 ORDER BY s.name',
        )
        .all(bot);
      if (rows.length > 20) throw new Fault('SKILLS_UNAVAILABLE', 503);
      const documents = rows.map((row) => this.document(row));
      return {
        available: true,
        key: documents.length
          ? createHash('sha256')
              .update(JSON.stringify(documents.map((item) => [item.id, item.revision])))
              .digest('hex')
          : '',
        skills: documents.map((item) => {
          const parsed = parseSkill(item.content);
          return {
            name: item.name,
            description: item.description,
            content: parsed.body,
            invocation: { ...item.invocation },
          };
        }),
      };
    } catch {
      return { available: false, key: 'unavailable', skills: [] };
    }
  }
  async close() {
    this.closed = true;
    await this.ready;
    this.db?.close();
    this.db = undefined;
  }
}
