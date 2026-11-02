import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isSkillBinding,
  isSkillCatalog,
  isSkillDocument,
  isSkillPath,
  type SkillBinding,
  type SkillCatalog,
  type SkillDocument,
  type SkillEntry,
  type SkillInvocation,
  type SkillPackage,
  type SkillPackageInfo,
  type SkillResource,
  type SkillResourceData,
  validAgentId,
} from '@daban/protocol';
import { parseSkill } from './skill-content.js';
import { type SkillFileSet, SkillFiles } from './skill-files.js';
import { skillHash } from './skill-package.js';

export { parseSkill } from './skill-content.js';

import { Fault } from './control.js';

export interface SkillRecipe {
  name: string;
  description: string;
  content: string;
  invocation: SkillInvocation;
  metadata?: Record<string, unknown>;
  package?: SkillPackageInfo;
  files?: SkillResource[];
}
export interface SkillSnapshot {
  available: boolean;
  key: string;
  skills: SkillRecipe[];
}
export interface SkillDefault {
  id: string;
  package: SkillPackage;
}
const invalid = (): never => {
  throw new Fault('INVALID_SKILL', 400);
};
type Row = Record<string, unknown>;
export class Skills {
  // shortcut: one runtime writes a data root; add a process lease before allowing multiple services.
  readonly ready: Promise<unknown>;
  private db?: DatabaseSync;
  private failed = false;
  private closed = false;
  private files?: SkillFiles;
  private readonly snapshots = new WeakMap<
    SkillSnapshot,
    Map<string, { id: string; revision: number; content: string; resources: string | null }>
  >();
  private readonly pins = new Map<string, number>();
  constructor(
    readonly file: string,
    private readonly defaults: readonly SkillDefault[] = [],
  ) {
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
    this.files = new SkillFiles(db);
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name))
      .sort();
    if (
      (version === 0 && tables.length) ||
      ![0, 1, 2].includes(version) ||
      (version === 1 && tables.join(',') !== 'skill_bindings,skill_meta,skills') ||
      (version === 2 &&
        tables.join(',') !== 'skill_bindings,skill_files,skill_meta,skill_packages,skills')
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
    // Validate existing consent and content before migrating; a corrupt store must never be "repaired" by migration.
    if (version < 2) this.files.migrate();
    for (const skill of this.defaults) {
      if (!validAgentId(skill.id)) throw new Fault('INVALID_SKILL');
      const prepared = this.files.prepare(skill.package),
        parsed = parseSkill(prepared.content, true);
      // Defaults never replace user-authored names or consume the last slot of a full existing library.
      if (
        db.prepare('SELECT id FROM skills WHERE id=? OR name=?').get(skill.id, parsed.name) ||
        Number(db.prepare('SELECT COUNT(*) AS count FROM skills').get()!.count) >= 100
      )
        continue;
      const now = new Date().toISOString();
      this.transaction(() => {
        this.files!.save(prepared.set);
        db.prepare(
          'INSERT INTO skills(id,name,revision,content,deleted,created,updated,resources) VALUES(?,?,1,?,0,?,?,?)',
        ).run(skill.id, parsed.name, prepared.content, now, now, prepared.set.key);
      });
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
      this.files!.collect(new Set(this.pins.keys()));
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
    const parsed = parseSkill(row.content, typeof row.resources === 'string');
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
      ...(this.defaults.some((skill) => skill.id === row.id) ? { system: true as const } : {}),
      ...this.files!.info(parsed.content, row.resources),
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
    const { content: _content, files: _files, ...summary } = this.document(row);
    const binding = this.available()
      .prepare('SELECT * FROM skill_bindings WHERE bot=? AND skill=?')
      .get(bot, summary.id);
    // A newly shipped default must not displace an existing Bot's twenty explicitly enabled skills.
    const defaultEnabled =
      !!summary.system &&
      Number(
        this.available()
          .prepare(
            'SELECT COUNT(*) AS count FROM skill_bindings b JOIN skills s ON s.id=b.skill WHERE b.bot=? AND b.enabled=1 AND s.deleted=0',
          )
          .get(bot)!.count,
      ) < 20;
    return {
      ...summary,
      enabled: !summary.deleted && (binding ? binding.enabled === 1 : defaultEnabled),
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
  private importPlan(contents: (string | SkillPackage)[]) {
    if (!Array.isArray(contents) || contents.length > 20) return invalid();
    const parsed = Array.from(contents).map((input) => {
        if (typeof input === 'string')
          return { parsed: parseSkill(input), set: undefined as SkillFileSet | undefined };
        const prepared = this.files!.prepare(input);
        return { parsed: parseSkill(prepared.content, true), set: prepared.set };
      }),
      db = this.available();
    if (new Set(parsed.map((item) => item.parsed.name)).size !== parsed.length) return invalid();
    const entries = parsed.map(({ parsed: item, set }) => ({
      item,
      set,
      prior: db.prepare('SELECT * FROM skills WHERE name=?').get(item.name),
    }));
    for (const entry of entries) {
      if (entry.prior?.deleted === 1) throw new Fault('SKILL_ARCHIVED');
      if (
        entry.prior &&
        (entry.prior.content !== entry.item.content ||
          JSON.stringify(this.files!.manifest(entry.prior.resources)) !==
            JSON.stringify(entry.set?.manifest ?? []))
      )
        throw new Fault('SKILL_NAME_CONFLICT');
    }
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM skills').get()!.count);
    if (count + entries.filter((entry) => !entry.prior).length > 100)
      throw new Fault('SKILL_LIMIT');
    this.files!.checkCapacity(
      entries.flatMap((entry) => (entry.set ? [entry.set] : [])),
      new Set(this.pins.keys()),
    );
    return entries;
  }
  async checkImport(contents: (string | SkillPackage)[]) {
    await this.ready;
    this.importPlan(contents);
  }
  async importBatch(contents: (string | SkillPackage)[]) {
    await this.ready;
    const plan = this.importPlan(contents);
    if (plan.every((entry) => entry.prior)) return plan.map((entry) => this.document(entry.prior!));
    return this.transaction(() =>
      plan.map((entry) => {
        if (entry.prior) return this.document(entry.prior);
        const id = randomUUID(),
          now = new Date().toISOString();
        if (entry.set) this.files!.save(entry.set);
        this.available()
          .prepare(
            'INSERT INTO skills(id,name,revision,content,deleted,created,updated,resources) VALUES(?,?,1,?,0,?,?,?)',
          )
          .run(id, entry.item.name, entry.item.content, now, now, entry.set?.key ?? null);
        return this.document(this.row(id));
      }),
    );
  }
  async import(content: string) {
    return (await this.importBatch([content]))[0];
  }
  async importPackage(bundle: SkillPackage) {
    return (await this.importBatch([bundle]))[0];
  }
  private check(row: Row, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Fault('INVALID_SKILL', 400);
    if (row.revision !== revision) throw new Fault('SKILL_CONFLICT');
    if (revision >= Number.MAX_SAFE_INTEGER - 1) throw new Fault('SKILL_LIMIT');
  }
  private mutable(id: string) {
    if (this.defaults.some((skill) => skill.id === id))
      throw new Fault('SKILL_SYSTEM_READ_ONLY', 409);
  }
  private activeRows(bot: string) {
    return this.available()
      .prepare('SELECT * FROM skills WHERE deleted=0 ORDER BY name')
      .all()
      .filter((row) => this.entry(bot, row).enabled);
  }
  async update(id: string, revision: number, content: string) {
    await this.ready;
    const row = this.row(id);
    this.mutable(id);
    this.check(row, revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const parsed = parseSkill(content, typeof row.resources === 'string'),
      db = this.available();
    this.files!.info(content, row.resources);
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
  async updatePackage(id: string, revision: number, bundle: SkillPackage) {
    await this.ready;
    const row = this.row(id);
    this.mutable(id);
    this.check(row, revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const prepared = this.files!.prepare(bundle),
      parsed = parseSkill(prepared.content, true);
    if (
      this.available().prepare('SELECT id FROM skills WHERE name=? AND id<>?').get(parsed.name, id)
    )
      throw new Fault('SKILL_NAME_CONFLICT');
    if (
      row.content !== prepared.content ||
      JSON.stringify(this.files!.manifest(row.resources)) !== JSON.stringify(prepared.set.manifest)
    )
      this.transaction(() => {
        this.files!.save(prepared.set);
        this.available()
          .prepare(
            'UPDATE skills SET name=?,content=?,resources=?,revision=revision+1,updated=? WHERE id=?',
          )
          .run(parsed.name, prepared.content, prepared.set.key, new Date().toISOString(), id);
      });
    return this.document(this.row(id));
  }
  async readResource(id: string, revision: number, name: string): Promise<SkillResourceData> {
    await this.ready;
    const row = this.row(id);
    this.check(row, revision);
    return this.resource(
      {
        id,
        revision,
        content: String(row.content),
        resources: typeof row.resources === 'string' ? row.resources : null,
      },
      name,
    );
  }
  private resource(
    source: { id: string; revision: number; content: string; resources: string | null },
    name: string,
  ): SkillResourceData {
    if (!isSkillPath(name)) return invalid();
    if (name === 'SKILL.md')
      return {
        id: source.id,
        revision: source.revision,
        file: {
          path: name,
          size: Buffer.byteLength(source.content),
          sha256: skillHash(source.content),
          executable: false,
        },
        data: Buffer.from(source.content).toString('base64'),
      };
    if (!source.resources) throw new Fault('SKILL_FILE_NOT_FOUND', 404);
    return {
      id: source.id,
      revision: source.revision,
      ...this.files!.read(source.resources, name),
    };
  }
  async exportPackage(id: string, revision: number) {
    await this.ready;
    const row = this.row(id);
    this.check(row, revision);
    return this.files!.bundle(
      String(row.content),
      typeof row.resources === 'string' ? row.resources : null,
    );
  }
  private captured(snapshot: SkillSnapshot, name: string) {
    this.available();
    const source = this.snapshots.get(snapshot)?.get(name);
    if (!source) throw new Fault('SKILL_SNAPSHOT_EXPIRED', 410);
    return source;
  }
  async readCaptured(snapshot: SkillSnapshot, name: string, file: string) {
    await this.ready;
    return this.resource(this.captured(snapshot, name), file);
  }
  async listCaptured(snapshot: SkillSnapshot, name: string) {
    await this.ready;
    const source = this.captured(snapshot, name);
    return [this.resource(source, 'SKILL.md').file, ...this.files!.manifest(source.resources)];
  }
  async exportCaptured(snapshot: SkillSnapshot, name: string) {
    await this.ready;
    const source = this.captured(snapshot, name);
    return this.files!.bundle(source.content, source.resources);
  }
  release(snapshot: SkillSnapshot) {
    const sources = this.snapshots.get(snapshot);
    if (!sources) return;
    for (const source of sources.values())
      if (source.resources) {
        const count = this.pins.get(source.resources) ?? 0;
        if (count <= 1) this.pins.delete(source.resources);
        else this.pins.set(source.resources, count - 1);
      }
    this.snapshots.delete(snapshot);
  }
  private async setDeleted(id: string, revision: number, deleted: boolean) {
    await this.ready;
    this.mutable(id);
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
    // Remember an explicit opt-out even when a full Bot currently leaves the default inactive.
    if (
      current.enabled !== input.enabled ||
      (current.system && current.bindingRevision === 0 && !input.enabled)
    ) {
      const db = this.available();
      if (input.enabled && this.activeRows(bot).length >= 20) throw new Fault('SKILL_ACTIVE_LIMIT');
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
      const rows = this.activeRows(bot);
      if (rows.length > 20) throw new Fault('SKILLS_UNAVAILABLE', 503);
      const documents = rows.map((row) => this.document(row));
      const snapshot: SkillSnapshot = {
        available: true,
        key: documents.length
          ? createHash('sha256')
              .update(JSON.stringify(documents.map((item) => [item.id, item.revision])))
              .digest('hex')
          : '',
        skills: documents.map((item) => {
          const parsed = parseSkill(item.content, !!item.package);
          return {
            name: item.name,
            description: item.description,
            content: parsed.body || parsed.description,
            invocation: { ...item.invocation },
            ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
            ...(item.package ? { package: item.package, files: item.files } : {}),
          };
        }),
      };
      const sources = new Map(
        rows.map((row) => [
          String(row.name),
          {
            id: String(row.id),
            revision: Number(row.revision),
            content: String(row.content),
            resources: typeof row.resources === 'string' ? row.resources : null,
          },
        ]),
      );
      this.snapshots.set(snapshot, sources);
      for (const source of sources.values())
        if (source.resources)
          this.pins.set(source.resources, (this.pins.get(source.resources) ?? 0) + 1);
      return snapshot;
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
