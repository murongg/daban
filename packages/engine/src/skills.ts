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
import { and, count, eq, getTableColumns, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Fault } from './control.js';
import { configure, type Database, migrate, tables } from './database.js';
import { parseSkill } from './skill-content.js';
import { type SkillFileSet, SkillFiles, upgradeSkillFiles } from './skill-files.js';
import { inspectSkillPackage, skillHash } from './skill-package.js';
import { migrations } from './skills-migrations.js';
import { skillBindings, skillMeta, skills } from './skills-schema.js';

export { parseSkill } from './skill-content.js';

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
  previousDigests?: readonly string[];
  id: string;
  package: SkillPackage;
}
const invalid = (): never => {
  throw new Fault('INVALID_SKILL', 400);
};
type Row = typeof skills.$inferSelect;
const ownedBy = (owner: string | undefined) =>
  owner === undefined ? isNull(skills.owner) : eq(skills.owner, owner);
type SkillSource = { id: string; revision: number; content: string; resources: string | null };
export class Skills {
  templateOwners?: (bot: string) => string[];
  assertTemplateNames(bot: string, names: string[]) {
    const owners = this.templateOwners?.(bot) ?? [];
    if (
      this.visible(bot).some(
        (row) =>
          this.owner(row) === bot &&
          !owners.includes(this.owner(row) ?? '') &&
          names.includes(row.name),
      )
    )
      throw new Fault('SKILL_NAME_CONFLICT');
  }
  collectTemplateIndexes(keep: Set<string>) {
    const stale = this.available()
      .select({ id: skills.id, owner: skills.owner })
      .from(skills)
      .where(eq(skills.managed, 1))
      .all()
      .filter((row) => row.owner && !keep.has(row.owner))
      .map((row) => row.id);
    if (!stale.length) return;
    // Jobs pin immutable file packages; release snapshots can reconstruct these disposable indexes.
    this.transaction(() => {
      this.available().delete(skillBindings).where(inArray(skillBindings.skill, stale)).run();
      this.available().delete(skills).where(inArray(skills.id, stale)).run();
    });
  }
  disableTemplateBindings(bot: string, owners: string[]) {
    if (!owners.length) return;
    this.transaction(() =>
      this.available()
        .update(skillBindings)
        .set({ enabled: 0, revision: sql`${skillBindings.revision} + 1` })
        .where(
          and(
            eq(skillBindings.bot, bot),
            inArray(
              skillBindings.skill,
              this.available()
                .select({ id: skills.id })
                .from(skills)
                .where(inArray(skills.owner, owners)),
            ),
          ),
        )
        .run(),
    );
  }
  // shortcut: one runtime writes a data root; add a process lease before allowing multiple services.
  readonly ready: Promise<unknown>;
  private db?: Database;
  private failed = false;
  private closed = false;
  private files?: SkillFiles;
  private readonly snapshots = new WeakMap<SkillSnapshot, Map<string, SkillSource>>();
  private readonly pins = new Map<string, number>();
  private readonly snapshotBots = new WeakMap<SkillSnapshot, string>();
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
    const client = new DatabaseSync(this.file);
    // The legacy step validates through this same connection inside migrate's transaction.
    const db = drizzle({ client });
    this.db = db;
    this.files = new SkillFiles(db);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      migrate(client, migrations, (legacy) => this.upgrade(legacy));
      // An existing catalog is validated, never repaired by re-creating missing consent or revision rows.
      this.verify();
      this.install();
    } catch (error) {
      this.db = undefined;
      client.close();
      throw error;
    }
  }
  private upgrade(client: DatabaseSync) {
    const version = Number(client.prepare('PRAGMA user_version').get()!.user_version);
    const names = tables(client).join(',');
    if (
      ![1, 2, 3].includes(version) ||
      (version === 1 && names !== 'skill_bindings,skill_meta,skills') ||
      (version >= 2 && names !== 'skill_bindings,skill_files,skill_meta,skill_packages,skills')
    )
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    const columns = client
      .prepare('PRAGMA table_info(skills)')
      .all()
      .map((item) => String(item.name))
      .sort()
      .join(',');
    const expectedColumns = [
      'id',
      'name',
      'revision',
      'content',
      'deleted',
      'created',
      'updated',
      ...(version >= 2 ? ['resources'] : []),
      ...(version >= 3 ? ['owner'] : []),
    ]
      .sort()
      .join(',');
    if (columns !== expectedColumns) throw new Fault('SKILLS_UNAVAILABLE', 503);
    if (version < 2) upgradeSkillFiles(client);
    if (version < 3)
      client.exec(`ALTER TABLE skills RENAME TO skills_v2;
        CREATE TABLE skills(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,deleted INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,resources TEXT,owner TEXT);
        INSERT INTO skills SELECT id,name,revision,content,deleted,created,updated,resources,NULL FROM skills_v2;
        DROP TABLE skills_v2;
        CREATE UNIQUE INDEX skill_owner_name ON skills(COALESCE(owner,''),name);`);
    // A corrupt pre-ORM store rolls back with the upgrade; migration must never "repair" it.
    this.verify(true);
  }
  private verify(legacy = false) {
    const db = this.available();
    this.revision();
    if (db.select({ count: count() }).from(skills).get()!.count > 100)
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    // Legacy validation runs inside migrate's transaction before the later managed-column migration.
    const { managed: _managed, ...legacyColumns } = getTableColumns(skills);
    const rows = legacy
      ? db
          .select(legacyColumns)
          .from(skills)
          .all()
          .map((row) => ({ ...row, managed: 0 }))
      : db.select().from(skills).all();
    const documents = new Map(
      rows.map((row) => {
        const document = this.document(row);
        return [document.id, document] as const;
      }),
    );
    for (const row of db.select().from(skillBindings).all()) {
      const document = documents.get(String(row.skill));
      if (
        !validAgentId(row.bot) ||
        !document ||
        (document.ownerBot !== undefined && document.ownerBot !== row.bot) ||
        !Number.isSafeInteger(row.revision) ||
        Number(row.revision) < 1 ||
        ![0, 1].includes(Number(row.enabled)) ||
        (document.deleted && row.enabled === 1)
      )
        throw new Fault('SKILLS_UNAVAILABLE', 503);
    }
  }
  private install() {
    const db = this.available();
    for (const skill of this.defaults) {
      if (!validAgentId(skill.id)) throw new Fault('INVALID_SKILL');
      const prepared = this.files!.prepare(skill.package),
        parsed = parseSkill(prepared.content, true);
      const existing = db.select().from(skills).where(eq(skills.id, skill.id)).get();
      if (existing && skill.previousDigests) {
        const current = this.document(existing);
        // Only a checksum-known shipped revision may be upgraded; keep all per-Bot opt-outs and IDs intact.
        const expected = inspectSkillPackage(skill.package).digest;
        if (this.owner(existing) || current.name !== parsed.name)
          throw new Fault('SKILLS_UNAVAILABLE', 503);
        if (!current.deleted && current.package?.digest !== expected) {
          if (
            this.owner(existing) ||
            !current.package ||
            !skill.previousDigests.includes(current.package.digest)
          )
            throw new Fault('SKILLS_UNAVAILABLE', 503);
          this.files!.checkCapacity([prepared.set], new Set(this.pins.keys()));
          this.transaction(() => {
            this.files!.save(prepared.set);
            db.update(skills)
              .set({
                content: prepared.content,
                resources: prepared.set.key,
                revision: sql`${skills.revision} + 1`,
                updated: new Date().toISOString(),
              })
              .where(eq(skills.id, skill.id))
              .run();
          });
        }
      }
      // Defaults never replace user-authored names or consume the last slot of a full existing library.
      if (
        db
          .select({ id: skills.id })
          .from(skills)
          .where(
            or(eq(skills.id, skill.id), and(isNull(skills.owner), eq(skills.name, parsed.name))),
          )
          .get() ||
        db.select({ count: count() }).from(skills).get()!.count >= 100
      )
        continue;
      const now = new Date().toISOString();
      this.transaction(() => {
        this.files!.save(prepared.set);
        db.insert(skills)
          .values({
            id: skill.id,
            name: parsed.name,
            revision: 1,
            content: prepared.content,
            deleted: 0,
            created: now,
            updated: now,
            resources: prepared.set.key,
          })
          .run();
      });
    }
  }
  private available() {
    if (this.failed || this.closed || !this.db) throw new Fault('SKILLS_UNAVAILABLE', 503);
    return this.db;
  }
  private revision() {
    const value = this.available()
      .select({ revision: skillMeta.revision })
      .from(skillMeta)
      .where(eq(skillMeta.id, 1))
      .get()?.revision;
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    return Number(value);
  }
  private transaction<T>(action: () => T) {
    const db = this.available();
    // Boxing keeps the generic result distinguishable from a Promise for Drizzle's sync typing.
    const committed = db.transaction(
      () => {
        const result = action();
        this.files!.collect(new Set(this.pins.keys()));
        if (this.revision() >= Number.MAX_SAFE_INTEGER - 1) throw new Fault('SKILL_LIMIT');
        db.update(skillMeta)
          .set({ revision: sql`${skillMeta.revision} + 1` })
          .where(eq(skillMeta.id, 1))
          .run();
        return { result };
      },
      { behavior: 'immediate' },
    );
    return committed.result;
  }
  async status() {
    await this.ready;
    try {
      return { available: true, revision: this.revision() };
    } catch {
      return { available: false, error: 'SKILLS_UNAVAILABLE' };
    }
  }
  private owner(row: Row) {
    if (row.owner === null || row.owner === undefined) return undefined;
    if (!validAgentId(row.owner)) throw new Fault('SKILLS_UNAVAILABLE', 503);
    return row.owner;
  }
  private assertBot(bot?: string) {
    if (bot !== undefined && !validAgentId(bot)) throw new Fault('INVALID_SKILL', 400);
  }
  private visible(bot: string, deleted = false, owners = this.templateOwners?.(bot) ?? []) {
    const db = this.available();
    const rows = db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.deleted, Number(deleted)),
          or(
            isNull(skills.owner),
            eq(skills.owner, bot),
            owners.length ? inArray(skills.owner, owners) : undefined,
          ),
        ),
      )
      .orderBy(skills.name)
      .all();
    const owned = new Set(
      db
        .select({ name: skills.name })
        .from(skills)
        .where(
          or(
            and(eq(skills.owner, bot), eq(skills.managed, 0)),
            owners.length ? inArray(skills.owner, owners) : undefined,
          ),
        )
        .all()
        .map((row) => String(row.name)),
    );
    return rows.filter(
      (row) =>
        (!row.managed || owners.includes(this.owner(row) ?? '')) &&
        (this.owner(row) === bot ||
          owners.includes(this.owner(row) ?? '') ||
          !owned.has(this.document(row).name)),
    );
  }
  private scoped(id: string, bot?: string) {
    this.assertBot(bot);
    const row = this.row(id);
    if (row.managed && !(bot && this.templateOwners?.(bot).includes(this.owner(row) ?? '')))
      throw new Fault('SKILL_NOT_FOUND', 404);
    if (
      this.owner(row) !== undefined &&
      this.owner(row) !== bot &&
      !(bot && this.templateOwners?.(bot).includes(this.owner(row)!))
    )
      throw new Fault('SKILL_NOT_FOUND', 404);
    return row;
  }
  private row(id: string) {
    if (!validAgentId(id)) throw new Fault('INVALID_SKILL', 400);
    const row = this.available().select().from(skills).where(eq(skills.id, id)).get();
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
      ...(this.owner(row) ? { ownerBot: this.owner(row) } : {}),
      ...this.files!.info(parsed.content, row.resources),
    };
    if (
      row.name !== result.name ||
      ![0, 1].includes(Number(row.deleted)) ||
      ![0, 1].includes(row.managed) ||
      (row.managed === 1 && !row.owner) ||
      !isSkillDocument(result)
    )
      throw new Fault('SKILLS_UNAVAILABLE', 503);
    return result;
  }
  private entry(bot: string, row: Row): SkillEntry {
    const { content: _content, files: _files, ...summary } = this.document(row);
    const db = this.available();
    const binding = db
      .select()
      .from(skillBindings)
      .where(and(eq(skillBindings.bot, bot), eq(skillBindings.skill, summary.id)))
      .get();
    // A newly shipped default must not displace an existing Bot's twenty explicitly enabled skills.
    const defaultEnabled =
      !!summary.system &&
      db
        .select({ count: count() })
        .from(skillBindings)
        .innerJoin(skills, eq(skills.id, skillBindings.skill))
        .where(and(eq(skillBindings.bot, bot), eq(skillBindings.enabled, 1), eq(skills.deleted, 0)))
        .get()!.count < 20;
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
      items: this.visible(bot, deleted).map((row) => this.entry(bot, row)),
    };
    if (!isSkillCatalog(result)) throw new Fault('SKILLS_UNAVAILABLE', 503);
    return result;
  }
  async read(id: string, bot?: string) {
    await this.ready;
    return this.document(this.scoped(id, bot));
  }
  private importPlan(contents: (string | SkillPackage)[], bot?: string) {
    this.assertBot(bot);
    if (!Array.isArray(contents) || contents.length > 20) return invalid();
    const parsed = Array.from(contents).map((input) => {
        if (typeof input === 'string')
          return { parsed: parseSkill(input), set: undefined as SkillFileSet | undefined };
        const prepared = this.files!.prepare(input);
        return { parsed: parseSkill(prepared.content, true), set: prepared.set };
      }),
      db = this.available();
    if (new Set(parsed.map((item) => item.parsed.name)).size !== parsed.length) return invalid();
    const owners = bot ? (this.templateOwners?.(bot) ?? []) : [];
    if (owners.length) {
      const managed = db
        .select({ name: skills.name })
        .from(skills)
        .where(inArray(skills.owner, owners))
        .all();
      if (parsed.some((item) => managed.some((row) => row.name === item.parsed.name)))
        throw new Fault('SKILL_NAME_CONFLICT');
    }
    const entries = parsed.map(({ parsed: item, set }) => ({
      item,
      set,
      prior: db
        .select()
        .from(skills)
        .where(and(eq(skills.name, item.name), ownedBy(bot)))
        .get(),
    }));
    for (const entry of entries) {
      if (
        bot &&
        !entry.prior &&
        this.defaults.some((item) => {
          const row = db.select().from(skills).where(eq(skills.id, item.id)).get();
          return row && this.document(row).name === entry.item.name;
        })
      )
        throw new Fault('SKILL_SYSTEM_READ_ONLY', 409);
      if (entry.prior?.deleted === 1) throw new Fault('SKILL_ARCHIVED');
      if (
        entry.prior &&
        (entry.prior.content !== entry.item.content ||
          JSON.stringify(this.files!.manifest(entry.prior.resources)) !==
            JSON.stringify(entry.set?.manifest ?? []))
      )
        throw new Fault('SKILL_NAME_CONFLICT');
    }
    const total = db.select({ count: count() }).from(skills).get()!.count;
    if (total + entries.filter((entry) => !entry.prior).length > 100)
      throw new Fault('SKILL_LIMIT');
    this.files!.checkCapacity(
      entries.flatMap((entry) => (entry.set ? [entry.set] : [])),
      new Set(this.pins.keys()),
    );
    return entries;
  }
  async checkImport(contents: (string | SkillPackage)[], bot?: string) {
    await this.ready;
    this.importPlan(contents, bot);
  }
  async importBatch(contents: (string | SkillPackage)[], bot?: string) {
    return this.importOwned(contents, bot, false);
  }
  async prepareTemplatePackage(bundle: SkillPackage, owner: string) {
    return this.importOwned([bundle], owner, true);
  }
  private async importOwned(
    contents: (string | SkillPackage)[],
    bot: string | undefined,
    managed: boolean,
  ) {
    await this.ready;
    const plan = this.importPlan(contents, bot);
    if (plan.some((entry) => entry.prior && entry.prior.managed !== Number(managed)))
      throw new Fault('SKILL_NAME_CONFLICT');
    if (plan.every((entry) => entry.prior)) return plan.map((entry) => this.document(entry.prior!));
    return this.transaction(() =>
      plan.map((entry) => {
        if (entry.prior) return this.document(entry.prior);
        const id = randomUUID(),
          now = new Date().toISOString();
        if (entry.set) this.files!.save(entry.set);
        const db = this.available();
        db.insert(skills)
          .values({
            id,
            name: entry.item.name,
            revision: 1,
            content: entry.item.content,
            deleted: 0,
            created: now,
            updated: now,
            resources: entry.set?.key ?? null,
            owner: bot ?? null,
            managed: Number(managed),
          })
          .run();
        if (bot) {
          // A private replacement must never fall back to a previously enabled shared version after uninstall.
          db.update(skillBindings)
            .set({ enabled: 0, revision: sql`${skillBindings.revision} + 1` })
            .where(
              and(
                eq(skillBindings.bot, bot),
                eq(skillBindings.enabled, 1),
                inArray(
                  skillBindings.skill,
                  db
                    .select({ id: skills.id })
                    .from(skills)
                    .where(and(isNull(skills.owner), eq(skills.name, entry.item.name))),
                ),
              ),
            )
            .run();
        }
        return this.document(this.row(id));
      }),
    );
  }
  async import(content: string, bot?: string) {
    return (await this.importBatch([content], bot))[0];
  }
  async importPackage(bundle: SkillPackage, bot?: string) {
    return (await this.importBatch([bundle], bot))[0];
  }
  async copy(bot: string, id: string, revision: number, targetBot: string) {
    await this.ready;
    if (!validAgentId(bot) || !validAgentId(targetBot)) throw new Fault('INVALID_SKILL', 400);
    const row = this.scoped(id, bot);
    if (bot === targetBot && this.owner(row)) throw new Fault('INVALID_SKILL', 400);
    this.check(row, revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const document = this.document(row);
    if (document.system) {
      const current = this.entry(targetBot, row);
      await this.bind(targetBot, {
        id,
        revision,
        bindingRevision: current.bindingRevision,
        enabled: true,
      });
      return document;
    }
    if (
      this.activeRows(targetBot).filter((item) => this.document(item).name !== document.name)
        .length >= 20
    )
      throw new Fault('SKILL_ACTIVE_LIMIT');
    const copied = document.package
      ? await this.importPackage(await this.exportPackage(id, revision, bot), targetBot)
      : await this.import(document.content, targetBot);
    const entry = this.entry(targetBot, this.row(copied.id));
    await this.bind(targetBot, {
      id: copied.id,
      revision: copied.revision,
      bindingRevision: entry.bindingRevision,
      enabled: true,
    });
    return copied;
  }
  private check(row: Row, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Fault('INVALID_SKILL', 400);
    if (row.revision !== revision) throw new Fault('SKILL_CONFLICT');
    if (revision >= Number.MAX_SAFE_INTEGER - 1) throw new Fault('SKILL_LIMIT');
  }
  private named(name: string, owner: string | undefined, id: string) {
    return this.available()
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.name, name),
          or(
            ownedBy(owner),
            owner && this.templateOwners?.(owner).length
              ? inArray(skills.owner, this.templateOwners(owner))
              : undefined,
          ),
          ne(skills.id, id),
        ),
      )
      .get();
  }
  private mutable(id: string, bot?: string) {
    if (this.row(id).managed) {
      this.scoped(id, bot);
      throw new Fault('INSTALLATION_UPDATE_REQUIRED');
    }
    if (bot && this.templateOwners?.(bot).includes(this.owner(this.row(id)) ?? ''))
      throw new Fault('INSTALLATION_UPDATE_REQUIRED');
    if (this.defaults.some((skill) => skill.id === id))
      throw new Fault('SKILL_SYSTEM_READ_ONLY', 409);
    if (bot !== undefined && this.owner(this.row(id)) === undefined)
      throw new Fault('SKILL_SHARED_READ_ONLY', 409);
  }
  private activeRows(bot: string, owners?: string[]) {
    return this.visible(bot, false, owners).filter((row) => this.entry(bot, row).enabled);
  }
  async update(id: string, revision: number, content: string, bot?: string) {
    await this.ready;
    const row = this.scoped(id, bot);
    this.mutable(id, bot);
    this.check(row, revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const parsed = parseSkill(content, typeof row.resources === 'string'),
      db = this.available();
    this.files!.info(content, row.resources);
    if (this.named(parsed.name, this.owner(row), id)) throw new Fault('SKILL_NAME_CONFLICT');
    if (row.content !== content)
      this.transaction(() =>
        db
          .update(skills)
          .set({
            name: parsed.name,
            content,
            revision: sql`${skills.revision} + 1`,
            updated: new Date().toISOString(),
          })
          .where(eq(skills.id, id))
          .run(),
      );
    return this.document(this.row(id));
  }
  async updatePackage(id: string, revision: number, bundle: SkillPackage, bot?: string) {
    await this.ready;
    const row = this.scoped(id, bot);
    this.mutable(id, bot);
    this.check(row, revision);
    if (row.deleted === 1) throw new Fault('SKILL_ARCHIVED');
    const prepared = this.files!.prepare(bundle),
      parsed = parseSkill(prepared.content, true);
    if (this.named(parsed.name, this.owner(row), id)) throw new Fault('SKILL_NAME_CONFLICT');
    if (
      row.content !== prepared.content ||
      JSON.stringify(this.files!.manifest(row.resources)) !== JSON.stringify(prepared.set.manifest)
    )
      this.transaction(() => {
        this.files!.save(prepared.set);
        this.available()
          .update(skills)
          .set({
            name: parsed.name,
            content: prepared.content,
            resources: prepared.set.key,
            revision: sql`${skills.revision} + 1`,
            updated: new Date().toISOString(),
          })
          .where(eq(skills.id, id))
          .run();
      });
    return this.document(this.row(id));
  }
  async readResource(
    id: string,
    revision: number,
    name: string,
    bot?: string,
  ): Promise<SkillResourceData> {
    await this.ready;
    const row = this.scoped(id, bot);
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
  async exportPackage(id: string, revision: number, bot?: string) {
    await this.ready;
    const row = this.scoped(id, bot);
    this.check(row, revision);
    return this.files!.bundle(
      String(row.content),
      typeof row.resources === 'string' ? row.resources : null,
    );
  }
  capturedKey(snapshot: SkillSnapshot, name: string) {
    const source = this.captured(snapshot, name);
    return JSON.stringify([source.id, source.revision]);
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
    this.snapshotBots.delete(snapshot);
  }
  private async setDeleted(id: string, revision: number, deleted: boolean, bot?: string) {
    await this.ready;
    this.mutable(id, bot);
    const row = this.scoped(id, bot);
    this.check(row, revision);
    if ((row.deleted === 1) !== deleted)
      this.transaction(() => {
        const db = this.available();
        db.update(skills)
          .set({
            deleted: Number(deleted),
            revision: sql`${skills.revision} + 1`,
            updated: new Date().toISOString(),
          })
          .where(eq(skills.id, id))
          .run();
        // Restoring a document must never restore another Bot's old enablement consent.
        if (deleted)
          db.update(skillBindings)
            .set({ enabled: 0, revision: sql`${skillBindings.revision} + 1` })
            .where(eq(skillBindings.skill, id))
            .run();
      });
    return this.document(this.row(id));
  }
  recycle(id: string, revision: number, bot?: string) {
    return this.setDeleted(id, revision, true, bot);
  }
  restore(id: string, revision: number, bot?: string) {
    return this.setDeleted(id, revision, false, bot);
  }
  async bind(bot: string, input: SkillBinding) {
    await this.ready;
    if (!validAgentId(bot) || !isSkillBinding(input)) throw new Fault('INVALID_SKILL', 400);
    const row = this.scoped(input.id, bot);
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
          .insert(skillBindings)
          .values({
            bot,
            skill: input.id,
            revision: current.bindingRevision + 1,
            enabled: Number(input.enabled),
          })
          .onConflictDoUpdate({
            target: [skillBindings.bot, skillBindings.skill],
            set: { revision: sql`excluded.revision`, enabled: sql`excluded.enabled` },
          })
          .run(),
      );
    }
    return this.entry(bot, row);
  }
  private pin(bot: string, snapshot: SkillSnapshot, sources: Map<string, SkillSource>) {
    this.snapshots.set(snapshot, sources);
    this.snapshotBots.set(snapshot, bot);
    for (const source of sources.values())
      if (source.resources)
        this.pins.set(source.resources, (this.pins.get(source.resources) ?? 0) + 1);
    return snapshot;
  }
  async extend(bot: string, previous: SkillSnapshot | undefined, id: string, revision: number) {
    await this.ready;
    const row = this.scoped(id, bot);
    this.check(row, revision);
    if (row.deleted === 1 || !this.entry(bot, row).enabled)
      throw new Fault('SKILL_NOT_AVAILABLE', 404);
    if (previous && (!previous.available || this.snapshotBots.get(previous) !== bot))
      throw new Fault('SKILL_SNAPSHOT_EXPIRED', 410);
    const document = this.document(row),
      sources = new Map(previous ? this.snapshots.get(previous) : []),
      prior = sources.get(document.name);
    if (previous && prior?.id === id && prior.revision === revision) return previous;
    const parsed = parseSkill(document.content, !!document.package);
    sources.set(document.name, {
      id,
      revision,
      content: document.content,
      resources: typeof row.resources === 'string' ? row.resources : null,
    });
    const recipes = [
      ...(previous?.skills ?? []).filter((item) => item.name !== document.name),
      {
        name: document.name,
        description: document.description,
        content: parsed.body || parsed.description,
        invocation: { ...document.invocation },
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        ...(document.package ? { package: document.package, files: document.files } : {}),
      },
    ];
    if (recipes.length > 20) throw new Fault('SKILL_ACTIVE_LIMIT');
    // Extend only the confirmed installation. Capturing all current bindings would pull unrelated grants into a live task.
    return this.pin(
      bot,
      {
        available: true,
        key: createHash('sha256')
          .update(JSON.stringify([...sources.values()].map((item) => [item.id, item.revision])))
          .digest('hex'),
        skills: recipes,
      },
      sources,
    );
  }
  async capture(bot: string, owners?: string[]): Promise<SkillSnapshot> {
    await this.ready;
    if (!validAgentId(bot)) throw new Fault('INVALID_SKILL', 400);
    try {
      const rows = this.activeRows(bot, owners);
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
          this.document(row).name,
          {
            id: String(row.id),
            revision: Number(row.revision),
            content: String(row.content),
            resources: typeof row.resources === 'string' ? row.resources : null,
          },
        ]),
      );
      return this.pin(bot, snapshot, sources);
    } catch {
      return { available: false, key: 'unavailable', skills: [] };
    }
  }
  async close() {
    this.closed = true;
    await this.ready;
    this.db?.$client.close();
    this.db = undefined;
  }
}
