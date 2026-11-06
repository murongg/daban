import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Knowledge } from '../packages/engine/src/knowledge.js';
import { BotProfiles } from '../packages/engine/src/profiles.js';
import { Skills } from '../packages/engine/src/skills.js';
import { BotTemplates } from '../packages/engine/src/templates.js';
import { syntheticRelease } from './testing/releases.js';

test('repeated upgrades reclaim only template indexes while running tasks retain pinned files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-template-capacity-'));
  const profiles = new BotProfiles(path.join(dir, 'bots'));
  const skills = new Skills(path.join(dir, 'skills.sqlite'));
  const knowledge = new Knowledge(path.join(dir, 'knowledge.sqlite'));
  const templates = new BotTemplates({
    directory: path.join(dir, 'templates'),
    profiles,
    skills,
    knowledge,
  });
  try {
    await templates.ready;
    const personal = await skills.import(
      '---\nname: mock-personal\ndescription: Synthetic private skill\n---\nSYNTHETIC PRIVATE',
      'mock-other',
    );
    const release = syntheticRelease();
    release.manifest.requires.capabilities.push('skill-packages-v1');
    const main = '---\nname: mock-versioned\ndescription: Synthetic package\n---\nSYNTHETIC ROLE';
    release.definition.skills = [
      {
        key: 'versioned',
        package: {
          root: 'mock-versioned',
          files: [
            { path: 'SKILL.md', data: Buffer.from(main).toString('base64'), executable: false },
            {
              path: 'references/mock.txt',
              data: Buffer.from('SYNTHETIC PINNED').toString('base64'),
              executable: false,
            },
          ],
        },
      },
    ];
    const installed = await templates.install('mock-capacity-install', release);
    const entry = (await skills.list(installed.botId)).items[0];
    await skills.bind(installed.botId, {
      id: entry.id,
      revision: entry.revision,
      bindingRevision: entry.bindingRevision,
      enabled: true,
    });
    const captured = await skills.capture(installed.botId);
    for (let version = 0; version < 105; version++) {
      const update = structuredClone(release);
      update.manifest.releaseVersion = `2.0.${version}`;
      update.definition.skills[0].package.files[1].data = Buffer.from(
        `SYNTHETIC RESOURCE ${version}`,
      ).toString('base64');
      const plan = await templates.prepare(installed.botId, update);
      await templates.commit(plan.id, {}, `mock-capacity-${version}`);
    }
    expect(
      Buffer.from(
        (await skills.readCaptured(captured, 'mock-versioned', 'references/mock.txt')).data,
        'base64',
      ).toString(),
    ).toBe('SYNTHETIC PINNED');
    skills.release(captured);
    expect((await skills.list(installed.botId)).items).toHaveLength(1);
    expect((await skills.read(personal.id, 'mock-other')).content).toContain('SYNTHETIC PRIVATE');
  } finally {
    templates.close();
    await skills.close();
    await knowledge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
