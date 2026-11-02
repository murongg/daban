import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Interactions } from './interactions.js';
import { inspectSkillPackage } from './skill-package.js';
import { Skills } from './skills.js';

const entry = new URL('./skill-discovery.js', import.meta.url).href;
test('skill discovery installs only a reviewed task-bound snapshot after confirmation, with per-Bot enablement', async () => {
  const { SkillDiscovery } = await import(entry);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-discovery-'));
  const store = new Skills(path.join(root, 'skills.sqlite')),
    cards = new Interactions(path.join(root, 'interactions'));
  const content =
    '---\nname: mock-discovered\ndescription: Synthetic discovered package\n---\nUse assets/template.bin.\n';
  const bundle = {
    root: 'mock-discovered',
    files: [
      { path: 'SKILL.md', data: Buffer.from(content).toString('base64') },
      { path: 'assets/template.bin', data: Buffer.from([0, 255, 1]).toString('base64') },
    ],
  };
  const source = { platform: 'github', url: 'https://github.com/synthetic-org/mock-repo' };
  const registry = {
    search: async (platform: string, query: string) => ({
      platform,
      query,
      items: [
        {
          id: 'mock-item',
          name: 'mock-discovered',
          description: 'Synthetic discovered package',
          url: source.url,
          source,
        },
      ],
    }),
    preview: async () => ({
      kind: 'package',
      selection: { kind: 'package', package: bundle, preview: inspectSkillPackage(bundle) },
      origin: {
        label: 'synthetic-org/mock-repo',
        url:
          'https://github.com/synthetic-org/mock-repo/tree/' + 'a'.repeat(40) + '/mock-discovered',
        revision: 'a'.repeat(40),
      },
    }),
  };
  const run = {
    bot: 'mock-a',
    id: 'mock-run',
    sessionId: 'mock-session',
    abort: new AbortController(),
  };
  try {
    const tools = new SkillDiscovery(store, cards, registry);
    const search = JSON.parse(
      (await tools.invoke(run, 'skill_search', { platform: 'skillsmp', query: 'mock' })).content[0]
        .text,
    );
    assert.equal(search.items[0].name, 'mock-discovered');
    const preview = JSON.parse(
      (await tools.invoke(run, 'skill_preview', { source })).content[0].text,
    );
    const denied = tools.invoke(run, 'skill_install', { previewId: preview.previewId });
    const pending = async () => {
      for (let i = 0; i < 100; i++) {
        const found = (await cards.list()).find((item) => item.status === 'pending');
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error('NO_CONFIRMATION');
    };
    const first = await pending();
    assert.equal((await store.list(run.bot)).items.length, 0);
    await cards.reply(run.bot, run.id, first.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Cancel'] }],
    });
    assert.equal((await denied).isError, true);
    assert.equal((await store.list(run.bot)).items.length, 0);
    assert.equal((await tools.invoke(run, 'skill_preview', { source })).isError, true);
    const nextRun = { ...run, id: 'mock-next-run', abort: new AbortController() };
    const next = JSON.parse(
      (await tools.invoke(nextRun, 'skill_preview', { source })).content[0].text,
    );
    await assert.rejects(
      tools.invoke({ ...run, bot: 'mock-b' }, 'skill_install', { previewId: next.previewId }),
      { code: 'SKILL_PREVIEW_EXPIRED' },
    );
    const accepted = tools.invoke(nextRun, 'skill_install', { previewId: next.previewId });
    const second = await pending();
    bundle.files[1].data = Buffer.from('CHANGED AFTER REVIEW').toString('base64');
    await cards.reply(run.bot, nextRun.id, second.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Install and enable'] }],
    });
    const result = JSON.parse((await accepted).content[0].text);
    assert.equal(result.installed, true);
    assert.equal(result.enabled, true);
    const installed = (await store.list(run.bot)).items[0];
    assert.equal(installed.enabled, true);
    assert.equal((await store.list('mock-b')).items[0].enabled, false);
    assert.equal(
      (await store.readResource(installed.id, installed.revision, 'assets/template.bin')).data,
      Buffer.from([0, 255, 1]).toString('base64'),
    );
    assert.deepEqual(
      await tools.invoke(nextRun, 'skill_install', { previewId: next.previewId }),
      await accepted,
    );
    assert.equal((await cards.list()).length, 2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
