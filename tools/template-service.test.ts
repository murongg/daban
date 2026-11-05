import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { BotBundles } from '../packages/engine/src/bundles.js';
import { startGallery } from '../packages/engine/src/gallery-server.js';
import { Knowledge } from '../packages/engine/src/knowledge.js';
import { BotProfiles } from '../packages/engine/src/profiles.js';
import { Skills } from '../packages/engine/src/skills.js';
import { TemplateService } from '../packages/engine/src/template-service.js';
import { BotTemplates } from '../packages/engine/src/templates.js';

test('authoring, private publication, remote installation and update use one canonical package', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-template-service-'));
  const gallery = await startGallery({
    directory: path.join(directory, 'gallery'),
    port: 0,
    host: '127.0.0.1',
    origin: 'http://127.0.0.1',
    readMode: 'private',
  });
  const profiles = new BotProfiles(path.join(directory, 'bots'));
  const knowledge = new Knowledge(path.join(directory, 'knowledge.sqlite'));
  const skills = new Skills(path.join(directory, 'skills.sqlite'));
  const templates = new BotTemplates({
    directory: path.join(directory, 'templates'),
    profiles,
    knowledge,
    skills,
  });
  const bundles = new BotBundles({
    directory: path.join(directory, 'bundles'),
    profiles,
    knowledge,
    skills,
  });
  try {
    await templates.ready;
    const service = new TemplateService(templates, bundles);
    const author = await profiles.register({
      id: 'mock-author-bot',
      name: 'Synthetic Bot',
      instructions: 'SYNTHETIC ROLE',
      memory: 'PRIVATE SYNTHETIC MEMORY',
      color: 'mint',
    });
    const token = gallery.store.createToken({
      principalId: 'mock-author',
      namespaces: ['mock-team'],
      scopes: ['templates:write', 'releases:write'],
    });
    await knowledge.write(author.id, {
      revision: 0,
      path: 'mock-private.md',
      content: 'PRIVATE SYNTHETIC DOCUMENT',
    });
    await service.invoke({ type: 'gallery.source.save', origin: gallery.url, token: token.token });
    const sourceText = JSON.stringify(await service.invoke({ type: 'gallery.sources' }));
    expect(sourceText).not.toContain(token.token);
    const prepared = await service.prepareRelease({
      bot: author.id,
      releaseVersion: '1.0.0',
      summary: 'Synthetic only',
      license: 'UNLICENSED',
      changelog: 'Synthetic first',
      defaultPreferences: 'SYNTHETIC DEFAULT',
      originals: false,
    });
    expect(prepared.release.definition.defaultPreferences).not.toContain('PRIVATE');
    expect(prepared.release.definition.knowledge).toEqual([]);
    await service.invoke({
      type: 'bot.release.export',
      bot: author.id,
      revision: prepared.revision,
      digest: prepared.digest,
    });
    await service.invoke({
      type: 'bot.release.publish',
      bot: author.id,
      revision: prepared.revision,
      digest: prepared.digest,
      origin: gallery.url,
      namespace: 'mock-team',
      slug: 'mock-bot',
    });
    const installed = await service.remoteInstall({
      type: 'gallery.install',
      origin: gallery.url,
      templateId: prepared.release.manifest.templateId,
      version: '1.0.0',
      digest: prepared.digest,
      id: 'mock-network-install',
    });
    expect(installed.source?.sourceId).toBe(gallery.store.sourceId);
    const offline = await templates.install('mock-offline-install', prepared.release);
    const bound = await service.invoke({
      type: 'gallery.bind',
      bot: offline.botId,
      revision: offline.revision,
      origin: gallery.url,
      id: 'mock-bind-source',
    });
    expect(bound).toMatchObject({
      source: { sourceOrigin: gallery.url, sourceId: gallery.store.sourceId },
    });
    const fork = await service.prepareRelease({
      bot: installed.botId,
      releaseVersion: '1.0.0',
      summary: 'Synthetic fork',
      license: 'UNLICENSED',
      changelog: 'Synthetic fork',
      defaultPreferences: '',
      originals: false,
    });
    expect(fork.release.manifest.templateId).not.toBe(prepared.release.manifest.templateId);
    expect(fork.release.manifest.derivedFrom?.sourceId).toBe(gallery.store.sourceId);
    expect((await profiles.get(installed.botId))!.instructions).toBe('SYNTHETIC ROLE');
    const second = await service.prepareRelease({
      bot: author.id,
      releaseVersion: '1.1.0',
      summary: 'Synthetic only',
      license: 'UNLICENSED',
      changelog: 'Synthetic second',
      defaultPreferences: 'SYNTHETIC DEFAULT',
      originals: false,
    });
    expect(second.release.manifest.templateId).toBe(prepared.release.manifest.templateId);
    await service.invoke({
      type: 'bot.release.publish',
      bot: author.id,
      revision: second.revision,
      digest: second.digest,
      origin: gallery.url,
      namespace: 'mock-team',
      slug: 'mock-bot',
    });
    const plan = await service.remoteUpgrade(installed.botId, '1.1.0');
    await templates.commit(plan.id, {}, 'mock-network-upgrade');
    expect(templates.installations.read(installed.botId)!.releaseVersion).toBe('1.1.0');
    const cancelled = await templates.prepare(installed.botId, prepared.release);
    templates.installations.cancel(cancelled.id);
    await expect(templates.commit(cancelled.id, {}, 'mock-cancelled')).rejects.toMatchObject({
      code: 'INSTALLATION_CANCELLED',
    });
    const edited = await profiles.update(author.id, author.revision, {
      instructions: 'SYNTHETIC CHANGED ROLE',
    });
    expect(edited.instructions).toBe('SYNTHETIC CHANGED ROLE');
    const conflicting = await service.prepareRelease({
      bot: author.id,
      releaseVersion: '1.0.0',
      summary: 'Synthetic only',
      license: 'UNLICENSED',
      changelog: 'Synthetic changed',
      defaultPreferences: 'SYNTHETIC DEFAULT',
      originals: false,
    });
    await expect(
      service.invoke({
        type: 'bot.release.export',
        bot: author.id,
        revision: conflicting.revision,
        digest: conflicting.digest,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONTENT_CONFLICT' });
  } finally {
    await bundles.close();
    templates.close();
    await skills.close();
    await knowledge.close();
    await gallery.close();
    await rm(directory, { recursive: true, force: true });
  }
});
