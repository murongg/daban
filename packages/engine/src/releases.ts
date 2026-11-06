import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type BotRelease,
  botReleaseText,
  isBotRelease,
  parseBotRelease,
  releaseDigest,
} from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import { Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { syncDirectory } from './durability.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { migrations } from './releases-migrations.js';
import { authoredReleases, releaseDrafts, releasePackages } from './releases-schema.js';
import { parseSkill } from './skill-content.js';

export const releaseHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

export class ReleaseStore {
  readonly ready: Promise<unknown>;
  private connection?: Database;
  constructor(readonly directory: string) {
    this.ready = this.load();
  }
  get db() {
    if (!this.connection) throw new Fault('RELEASE_STORE_UNAVAILABLE', 503);
    return this.connection;
  }
  private async load() {
    await secureDirectory(this.directory);
    await secureDirectory(path.join(this.directory, 'packages'));
    const file = path.join(this.directory, 'releases.sqlite');
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !(await privateMetadata(file, info, 0o600)))
        throw new Fault('RELEASE_STORE_UNSAFE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.connection = migrate(client, migrations);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  async save(input: BotRelease) {
    await this.ready;
    if (!isBotRelease(input)) throw new Fault('INVALID_PACKAGE', 400);
    const text = botReleaseText(input);
    const value = parseBotRelease(text, true);
    for (const skill of value.definition.skills) {
      const main = skill.package.files.find((file) => file.path === 'SKILL.md')!;
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(main.data, 'base64'),
      );
      if (parseSkill(content, true).name !== skill.package.root)
        throw new Fault('INVALID_SKILL', 400);
    }
    const digest = releaseHash(text);
    const bytes = Buffer.byteLength(text);
    const directory = path.join(this.directory, 'packages');
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    const file = path.join(directory, `${digest}.json`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      try {
        await link(temporary, file);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    } finally {
      await unlink(temporary);
    }
    const parent = await open(directory, constants.O_RDONLY);
    try {
      await syncDirectory(parent);
    } finally {
      await parent.close();
    }
    await this.readFile(digest);
    // Durable bytes must precede every visible database reference, including retry receipts.
    this.db.insert(releasePackages).values({ digest, bytes }).onConflictDoNothing().run();
    return { digest, bytes, release: value };
  }
  private async readFile(digest: string) {
    if (!releaseDigest(digest)) throw new Fault('INVALID_PACKAGE', 400);
    const file = path.join(this.directory, 'packages', `${digest}.json`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 100 * 1024 * 1024 ||
        !(await privateMetadata(file, info, 0o600))
      )
        throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
      const bytes = await handle.readFile();
      if (releaseHash(bytes) !== digest) throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
  }
  async read(digest: string) {
    await this.ready;
    if (!this.db.select().from(releasePackages).where(eq(releasePackages.digest, digest)).get())
      throw new Fault('RELEASE_NOT_FOUND', 404);
    return parseBotRelease(await this.readFile(digest), true);
  }
  async text(digest: string) {
    return botReleaseText(await this.read(digest));
  }
  draftForBot(bot: string) {
    return this.db.select().from(releaseDrafts).where(eq(releaseDrafts.bot, bot)).get();
  }
  async draft(input: BotRelease, revision: number, bot?: string) {
    await this.ready;
    if (!isBotRelease(input)) throw new Fault('INVALID_PACKAGE', 400);
    return this.db.transaction((tx) => {
      const previous = tx
        .select()
        .from(releaseDrafts)
        .where(eq(releaseDrafts.template, input.manifest.templateId))
        .get();
      if ((previous?.revision ?? 0) !== revision) throw new Fault('DRAFT_CONFLICT');
      const value = {
        template: input.manifest.templateId,
        revision: revision + 1,
        content: botReleaseText(input),
        ...(bot ? { bot } : {}),
      };
      tx.insert(releaseDrafts)
        .values(value)
        .onConflictDoUpdate({ target: releaseDrafts.template, set: value })
        .run();
      return value.revision;
    });
  }
  close() {
    this.connection?.$client.close();
    this.connection = undefined;
  }
  publishDraft(bot: string, revision: number, digest: string) {
    return this.db.transaction(
      (tx) => {
        const draft = tx.select().from(releaseDrafts).where(eq(releaseDrafts.bot, bot)).get();
        if (!draft || draft.revision !== revision || releaseHash(draft.content) !== digest)
          throw new Fault('DRAFT_CONFLICT');
        const release = parseBotRelease(draft.content, true);
        const template = release.manifest.templateId;
        const version = release.manifest.releaseVersion;
        const prior = tx
          .select()
          .from(authoredReleases)
          .where(
            and(eq(authoredReleases.template, template), eq(authoredReleases.version, version)),
          )
          .get();
        if (prior && prior.digest !== digest) throw new Fault('VERSION_CONTENT_CONFLICT');
        tx.insert(authoredReleases)
          .values({ template, version, digest })
          .onConflictDoNothing()
          .run();
        return { release, digest, revision };
      },
      { behavior: 'immediate' },
    );
  }
}
