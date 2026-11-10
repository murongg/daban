import { randomUUID } from 'node:crypto';
import {
  type BotRelease,
  type BotTemplateCommand,
  botReleaseText,
  type PrepareRelease,
  type ReleaseSkill,
} from '@daban/protocol';
import type { BotBundles } from './bundles.js';
import { Fault } from './control.js';
import { GalleryClient } from './gallery-client.js';
import { releaseHash } from './releases.js';
import type { BotTemplates } from './templates.js';

export class TemplateService {
  readonly gallery: GalleryClient;
  constructor(
    readonly templates: BotTemplates,
    readonly bundles: BotBundles,
  ) {
    this.gallery = new GalleryClient(templates.store);
  }
  async prepareRelease(input: PrepareRelease) {
    await this.templates.ready;
    const { profiles, skills, knowledge } = this.templates.options;
    const profile = await profiles.get(input.bot);
    if (!profile) throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
    profiles.assertActive(input.bot);
    const previous = this.templates.store.draftForBot(input.bot);
    const captured = this.templates.capture(input.bot);
    // Personal resources enter a release only through an explicit reviewed selection.
    let definition = captured
      ? {
          ...captured.definition,
          skills: captured.definition.skills.filter((skill) => input.skills?.includes(skill.key)),
          knowledge: captured.definition.knowledge.filter((doc) =>
            input.knowledge?.includes(doc.key),
          ),
        }
      : undefined;
    if (
      definition &&
      (definition.skills.length !== (input.skills?.length ?? 0) ||
        definition.knowledge.length !== (input.knowledge?.length ?? 0))
    )
      throw new Fault('INSTALLATION_CONFLICT');
    if (!definition) {
      const catalog = await skills.list(input.bot);
      const documents = (await knowledge.list(input.bot)).filter((doc) =>
        input.knowledge?.includes(doc.id),
      );
      const selectedSkills = catalog.items.filter(
        (skill) => skill.enabled && !skill.system && input.skills?.includes(skill.id),
      );
      if (
        documents.length !== (input.knowledge?.length ?? 0) ||
        selectedSkills.length !== (input.skills?.length ?? 0)
      )
        throw new Fault('INSTALLATION_CONFLICT');
      const bundle = await this.bundles.export({
        bot: input.bot,
        revision: profile.revision,
        memory: false,
        skills: selectedSkills.map(({ id, revision }) => ({ id, revision })),
        knowledge: documents.map(({ id, revision }) => ({ id, revision })),
        originals: input.originals,
      });
      const packages: ReleaseSkill[] = bundle.skills.map((skill, index) => ({
        key: selectedSkills[index].id,
        package: {
          root: skill.name,
          files: skill.package?.files.map((file) => ({
            ...file,
            executable: file.executable ?? false,
          })) ?? [
            {
              path: 'SKILL.md',
              data: Buffer.from(skill.content).toString('base64'),
              executable: false,
            },
          ],
        },
      }));
      definition = {
        profile: bundle.profile,
        defaultPreferences: input.defaultPreferences,
        skills: packages,
        knowledge: bundle.knowledge.map((doc, index) => ({ key: documents[index].id, ...doc })),
      };
    }
    const inherited = captured
      ? await this.templates.store.read(captured.installation.baseDigest)
      : undefined;
    const release: BotRelease = {
      format: 'daban.bot',
      version: 3,
      manifest: {
        templateId: previous?.template ?? randomUUID(),
        releaseVersion: input.releaseVersion,
        summary: input.summary,
        license: input.license,
        changelog: input.changelog,
        requires: inherited?.manifest.requires ?? {
          capabilities: [
            'bot-releases-v1',
            ...(definition.skills.length ? ['skill-packages-v1'] : []),
          ],
          tools: [],
          model: { toolCalling: true, vision: false },
        },
        derivedFrom: captured?.installation.source
          ? {
              ...captured.installation.source,
              templateId: captured.installation.templateId,
              releaseVersion: captured.installation.releaseVersion,
              digest: captured.installation.baseDigest,
            }
          : null,
      },
      definition: {
        ...definition,
        profile: { ...definition.profile, name: profile.name, color: profile.color },
        defaultPreferences: input.defaultPreferences,
        knowledge: definition.knowledge.map(({ original, ...doc }) => ({
          ...doc,
          ...(input.originals && original ? { original } : {}),
        })),
      },
    };
    const saved = await this.templates.store.save(release);
    const revision = await this.templates.store.draft(
      saved.release,
      previous?.revision ?? 0,
      input.bot,
    );
    return { release: saved.release, digest: saved.digest, revision };
  }
  async remoteInstall(command: Extract<BotTemplateCommand, { type: 'gallery.install' }>) {
    const value = await this.gallery.download(
      command.origin,
      command.templateId,
      command.version,
      command.digest,
    );
    return this.templates.install(command.id, value.release, value.source);
  }
  async remoteUpgrade(bot: string, version: string) {
    const current = this.templates.installations.read(bot);
    if (!current?.source) throw new Fault('GALLERY_SOURCE_NOT_FOUND', 404);
    const source = this.gallery.list().find((item) => item.origin === current.source!.sourceOrigin);
    if (source?.sourceId !== current.source.sourceId) throw new Fault('GALLERY_SOURCE_CHANGED');
    const value = await this.gallery.download(source.origin, current.templateId, version);
    return this.templates.prepare(bot, value.release);
  }
  async invoke(command: BotTemplateCommand): Promise<unknown> {
    await this.templates.ready;
    const { installations, store } = this.templates;
    if ('bot' in command) this.templates.options.profiles.assertRegistered(command.bot);
    if ('bot' in command && command.type !== 'bot.installation.read')
      this.templates.options.profiles.assertActive(command.bot);
    switch (command.type) {
      case 'gallery.sources':
        return this.gallery.list();
      case 'gallery.source.save':
        return this.gallery.save(command.origin, command.token);
      case 'gallery.source.remove':
        return this.gallery.remove(command.origin);
      case 'gallery.bind': {
        const current = installations.read(command.bot);
        if (!current) throw new Fault('INSTALLATION_NOT_FOUND', 404);
        const value = await this.gallery.download(
          command.origin,
          current.templateId,
          current.releaseVersion,
          current.baseDigest,
        );
        return installations.bind(command.bot, command.revision, value.source, command.id);
      }
      case 'gallery.templates':
        return this.gallery.templates(command.origin, command.q, command.cursor);
      case 'gallery.releases':
        return this.gallery.releases(command.origin, command.templateId);
      case 'gallery.install':
        return this.remoteInstall(command);
      case 'gallery.preview': {
        const value = await this.gallery.download(
          command.origin,
          command.templateId,
          command.version,
          command.digest,
        );
        await store.save(value.release);
        return { release: value.release, digest: command.digest };
      }
      case 'gallery.upgrade.prepare':
        return this.remoteUpgrade(command.bot, command.version);
      case 'bot.release.prepare':
        return this.prepareRelease(command);
      case 'bot.release.export':
        return store.publishDraft(command.bot, command.revision, command.digest);
      case 'bot.release.publish': {
        store.publishDraft(command.bot, command.revision, command.digest);
        const draft = store.draftForBot(command.bot);
        if (
          !draft ||
          draft.revision !== command.revision ||
          releaseHash(draft.content) !== command.digest
        )
          throw new Fault('DRAFT_CONFLICT');
        return this.gallery.publish(
          command.origin,
          command.namespace,
          command.slug,
          command.digest,
          command.visibility,
        );
      }
      case 'bot.install.prepare': {
        const value = await store.save(command.release);
        return { digest: value.digest, release: value.release };
      }
      case 'bot.install.commit':
        return this.templates.install(command.id, await store.read(command.digest));
      case 'bot.installation.read':
        return {
          installation: installations.read(command.bot) ?? null,
          definition: this.templates.capture(command.bot)?.definition ?? null,
          history: installations.history(command.bot),
          draft: store.draftForBot(command.bot) ?? null,
        };
      case 'bot.installation.update':
        return this.templates.edit(command.bot, command.revision, command.definition, command.id);
      case 'bot.upgrade.prepare': {
        const current = installations.read(command.bot);
        if (current?.source) {
          if (
            this.gallery.list().find((source) => source.origin === current.source!.sourceOrigin)
              ?.sourceId !== current.source.sourceId
          )
            throw new Fault('GALLERY_SOURCE_CHANGED');
          await this.gallery.download(
            current.source.sourceOrigin,
            command.release.manifest.templateId,
            command.release.manifest.releaseVersion,
            releaseHash(botReleaseText(command.release)),
          );
        }
        return this.templates.prepare(command.bot, command.release);
      }
      case 'bot.rollback.prepare':
        return installations.prepareRollback(command.bot, command.revision);
      case 'bot.upgrade.commit':
      case 'bot.rollback.commit': {
        const plan = installations.planResult(command.planId, command.choices);
        if (plan.digest !== command.planDigest) throw new Fault('INSTALLATION_CONFLICT');
        this.templates.options.profiles.assertActive(plan.bot);
        return this.templates.commit(command.planId, command.choices, command.id);
      }
      case 'bot.installation.receipt': {
        const receipt = installations.receipt(command.id);
        if (receipt) await this.templates.recover(receipt.botId);
        return receipt ?? null;
      }
      case 'bot.installation.cancel':
        return installations.cancel(command.id);
    }
  }
}
