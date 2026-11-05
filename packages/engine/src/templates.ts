import { randomUUID } from 'node:crypto';
import {
  type BotDefinition,
  type BotRelease,
  type GallerySource,
  isBotDefinition,
  isBotRelease,
  isKnowledgeContent,
  type KnowledgeDocument,
  type ReleaseChoices,
  type ReleaseKnowledge,
} from '@daban/protocol';
import { eq } from 'drizzle-orm';
import type { BundleDocuments } from './bundles.js';
import { Fault } from './control.js';
import { Installations } from './installations.js';
import type { Knowledge } from './knowledge.js';
import type { BotProfiles } from './profiles.js';
import { ReleaseStore, releaseHash } from './releases.js';
import { releaseSnapshots } from './releases-schema.js';
import type { Skills } from './skills.js';

type Captured = NonNullable<ReturnType<Installations['capture']>>;
export class BotTemplates {
  readonly store: ReleaseStore;
  readonly installations: Installations;
  readonly ready: Promise<unknown>;
  pinned?: (bot: string, runId: string) => Captured | undefined;
  private readonly owners = new Map<string, string[]>();
  private readonly dates = new Map<string, string>();
  private readonly staging = new Map<string, number>();
  constructor(
    readonly options: {
      directory: string;
      profiles: BotProfiles;
      knowledge: Knowledge;
      skills: Skills;
      documents?: BundleDocuments;
    },
  ) {
    this.store = new ReleaseStore(options.directory);
    this.installations = new Installations(this.store);
    this.ready = this.load();
    this.ready.catch(() => {});
    options.profiles.templateInstructions = (bot) => {
      const captured = this.safeCapture(bot);
      return captured?.definition.profile.instructions;
    };
    options.skills.templateOwners = (bot) => this.skillOwners(this.safeCapture(bot));
    options.knowledge.template = {
      list: (bot, includeDeleted, runId) => this.documents(bot, includeDeleted, runId),
      read: (bot, id, revision, runId) => this.document(bot, id, revision, runId),
      write: (bot, input, cause) => {
        cause?.signal?.throwIfAborted();
        const current = this.document(bot, input.id!, undefined, cause?.runId);
        return this.changeDocument(
          bot,
          current.id,
          input.revision,
          { path: input.path, content: input.content },
          cause?.runId,
        );
      },
      change: (bot, id, revision, patch, cause) => {
        cause?.signal?.throwIfAborted();
        const current = this.document(bot, id, undefined, cause?.runId);
        if (patch.target !== undefined) {
          const target = this.document(bot, id, patch.target);
          if (target.deleted) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
          return this.changeDocument(
            bot,
            id,
            revision,
            { path: target.path, content: target.content },
            cause?.runId,
          );
        }
        if (patch.deleted) return this.changeDocument(bot, id, revision, null, cause?.runId);
        const oldText = patch.oldText ?? '';
        const newText = patch.newText ?? '';
        if (
          oldText.length > 20000 ||
          newText.length > 20000 ||
          oldText.includes('\0') ||
          newText.includes('\0')
        )
          throw new Fault('INVALID_KNOWLEDGE', 400);
        const index = oldText ? current.content.indexOf(oldText) : current.content.length;
        if (index < 0) throw new Fault('KNOWLEDGE_EDIT_MISMATCH');
        if (oldText && current.content.indexOf(oldText, index + 1) >= 0)
          throw new Fault('KNOWLEDGE_EDIT_AMBIGUOUS');
        return this.changeDocument(
          bot,
          id,
          revision,
          {
            path: current.path,
            content:
              current.content.slice(0, index) +
              newText +
              current.content.slice(index + oldText.length),
          },
          cause?.runId,
        );
      },
      versions: (bot, id, before, limit, runId) => {
        if (
          !Number.isSafeInteger(before) ||
          !Number.isSafeInteger(limit) ||
          before < 1 ||
          limit < 1 ||
          limit > 20
        )
          throw new Fault('INVALID_KNOWLEDGE', 400);
        return this.installations
          .history(bot)
          .filter(
            (entry) =>
              entry.revision < before &&
              (!runId || entry.revision <= (this.pinned?.(bot, runId)?.installation.revision ?? 0)),
          )
          .reverse()
          .flatMap((entry) => {
            try {
              const doc = this.document(bot, id, entry.revision);
              return [
                {
                  revision: doc.revision,
                  path: doc.path,
                  size: doc.size,
                  deleted: doc.deleted,
                  at: doc.updatedAt,
                  actor: 'user' as const,
                },
              ];
            } catch (error) {
              if (error instanceof Fault && error.status === 404) return [];
              throw error;
            }
          })
          .slice(0, limit);
      },
      source: (bot, id) => {
        const captured = this.safeCapture(bot);
        const original = captured?.definition.knowledge.find(
          (doc) => this.documentId(bot, doc.key) === id,
        )?.original;
        if (!original) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
        return {
          id,
          bot,
          file: original,
          sha256: releaseHash(Buffer.from(original.data, 'base64')),
        };
      },
    };
  }
  private safeCapture(bot: string) {
    try {
      return this.installations.capture(bot);
    } catch (error) {
      if (error instanceof Fault && error.code === 'RELEASE_STORE_UNAVAILABLE') return undefined;
      throw error;
    }
  }
  capture(bot: string) {
    return this.safeCapture(bot);
  }
  skillOwners(captured?: Captured) {
    return captured
      ? (this.owners.get(
          `${captured.installation.botId}:${captured.installation.snapshotDigest}`,
        ) ?? [])
      : [];
  }
  private async load() {
    await Promise.all([this.store.ready, this.options.profiles.ready]);
    const installations = this.installations.list();
    if (!installations.length) return;
    await Promise.all([this.options.skills.ready, this.options.knowledge.ready]);
    for (const installation of installations) {
      await this.withResources(
        installation.botId,
        this.installations.capture(installation.botId)!.definition,
        () => this.register(installation.botId),
      );
    }
  }
  private async register(bot: string) {
    const captured = this.installations.capture(bot)!;
    let profile = await this.options.profiles.get(bot);
    if (!profile)
      profile = await this.options.profiles.registerImport(
        { id: bot, ...captured.definition.profile, instructions: '', memory: '' },
        { id: bot, sha256: captured.installation.baseDigest },
      );
    this.dates.set(bot, profile.createdAt);
  }
  private resourceOwner(bot: string, skill: BotDefinition['skills'][number]) {
    return `tpl-${releaseHash(JSON.stringify([bot, skill.key, skill.package])).slice(0, 60)}`;
  }
  private collectResources() {
    const keep = new Set(this.staging.keys());
    for (const installation of this.installations.list()) {
      const captured = this.installations.capture(installation.botId)!;
      for (const skill of captured.definition.skills)
        keep.add(this.resourceOwner(installation.botId, skill));
    }
    this.options.skills.collectTemplateIndexes(keep);
  }
  private async withResources<T>(
    bot: string,
    definition: BotDefinition,
    work: () => T | Promise<T>,
  ): Promise<T> {
    if (!isBotDefinition(definition)) throw new Fault('INVALID_PACKAGE', 400);
    const owners = definition.skills.map((skill) => this.resourceOwner(bot, skill));
    for (const owner of owners) this.staging.set(owner, (this.staging.get(owner) ?? 0) + 1);
    try {
      this.collectResources();
      for (const [index, skill] of definition.skills.entries())
        await this.options.skills.prepareTemplatePackage(skill.package, owners[index]);
      this.owners.set(`${bot}:${releaseHash(JSON.stringify(definition))}`, owners);
      return await work();
    } finally {
      for (const owner of owners) {
        const remaining = this.staging.get(owner)! - 1;
        if (remaining) this.staging.set(owner, remaining);
        else this.staging.delete(owner);
      }
      this.collectResources();
    }
  }
  private validate(bot: string, definition: BotDefinition) {
    if (!isBotDefinition(definition)) throw new Fault('INVALID_PACKAGE', 400);
    this.options.knowledge.assertTemplatePaths(
      bot,
      definition.knowledge.map((doc) => doc.path),
    );
    this.options.skills.assertTemplateNames(
      bot,
      definition.skills.map((skill) => skill.package.root),
    );
  }
  async install(id: string, release: BotRelease, source: GallerySource | null = null) {
    await this.ready;
    await Promise.all([this.options.skills.ready, this.options.knowledge.ready]);
    if (!isBotRelease(release)) throw new Fault('INVALID_PACKAGE', 400);
    if (
      release.manifest.requires.capabilities.some(
        (capability) => !['bot-releases-v1', 'skill-packages-v1'].includes(capability),
      )
    )
      throw new Fault('UNSUPPORTED_CAPABILITY', 422);
    for (const doc of release.definition.knowledge)
      if (doc.original) {
        if (!this.options.documents) throw new Fault('DOCUMENT_CAPABILITY_REQUIRED', 503);
        await this.options.documents.extract(doc.original);
      }
    const saved = await this.store.save(release);
    const candidate = this.installations.reserve(id, saved.digest, source);
    this.validate(candidate, release.definition);
    return this.withResources(candidate, saved.release.definition, async () => {
      const installation = await this.installations.install(id, saved.digest, source, candidate);
      await this.register(installation.botId);
      return installation;
    });
  }
  async prepare(bot: string, release: BotRelease) {
    await this.ready;
    if (!isBotRelease(release)) throw new Fault('INVALID_PACKAGE', 400);
    if (
      release.manifest.requires.capabilities.some(
        (capability) => !['bot-releases-v1', 'skill-packages-v1'].includes(capability),
      )
    )
      throw new Fault('UNSUPPORTED_CAPABILITY', 422);
    const saved = await this.store.save(release);
    return this.installations.prepare(bot, saved.digest);
  }
  async commit(planId: string, choices: ReleaseChoices, id: string) {
    await this.ready;
    if (this.installations.receipt(id)) return this.installations.commit(planId, choices, id);
    const plan = this.installations.planResult(planId, choices);
    this.validate(plan.bot, plan.definition);
    for (const doc of plan.definition.knowledge)
      if (doc.original) {
        if (!this.options.documents) throw new Fault('DOCUMENT_CAPABILITY_REQUIRED', 503);
        await this.options.documents.extract(doc.original);
      }
    return this.withResources(plan.bot, plan.definition, () => {
      this.validate(plan.bot, plan.definition);
      const current = this.capture(plan.bot);
      if (!current || current.installation.revision !== plan.revision)
        throw new Fault('INSTALLATION_CONFLICT');
      // Reappearing historical content also needs fresh consent; rollback must not revive an old binding.
      this.options.skills.disableTemplateBindings(
        plan.bot,
        (
          this.owners.get(`${plan.bot}:${releaseHash(JSON.stringify(plan.definition))}`) ?? []
        ).filter((owner) => !this.skillOwners(current).includes(owner)),
      );
      return this.installations.commit(planId, choices, id);
    });
  }
  async edit(bot: string, revision: number, definition: BotDefinition, id: string) {
    await this.ready;
    if (this.installations.receipt(id))
      return this.installations.edit(bot, revision, definition, id);
    return this.withResources(bot, definition, () => {
      this.validate(bot, definition);
      const current = this.capture(bot);
      if (!current || current.installation.revision !== revision)
        throw new Fault('INSTALLATION_CONFLICT');
      this.options.skills.disableTemplateBindings(
        bot,
        (this.owners.get(`${bot}:${releaseHash(JSON.stringify(definition))}`) ?? []).filter(
          (owner) => !this.skillOwners(current).includes(owner),
        ),
      );
      return this.installations.edit(bot, revision, definition, id);
    });
  }
  private documentId(bot: string, key: string) {
    return `tpl-${releaseHash(`${bot}:${key}`).slice(0, 40)}`;
  }
  private definitionAt(bot: string, revision?: number, runId?: string) {
    const captured = runId
      ? (this.pinned?.(bot, runId) ?? this.safeCapture(bot))
      : this.safeCapture(bot);
    if (!captured) return undefined;
    if (runId && revision !== undefined && revision > captured.installation.revision)
      throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
    if (revision === undefined || captured.installation.revision === revision) return captured;
    const history = this.installations.history(bot).find((entry) => entry.revision === revision);
    if (!history) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
    const row = this.store.db
      .select()
      .from(releaseSnapshots)
      .where(eq(releaseSnapshots.digest, history.snapshot))
      .get();
    if (!row || releaseHash(row.content) !== history.snapshot)
      throw new Fault('PACKAGE_INTEGRITY_ERROR', 503);
    return {
      installation: { ...captured.installation, revision },
      definition: JSON.parse(row.content) as BotDefinition,
    };
  }
  private dto(
    bot: string,
    doc: ReleaseKnowledge,
    revision: number,
    deleted = false,
  ): KnowledgeDocument {
    const at = this.dates.get(bot) ?? new Date().toISOString();
    const updated =
      this.installations.history(bot).find((entry) => entry.revision === revision)?.at || at;
    return {
      id: this.documentId(bot, doc.key),
      bot,
      path: doc.path,
      content: doc.content,
      size: Buffer.byteLength(doc.content),
      revision,
      deleted,
      createdAt: at,
      updatedAt: updated,
      ...(doc.original
        ? {
            source: {
              name: doc.original.name,
              size: Buffer.from(doc.original.data, 'base64').length,
              sha256: releaseHash(Buffer.from(doc.original.data, 'base64')),
            },
          }
        : {}),
    };
  }
  private documents(bot: string, deleted: boolean, runId?: string) {
    const captured = this.definitionAt(bot, undefined, runId);
    if (!captured) return [];
    const result = captured.definition.knowledge.map((doc) =>
      this.dto(bot, doc, captured.installation.revision),
    );
    if (deleted)
      for (const history of this.installations
        .history(bot)
        .filter((entry) => entry.revision <= captured.installation.revision)
        .reverse()) {
        for (const doc of this.definitionAt(bot, history.revision)!.definition.knowledge)
          if (!result.some((entry) => entry.id === this.documentId(bot, doc.key)))
            result.push(this.dto(bot, doc, captured.installation.revision, true));
      }
    return result;
  }
  private document(bot: string, id: string, revision?: number, runId?: string) {
    const captured = this.definitionAt(bot, revision, runId);
    const doc = captured?.definition.knowledge.find(
      (item) => this.documentId(bot, item.key) === id,
    );
    if (doc && captured) return this.dto(bot, doc, captured.installation.revision);
    if (revision === undefined) {
      const deleted = this.documents(bot, true, runId).find((entry) => entry.id === id);
      if (deleted) return deleted;
    }
    throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
  }
  private changeDocument(
    bot: string,
    id: string,
    revision: number,
    input: { path: string; content: string } | null,
    runId?: string,
  ) {
    const captured = this.safeCapture(bot);
    const pinned = runId ? this.pinned?.(bot, runId) : undefined;
    if (
      !captured ||
      captured.installation.revision !== revision ||
      (pinned && pinned.installation.revision !== revision)
    )
      throw new Fault('KNOWLEDGE_CONFLICT');
    const current = this.document(bot, id);
    const definition = structuredClone(captured.definition);
    const original =
      definition.knowledge.find((doc) => this.documentId(bot, doc.key) === id) ??
      this.installations
        .history(bot)
        .flatMap((entry) => this.definitionAt(bot, entry.revision)!.definition.knowledge)
        .find((doc) => this.documentId(bot, doc.key) === id);
    if (!original) throw new Fault('KNOWLEDGE_NOT_FOUND', 404);
    definition.knowledge = definition.knowledge.filter(
      (doc) => this.documentId(bot, doc.key) !== id,
    );
    if (input) {
      if (!isKnowledgeContent(input.content)) throw new Fault('INVALID_KNOWLEDGE', 400);
      definition.knowledge.push({ ...original, ...input });
    } else if (current.deleted) return current;
    this.validate(bot, definition);
    this.installations.edit(bot, revision, definition, randomUUID());
    // A knowledge-only override retains the exact same immutable skill owners.
    this.owners.set(
      `${bot}:${releaseHash(JSON.stringify(definition))}`,
      this.skillOwners(captured),
    );
    return this.document(bot, id);
  }
  close() {
    this.store.close();
  }
  async recover(bot: string) {
    await this.register(bot);
  }
}
