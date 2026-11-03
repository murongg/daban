import type { DatabaseSync } from 'node:sqlite';
import {
  isSkillResource,
  type SkillPackage,
  type SkillPackageFile,
  type SkillResource,
  skillPackageLimit,
} from '@daban/protocol';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { Fault } from './control.js';
import type { Database } from './database.js';
import { normalizeSkillPackage, packageResources, skillHash } from './skill-package.js';
import { skillFiles, skillPackages, skills } from './skills-schema.js';

export interface SkillFileSet {
  key: string;
  manifest: SkillResource[];
  files: SkillPackageFile[];
}
const unavailable = (): never => {
  throw new Fault('SKILLS_UNAVAILABLE', 503);
};

// Pre-ORM catalog version 1 to 2; runs inside the caller's migration transaction.
export function upgradeSkillFiles(client: DatabaseSync) {
  client.exec(`ALTER TABLE skills ADD COLUMN resources TEXT;
    CREATE TABLE skill_packages(digest TEXT PRIMARY KEY,manifest TEXT NOT NULL,bytes INTEGER NOT NULL);
    CREATE TABLE skill_files(package TEXT NOT NULL,path TEXT NOT NULL,data BLOB NOT NULL,sha TEXT NOT NULL,executable INTEGER NOT NULL,PRIMARY KEY(package,path));`);
}

export class SkillFiles {
  constructor(private readonly db: Database) {}
  prepare(value: SkillPackage) {
    const bundle = normalizeSkillPackage(value),
      main = bundle.files.find((file) => file.path === 'SKILL.md')!;
    const files = bundle.files.filter((file) => file.path !== 'SKILL.md'),
      manifest = packageResources({ ...bundle, files });
    return {
      content: Buffer.from(main.data, 'base64').toString('utf8'),
      set: { key: skillHash(JSON.stringify(manifest)), manifest, files },
    };
  }
  manifest(key: unknown): SkillResource[] {
    if (key === undefined || key === null) return [];
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return unavailable();
    const row = this.db.select().from(skillPackages).where(eq(skillPackages.digest, key)).get();
    if (!row || typeof row.manifest !== 'string' || row.manifest.length > 100000)
      return unavailable();
    let files: unknown;
    try {
      files = JSON.parse(row.manifest);
    } catch {
      return unavailable();
    }
    if (
      !Array.isArray(files) ||
      files.length > 199 ||
      !Array.from(files).every(isSkillResource) ||
      files.some((file) => file.path === 'SKILL.md') ||
      skillHash(JSON.stringify(files)) !== key ||
      files.reduce((sum, file) => sum + file.size, 0) !== row.bytes
    )
      return unavailable();
    const stored = this.db
      .select({
        path: skillFiles.path,
        // SQLite length() reports stored BLOB bytes without loading every resource into memory.
        size: sql<number>`length(${skillFiles.data})`,
        sha256: skillFiles.sha,
        executable: skillFiles.executable,
      })
      .from(skillFiles)
      .where(eq(skillFiles.package, key))
      .orderBy(asc(skillFiles.path))
      .all()
      .map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        executable: file.executable === 1,
      }))
      .sort((a, b) =>
        String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0,
      );
    const expected = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (JSON.stringify(stored) !== JSON.stringify(expected)) return unavailable();
    return files;
  }
  info(content: string, key: unknown) {
    if (key === undefined || key === null) return {};
    const files = this.manifest(key),
      size = Buffer.byteLength(content),
      bytes = size + files.reduce((sum, file) => sum + file.size, 0);
    if (bytes > skillPackageLimit) throw new Fault('SKILL_PACKAGE_TOO_LARGE', 413);
    const main: SkillResource = {
      path: 'SKILL.md',
      size,
      sha256: skillHash(content),
      executable: false,
    };
    return {
      package: {
        digest: skillHash(
          JSON.stringify(
            [main, ...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          ),
        ),
        fileCount: files.length + 1,
        bytes,
      },
      files,
    };
  }
  save(set: SkillFileSet) {
    const existing = this.db
      .select({ digest: skillPackages.digest })
      .from(skillPackages)
      .where(eq(skillPackages.digest, set.key))
      .get();
    if (existing) {
      this.manifest(set.key);
      return;
    }
    this.db
      .insert(skillPackages)
      .values({
        digest: set.key,
        manifest: JSON.stringify(set.manifest),
        bytes: set.manifest.reduce((sum, file) => sum + file.size, 0),
      })
      .run();
    for (const file of set.files) {
      const bytes = Buffer.from(file.data, 'base64');
      this.db
        .insert(skillFiles)
        .values({
          package: set.key,
          path: file.path,
          data: bytes,
          sha: skillHash(bytes),
          executable: Number(file.executable ?? false),
        })
        .run();
    }
  }
  read(key: string, name: string) {
    const file = this.manifest(key).find((file) => file.path === name);
    if (!file) throw new Fault('SKILL_FILE_NOT_FOUND', 404);
    const row = this.db
      .select({ data: skillFiles.data })
      .from(skillFiles)
      .where(and(eq(skillFiles.package, key), eq(skillFiles.path, name)))
      .get();
    if (!(row?.data instanceof Uint8Array)) return unavailable();
    const bytes = Buffer.from(row.data);
    if (bytes.length !== file.size || skillHash(bytes) !== file.sha256) return unavailable();
    return { file, data: bytes.toString('base64') };
  }
  bundle(content: string, key: string | null): SkillPackage {
    const files: SkillPackageFile[] = [
      { path: 'SKILL.md', data: Buffer.from(content).toString('base64'), executable: false },
    ];
    if (key)
      for (const file of this.manifest(key))
        files.push({
          path: file.path,
          data: this.read(key, file.path).data,
          executable: file.executable,
        });
    return normalizeSkillPackage({ files });
  }
  private references() {
    return this.db
      .select({ resources: skills.resources })
      .from(skills)
      .where(isNotNull(skills.resources))
      .all()
      .map((row) => String(row.resources));
  }
  collect(pins: Set<string>) {
    const references = new Set(this.references());
    for (const row of this.db.select({ digest: skillPackages.digest }).from(skillPackages).all()) {
      const key = String(row.digest);
      if (references.has(key) || pins.has(key)) continue;
      this.db.delete(skillFiles).where(eq(skillFiles.package, key)).run();
      this.db.delete(skillPackages).where(eq(skillPackages.digest, key)).run();
    }
    const total = this.db
      // SQLite length() sums stored BLOB bytes without reading them into memory.
      .select({ bytes: sql<number>`COALESCE(SUM(length(${skillFiles.data})), 0)` })
      .from(skillFiles)
      .get();
    if (Number(total!.bytes) > 200 * 1024 * 1024) throw new Fault('SKILL_STORAGE_LIMIT', 413);
  }
  checkCapacity(sets: SkillFileSet[], pins: Set<string>) {
    const required = new Set([...pins, ...this.references()]);
    const additions = new Map(sets.map((set) => [set.key, set]));
    let bytes = 0;
    for (const key of new Set([...required, ...additions.keys()])) {
      const next = additions.get(key);
      bytes += next
        ? next.manifest.reduce((sum, file) => sum + file.size, 0)
        : this.manifest(key).reduce((sum, file) => sum + file.size, 0);
      if (bytes > 200 * 1024 * 1024) throw new Fault('SKILL_STORAGE_LIMIT', 413);
    }
  }
}
