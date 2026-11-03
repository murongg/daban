import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
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
    expect(search.items[0].name).toBe('mock-discovered');
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
    expect((await store.list(run.bot)).items.length).toBe(0);
    await cards.reply(run.bot, run.id, first.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Cancel'] }],
    });
    expect((await denied).isError).toBe(true);
    expect((await store.list(run.bot)).items.length).toBe(0);
    expect((await tools.invoke(run, 'skill_preview', { source })).isError).toBe(true);
    const initialSnapshot = await store.capture(run.bot);
    const nextRun = {
      ...run,
      id: 'mock-next-run',
      abort: new AbortController(),
      skills: initialSnapshot,
    };
    const next = JSON.parse(
      (await tools.invoke(nextRun, 'skill_preview', { source })).content[0].text,
    );
    await expect(
      tools.invoke({ ...run, bot: 'mock-b' }, 'skill_install', { previewId: next.previewId }),
    ).rejects.toMatchObject({ code: 'SKILL_PREVIEW_EXPIRED' });
    const accepted = tools.invoke(nextRun, 'skill_install', { previewId: next.previewId });
    const second = await pending();
    bundle.files[1].data = Buffer.from('CHANGED AFTER REVIEW').toString('base64');
    await cards.reply(run.bot, nextRun.id, second.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Install and enable'] }],
    });
    const result = JSON.parse((await accepted).content[0].text);
    expect(result.installed).toBe(true);
    expect(result.enabled).toBe(true);
    const installed = (await store.list(run.bot)).items[0];
    expect(installed.enabled).toBe(true);
    expect((await store.list('mock-b')).items.length).toBe(0);
    expect(result.applies).toBe('current-task');
    expect(result.ownerBot).toBe(run.bot);
    expect(
      nextRun.skills,
      'The native DSH session fingerprint must retain its original skill context',
    ).toBe(initialSnapshot);
    expect(initialSnapshot.skills.length).toBe(0);
    const { SkillTools } = await import(new URL('./skill-tools.js', import.meta.url).href);
    const resources = new SkillTools(
      store,
      async () => ({ directory: '/synthetic/prepared', execution: 'linux-workspace' }),
      tools,
    );
    const instructions = JSON.parse(
      (await resources.invoke(nextRun, 'skill_read', { skill: installed.name, path: 'SKILL.md' }))
        .content[0].text,
    );
    expect.assert(instructions.content.includes('Use assets/template.bin'));
    expect(
      (await store.readResource(installed.id, installed.revision, 'assets/template.bin', run.bot))
        .data,
    ).toBe(Buffer.from([0, 255, 1]).toString('base64'));
    expect(
      await tools.invoke(nextRun, 'skill_install', { previewId: next.previewId }),
    ).toStrictEqual(await accepted);
    expect((await cards.list()).length).toBe(2);
    Reflect.get(tools, 'release').call(tools, nextRun);
    await expect(
      tools.invoke(nextRun, 'skill_install', { previewId: next.previewId }),
    ).rejects.toMatchObject({
      code: 'SKILL_PREVIEW_EXPIRED',
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('installing a manual-only skill does not claim automatic invocation authority', async () => {
  const { SkillDiscovery } = await import(entry);
  const root = await mkdtemp(path.join(tmpdir(), 'mock-manual-install-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  const cards = new Interactions(path.join(root, 'interactions'));
  const content =
    '---\nname: mock-manual-new\ndescription: Synthetic manual-only skill\ndisable-model-invocation: true\n---\nSynthetic instructions.\n';
  const bundle = {
    root: 'mock-manual-new',
    files: [{ path: 'SKILL.md', data: Buffer.from(content).toString('base64') }],
  };
  const source = { platform: 'github', url: 'https://github.com/synthetic-org/mock-manual' };
  const run: import('./agent-tools.js').AgentToolRun = {
    bot: 'mock-alpha',
    id: 'mock-run',
    sessionId: 'mock-session',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: root,
    skills: await store.capture('mock-alpha'),
  };
  const tools = new SkillDiscovery(store, cards, {
    search: async () => {
      throw Error('UNEXPECTED_SEARCH');
    },
    preview: async () => ({
      kind: 'package',
      selection: { kind: 'package', package: bundle, preview: inspectSkillPackage(bundle) },
      origin: { label: 'Synthetic source', url: source.url, revision: 'a'.repeat(40) },
    }),
  });
  try {
    const preview = JSON.parse(
      (await tools.invoke(run, 'skill_preview', { source })).content[0].text,
    );
    const pending = tools.invoke(run, 'skill_install', { previewId: preview.previewId });
    let question: Awaited<ReturnType<Interactions['list']>>[number] | undefined;
    for (let i = 0; i < 100; i++) {
      question = (await cards.list()).find((item) => item.status === 'pending');
      if (question) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect.assert(question);
    await cards.reply(run.bot, run.id!, question.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Install and enable'] }],
    });
    const result = JSON.parse((await pending).content[0].text);
    expect(result.installed).toBe(true);
    expect(result.applies).toBe('manual-invocation');
  } finally {
    run.abort.abort();
    tools.release(run);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
