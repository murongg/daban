import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Knowledge } from '../packages/engine/src/knowledge.js';
import { BotProfiles } from '../packages/engine/src/profiles.js';
import { Skills } from '../packages/engine/src/skills.js';
import { BotTemplates } from '../packages/engine/src/templates.js';
import { syntheticRelease } from './testing/releases.js';

test('template resources are private, readonly snapshots and old task reads survive an upgrade', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-template-runtime-'));
  const profiles = new BotProfiles(path.join(directory, 'bots'));
  const knowledge = new Knowledge(path.join(directory, 'knowledge.sqlite'));
  const skills = new Skills(path.join(directory, 'skills.sqlite'));
  const templates = new BotTemplates({
    directory: path.join(directory, 'templates'),
    profiles,
    knowledge,
    skills,
  });
  try {
    await templates.ready;
    const release = syntheticRelease();
    release.manifest.requires.capabilities.push('skill-packages-v1');
    const content = '---\nname: mock-guide\ndescription: Synthetic guide\n---\nSYNTHETIC FIRST';
    release.definition.skills = [
      {
        key: 'guide',
        package: {
          root: 'mock-guide',
          files: [
            { path: 'SKILL.md', data: Buffer.from(content).toString('base64'), executable: false },
          ],
        },
      },
    ];
    release.definition.knowledge = [{ key: 'manual', path: 'mock.md', content: 'SYNTHETIC FIRST' }];
    const installation = await templates.install('mock-create', release);
    const bot = installation.botId;
    expect((await profiles.get(bot))!.memory).toBe('');
    const snapshot = templates.capture(bot)!;
    templates.pinned = (owner, run) =>
      owner === bot && run === 'mock-old-run' ? snapshot : undefined;
    const catalog = await skills.list(bot);
    expect(catalog.items.find((item) => item.name === 'mock-guide')!.enabled).toBe(false);
    const firstSkill = catalog.items.find((item) => item.name === 'mock-guide')!;
    await skills.bind(bot, {
      id: firstSkill.id,
      revision: firstSkill.revision,
      bindingRevision: firstSkill.bindingRevision,
      enabled: true,
    });
    const document = (await knowledge.list(bot))[0];
    await expect(knowledge.read('mock-other-bot', document.id)).rejects.toMatchObject({
      code: 'KNOWLEDGE_NOT_FOUND',
    });
    const next = structuredClone(release);
    next.manifest.releaseVersion = '1.1.0';
    next.definition.profile.instructions = 'SYNTHETIC UPDATED ROLE';
    next.definition.knowledge[0].content = 'SYNTHETIC SECOND';
    const plan = await templates.prepare(bot, next);
    await templates.commit(plan.id, {}, 'mock-upgrade');
    await expect(
      profiles.copy({
        id: 'mock-stale-copy',
        bot,
        revision: 1,
        name: 'Synthetic copy',
        memory: false,
        sourceInstructions: release.definition.profile.instructions,
      }),
    ).rejects.toMatchObject({ code: 'BOT_PROFILE_CONFLICT' });
    expect((await knowledge.read(bot, document.id)).content).toBe('SYNTHETIC SECOND');
    expect((await knowledge.read(bot, document.id, undefined, 'mock-old-run')).content).toBe(
      'SYNTHETIC FIRST',
    );
    await expect(
      profiles.update(bot, 1, { instructions: 'SYNTHETIC BYPASS' }),
    ).rejects.toMatchObject({ code: 'INSTALLATION_UPDATE_REQUIRED' });
    const current = await knowledge.read(bot, document.id);
    await knowledge.write(bot, {
      id: current.id,
      revision: current.revision,
      path: current.path,
      content: 'SYNTHETIC LOCAL',
    });
    expect((await knowledge.read(bot, current.id)).content).toBe('SYNTHETIC LOCAL');
    const changed = structuredClone(next);
    changed.manifest.releaseVersion = '1.2.0';
    changed.definition.skills[0].package.files[0].data = Buffer.from(
      content.replace('FIRST', 'SECOND'),
    ).toString('base64');
    const changedPlan = await templates.prepare(bot, changed);
    await templates.commit(changedPlan.id, {}, 'mock-changed-skill');
    const newSkill = (await skills.list(bot)).items.find((item) => item.name === 'mock-guide')!;
    expect(newSkill.enabled).toBe(false);
    const rollback = await templates.installations.prepareRollback(bot, 1);
    await templates.commit(rollback.id, {}, 'mock-skill-rollback');
    expect((await skills.list(bot)).items.find((item) => item.name === 'mock-guide')!.enabled).toBe(
      false,
    );
  } finally {
    templates.close();
    await skills.close();
    await knowledge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
