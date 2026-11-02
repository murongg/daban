import type { DatabaseSync } from 'node:sqlite';
import {
  isSkillResource,
  type SkillPackage,
  type SkillPackageFile,
  type SkillResource,
  skillPackageLimit,
} from '@daban/protocol';
import { Fault } from './control.js';
import { normalizeSkillPackage, packageResources, skillHash } from './skill-package.js';

export interface SkillFileSet {
  key: string;
  manifest: SkillResource[];
  files: SkillPackageFile[];
}
const unavailable = (): never => {
  throw new Fault('SKILLS_UNAVAILABLE', 503);
};
export class SkillFiles {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`ALTER TABLE skills ADD COLUMN resources TEXT;
        CREATE TABLE skill_packages(digest TEXT PRIMARY KEY,manifest TEXT NOT NULL,bytes INTEGER NOT NULL);
        CREATE TABLE skill_files(package TEXT NOT NULL,path TEXT NOT NULL,data BLOB NOT NULL,sha TEXT NOT NULL,executable INTEGER NOT NULL,PRIMARY KEY(package,path));
        PRAGMA user_version=2; COMMIT;`);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
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
    const row = this.db.prepare('SELECT * FROM skill_packages WHERE digest=?').get(key);
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
      .prepare(
        'SELECT path,length(data) AS size,sha AS sha256,executable FROM skill_files WHERE package=? ORDER BY path',
      )
      .all(key)
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
      .prepare('SELECT digest FROM skill_packages WHERE digest=?')
      .get(set.key);
    if (existing) {
      this.manifest(set.key);
      return;
    }
    this.db.prepare('INSERT INTO skill_packages VALUES(?,?,?)').run(
      set.key,
      JSON.stringify(set.manifest),
      set.manifest.reduce((sum, file) => sum + file.size, 0),
    );
    for (const file of set.files) {
      const bytes = Buffer.from(file.data, 'base64');
      this.db
        .prepare('INSERT INTO skill_files VALUES(?,?,?,?,?)')
        .run(set.key, file.path, bytes, skillHash(bytes), Number(file.executable ?? false));
    }
  }
  read(key: string, name: string) {
    const file = this.manifest(key).find((file) => file.path === name);
    if (!file) throw new Fault('SKILL_FILE_NOT_FOUND', 404);
    const row = this.db
      .prepare('SELECT data FROM skill_files WHERE package=? AND path=?')
      .get(key, name);
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
  collect(pins: Set<string>) {
    const references = new Set(
      this.db
        .prepare('SELECT resources FROM skills WHERE resources IS NOT NULL')
        .all()
        .map((row) => String(row.resources)),
    );
    for (const row of this.db.prepare('SELECT digest FROM skill_packages').all()) {
      const key = String(row.digest);
      if (references.has(key) || pins.has(key)) continue;
      this.db.prepare('DELETE FROM skill_files WHERE package=?').run(key);
      this.db.prepare('DELETE FROM skill_packages WHERE digest=?').run(key);
    }
    if (
      Number(
        this.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS bytes FROM skill_files').get()!
          .bytes,
      ) >
      200 * 1024 * 1024
    )
      throw new Fault('SKILL_STORAGE_LIMIT', 413);
  }
  checkCapacity(sets: SkillFileSet[], pins: Set<string>) {
    const required = new Set([
      ...pins,
      ...this.db
        .prepare('SELECT resources FROM skills WHERE resources IS NOT NULL')
        .all()
        .map((row) => String(row.resources)),
    ]);
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
