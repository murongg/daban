import { randomUUID } from 'node:crypto';
import {
  type BotDefinition,
  type GallerySource,
  galleryOrigin,
  isBotDefinition,
  mergeRelease,
  type ReleaseChoices,
  releaseDigest,
  releaseUuid,
  validAgentId,
} from '@daban/protocol';
import { and, eq } from 'drizzle-orm';
import { Fault } from './control.js';
import { type ReleaseStore, releaseHash } from './releases.js';
import {
  releaseHistory,
  releaseInstallations,
  releaseOperations,
  releasePlans,
  releaseReservations,
  releaseSnapshots,
} from './releases-schema.js';

export interface Installation {
  botId: string;
  templateId: string;
  releaseVersion: string;
  baseDigest: string;
  snapshotDigest: string;
  revision: number;
  source: GallerySource | null;
}
interface Plan {
  id: string;
  bot: string;
  revision: number;
  targetDigest: string;
  version: string;
  base: BotDefinition;
  local: BotDefinition;
  target: BotDefinition;
  rollback: boolean;
}
export class Installations {
  constructor(readonly store: ReleaseStore) {}
  read(bot: string): Installation | undefined {
    const row = this.store.db
      .select()
      .from(releaseInstallations)
      .where(eq(releaseInstallations.bot, bot))
      .get();
    return row
      ? {
          botId: bot,
          templateId: row.template,
          releaseVersion: row.version,
          baseDigest: row.base,
          snapshotDigest: row.snapshot,
          revision: row.revision,
          source: row.source ? JSON.parse(row.source) : null,
        }
      : undefined;
  }
  list() {
    return this.store.db
      .select()
      .from(releaseInstallations)
      .all()
      .map((row) => this.read(row.bot)!);
  }
  capture(bot: string) {
    const installation = this.read(bot);
    if (!installation) return undefined;
    const row = this.store.db
      .select()
      .from(releaseSnapshots)
      .where(eq(releaseSnapshots.digest, installation.snapshotDigest))
      .get();
    if (!row || releaseHash(row.content) !== installation.snapshotDigest)
      throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
    const definition: unknown = JSON.parse(row.content);
    if (!isBotDefinition(definition)) throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
    return { installation, definition };
  }
  history(bot: string) {
    return this.store.db.select().from(releaseHistory).where(eq(releaseHistory.bot, bot)).all();
  }
  receipt(id: string) {
    const row = this.store.db
      .select()
      .from(releaseOperations)
      .where(eq(releaseOperations.id, id))
      .get();
    return row ? (JSON.parse(row.result) as Installation) : undefined;
  }
  private apply(id: string, fingerprint: string, operation: () => Installation) {
    if (!validAgentId(id)) throw new Fault('INVALID_REQUEST', 400);
    return this.store.db.transaction(
      () => {
        const prior = this.store.db
          .select()
          .from(releaseOperations)
          .where(eq(releaseOperations.id, id))
          .get();
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Fault('REQUEST_ID_REUSED');
          return JSON.parse(prior.result) as Installation;
        }
        const result = operation();
        this.store.db
          .insert(releaseOperations)
          .values({ id, fingerprint, result: JSON.stringify(result) })
          .run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  private snapshot(definition: BotDefinition) {
    if (!isBotDefinition(definition)) throw new Fault('INVALID_PACKAGE', 400);
    const content = JSON.stringify(definition);
    const digest = releaseHash(content);
    this.store.db.insert(releaseSnapshots).values({ digest, content }).onConflictDoNothing().run();
    return digest;
  }
  reserve(
    id: string,
    digest: string,
    source: GallerySource | null,
    candidate: string = randomUUID(),
  ) {
    if (
      !validAgentId(id) ||
      !releaseDigest(digest) ||
      !validAgentId(candidate) ||
      (source && (!galleryOrigin(source.sourceOrigin, true) || !releaseUuid(source.sourceId)))
    )
      throw new Fault('INVALID_REQUEST', 400);
    const fingerprint = releaseHash(
      JSON.stringify([digest, source ? [source.sourceOrigin, source.sourceId] : null]),
    );
    return this.store.db.transaction(
      (tx) => {
        const previous = tx
          .select()
          .from(releaseReservations)
          .where(eq(releaseReservations.id, id))
          .get();
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Fault('REQUEST_ID_REUSED');
          return previous.bot;
        }
        tx.insert(releaseReservations).values({ id, fingerprint, bot: candidate }).run();
        return candidate;
      },
      { behavior: 'immediate' },
    );
  }
  async install(
    id: string,
    digest: string,
    source: GallerySource | null = null,
    candidate: string = randomUUID(),
  ) {
    const release = await this.store.read(digest);
    const reserved = this.reserve(id, digest, source, candidate);
    return this.apply(id, releaseHash(JSON.stringify(['install', digest, source])), () => {
      const bot = reserved;
      const snapshot = this.snapshot(release.definition);
      const row = {
        bot,
        template: release.manifest.templateId,
        version: release.manifest.releaseVersion,
        base: digest,
        snapshot,
        source: source ? JSON.stringify(source) : null,
        revision: 1,
      };
      this.store.db.insert(releaseInstallations).values(row).run();
      this.store.db
        .insert(releaseHistory)
        .values({
          bot,
          revision: 1,
          snapshot,
          base: digest,
          version: row.version,
          at: new Date().toISOString(),
        })
        .run();
      return this.read(bot)!;
    });
  }
  edit(bot: string, revision: number, definition: BotDefinition, id: string) {
    return this.apply(id, releaseHash(JSON.stringify(['edit', bot, revision, definition])), () => {
      const current = this.read(bot);
      if (!current || current.revision !== revision) throw new Fault('INSTALLATION_CONFLICT');
      const snapshot = this.snapshot(definition);
      return this.switch(current, current.baseDigest, current.releaseVersion, snapshot);
    });
  }
  private switch(current: Installation, base: string, version: string, snapshot: string) {
    const revision = current.revision + 1;
    this.store.db
      .update(releaseInstallations)
      .set({ base, version, snapshot, revision })
      .where(
        and(
          eq(releaseInstallations.bot, current.botId),
          eq(releaseInstallations.revision, current.revision),
        ),
      )
      .run();
    this.store.db
      .insert(releaseHistory)
      .values({
        bot: current.botId,
        revision,
        snapshot,
        base,
        version,
        at: new Date().toISOString(),
      })
      .run();
    return this.read(current.botId)!;
  }
  async prepare(bot: string, targetDigest: string) {
    const captured = this.capture(bot);
    if (!captured) throw new Fault('INSTALLATION_NOT_FOUND', 404);
    const [base, target] = await Promise.all([
      this.store.read(captured.installation.baseDigest),
      this.store.read(targetDigest),
    ]);
    if (base.manifest.templateId !== target.manifest.templateId)
      throw new Fault('INSTALLATION_SOURCE_CONFLICT');
    if (
      base.manifest.releaseVersion === target.manifest.releaseVersion &&
      captured.installation.baseDigest !== targetDigest
    )
      throw new Fault('VERSION_CONTENT_CONFLICT');
    return this.plan({
      id: randomUUID(),
      bot,
      revision: captured.installation.revision,
      targetDigest,
      version: target.manifest.releaseVersion,
      base: base.definition,
      local: captured.definition,
      target: target.definition,
      rollback: false,
    });
  }
  async prepareRollback(bot: string, revision: number) {
    const current = this.capture(bot);
    const history = this.history(bot).find((entry) => entry.revision === revision);
    if (!current || !history) throw new Fault('INSTALLATION_NOT_FOUND', 404);
    const row = this.store.db
      .select()
      .from(releaseSnapshots)
      .where(eq(releaseSnapshots.digest, history.snapshot))
      .get()!;
    const definition: BotDefinition = JSON.parse(row.content);
    return this.plan({
      id: randomUUID(),
      bot,
      revision: current.installation.revision,
      targetDigest: history.base,
      version: history.version,
      base: current.definition,
      local: current.definition,
      target: definition,
      rollback: true,
    });
  }
  private plan(plan: Plan) {
    const content = JSON.stringify(plan);
    this.store.db
      .insert(releasePlans)
      .values({ id: plan.id, bot: plan.bot, revision: plan.revision, content })
      .run();
    const result = mergeRelease(plan.base, plan.local, plan.target);
    return {
      id: plan.id,
      digest: releaseHash(content),
      revision: plan.revision,
      conflicts: result.conflicts,
      before: plan.local,
      after: result.definition,
      target: plan.target,
      targetDigest: plan.targetDigest,
      version: plan.version,
    };
  }
  commit(planId: string, choices: ReleaseChoices, id: string) {
    const row = this.store.db.select().from(releasePlans).where(eq(releasePlans.id, planId)).get();
    if (!row) throw new Fault('INSTALLATION_NOT_FOUND', 404);
    if (row.cancelled) throw new Fault('INSTALLATION_CANCELLED');
    const plan: Plan = JSON.parse(row.content);
    return this.apply(id, releaseHash(JSON.stringify(['commit', planId, choices])), () => {
      const current = this.read(plan.bot);
      if (!current || current.revision !== plan.revision) throw new Fault('INSTALLATION_CONFLICT');
      const merged = mergeRelease(plan.base, plan.local, plan.target, choices);
      if (merged.conflicts.length) throw new Fault('INSTALLATION_CONFLICT');
      const result = this.switch(
        current,
        plan.targetDigest,
        plan.version,
        this.snapshot(merged.definition),
      );
      this.store.db
        .update(releasePlans)
        .set({ committed: id })
        .where(eq(releasePlans.id, planId))
        .run();
      return result;
    });
  }
  planResult(id: string, choices: ReleaseChoices) {
    const row = this.store.db.select().from(releasePlans).where(eq(releasePlans.id, id)).get();
    if (!row) throw new Fault('INSTALLATION_NOT_FOUND', 404);
    if (row.cancelled) throw new Fault('INSTALLATION_CANCELLED');
    const plan: Plan = JSON.parse(row.content);
    const result = mergeRelease(plan.base, plan.local, plan.target, choices);
    if (result.conflicts.length) throw new Fault('INSTALLATION_CONFLICT');
    return {
      bot: plan.bot,
      revision: plan.revision,
      definition: result.definition,
      digest: releaseHash(row.content),
      targetDigest: plan.targetDigest,
      version: plan.version,
    };
  }
  cancel(id: string) {
    const row = this.store.db.select().from(releasePlans).where(eq(releasePlans.id, id)).get();
    if (!row) throw new Fault('INSTALLATION_NOT_FOUND', 404);
    if (row.committed) throw new Fault('INSTALLATION_COMMITTING');
    this.store.db.update(releasePlans).set({ cancelled: 1 }).where(eq(releasePlans.id, id)).run();
    return { id, state: 'cancelled' as const };
  }
  bind(bot: string, revision: number, source: GallerySource, id: string) {
    if (!galleryOrigin(source.sourceOrigin, true) || !releaseUuid(source.sourceId))
      throw new Fault('INVALID_REQUEST', 400);
    return this.apply(id, releaseHash(JSON.stringify(['bind', bot, revision, source])), () => {
      const current = this.read(bot);
      if (!current || current.revision !== revision) throw new Fault('INSTALLATION_CONFLICT');
      this.switch(current, current.baseDigest, current.releaseVersion, current.snapshotDigest);
      this.store.db
        .update(releaseInstallations)
        .set({ source: JSON.stringify(source) })
        .where(eq(releaseInstallations.bot, bot))
        .run();
      return this.read(bot)!;
    });
  }
}
