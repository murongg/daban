import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { AgentToolRun } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { Interactions } from './interactions.js';
import { SkillDiscovery } from './skill-discovery.js';
import { inspectSkillPackage } from './skill-package.js';
import { Skills } from './skills.js';

const draft = {
  content:
    '---\nname: mock-authored\ndescription: Synthetic authored workflow\n---\nRead references/guide.txt and organize synthetic examples.\n',
  files: [{ path: 'references/guide.txt', content: 'SYNTHETIC APPROVED REFERENCE' }],
};
function resultValue(result: ToolResult): {
  previewId: string;
  digest: string;
  installed: boolean;
  enabled: boolean;
  name: string;
  id: string;
  applies: string;
} {
  const item = result.content[0];
  expect.assert(item.type === 'text');
  return JSON.parse(item.text);
}
async function authoringFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-skill-authoring-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  const cards = new Interactions(path.join(root, 'interactions'));
  const run: AgentToolRun = {
    bot: 'mock-author',
    id: 'mock-authoring-run',
    sessionId: 'mock-session',
    abort: new AbortController(),
    workdir: root,
    canonicalRoot: root,
    toolCount: 0,
    limit: 20,
    seen: {},
    trace: [],
    task: {
      requestId: 'mock-authoring-request',
      prompt: 'Save the synthetic workflow as a skill.',
    },
    skills: await store.capture('mock-author'),
  };
  const tools = new SkillDiscovery(store, cards, {
    search: async () => {
      throw new Error('UNEXPECTED_NETWORK');
    },
    preview: async () => {
      throw new Error('UNEXPECTED_NETWORK');
    },
  });
  return {
    root,
    store,
    cards,
    run,
    tools,
    async pending() {
      for (let i = 0; i < 100; i++) {
        const item = (await cards.list()).find((item) => item.status === 'pending');
        if (item) return item;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error('NO_CONFIRMATION');
    },
    async close() {
      run.abort.abort();
      tools.release(run);
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('authored skills preview offline and install only the confirmed bytes for the current Bot', async () => {
  const f = await authoringFixture();
  try {
    const input = structuredClone(draft);
    const preview = resultValue(await f.tools.invoke(f.run, 'skill_create', input));
    expect(preview.name).toBe('mock-authored');
    expect(await f.store.list(f.run.bot)).toMatchObject({ items: [] });
    const installing = f.tools.invoke(f.run, 'skill_install', { previewId: preview.previewId });
    const retry = f.tools.invoke(f.run, 'skill_install', { previewId: preview.previewId });
    const question = await f.pending();
    expect(question.kind).toBe('question');
    expect(JSON.stringify(question)).toContain(preview.digest);
    expect(question.kind === 'question' && question.questions[0].detail).toContain(
      draft.content.trim(),
    );
    expect(await f.store.list(f.run.bot)).toMatchObject({ items: [] });
    input.content = input.content.replace('organize', 'CHANGED AFTER REVIEW');
    input.files[0].content = 'SYNTHETIC CHANGED AFTER REVIEW';
    await f.cards.reply(f.run.bot, f.run.id!, question.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Install and enable'] }],
    });
    const installed = resultValue(await installing);
    expect(installed).toMatchObject({
      installed: true,
      enabled: true,
      name: 'mock-authored',
      applies: 'current-task',
    });
    expect(await retry).toEqual(await installing);
    expect(await f.store.read(installed.id, f.run.bot)).toMatchObject({ content: draft.content });
    expect((await f.store.readResource(installed.id, 1, draft.files[0].path, f.run.bot)).data).toBe(
      Buffer.from(draft.files[0].content).toString('base64'),
    );
    expect((await f.store.list('mock-other')).items).toEqual([]);
    expect(f.run.skills?.skills).toEqual([]);
    const { SkillTools } = await import('./skill-tools.js');
    const resources = new SkillTools(
      f.store,
      async () => {
        throw new Error('MUST NOT EXECUTE');
      },
      f.tools,
    );
    const response = await resources.invoke(f.run, 'skill_read', {
      skill: installed.name,
      path: draft.files[0].path,
    });
    const text = response.content[0];
    expect.assert(text.type === 'text');
    expect(JSON.parse(text.text).content).toBe(draft.files[0].content);
    expect(await f.cards.list()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('authored skill refusal, task ownership and cancellation cannot be bypassed by a fresh preview', async () => {
  const f = await authoringFixture();
  try {
    const preview = resultValue(await f.tools.invoke(f.run, 'skill_create', draft));
    await expect(
      f.tools.invoke({ ...f.run, bot: 'mock-other' }, 'skill_install', {
        previewId: preview.previewId,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_PREVIEW_EXPIRED' });
    const installing = f.tools.invoke(f.run, 'skill_install', { previewId: preview.previewId });
    const question = await f.pending();
    await f.cards.reply(f.run.bot, f.run.id!, question.id, {
      kind: 'answer',
      answers: [{ id: 'install', selected: ['Cancel'] }],
    });
    expect(await installing).toMatchObject({ isError: true });
    expect(await f.tools.invoke(f.run, 'skill_create', structuredClone(draft))).toMatchObject({
      isError: true,
    });
    expect(await f.cards.list()).toHaveLength(1);
    f.run.abort.abort();
    await expect(f.tools.invoke(f.run, 'skill_create', draft)).rejects.toThrow();
    expect((await f.store.list(f.run.bot)).items).toEqual([]);
  } finally {
    await f.close();
  }
});

test('authored skill previews reject malformed metadata, unsafe resource paths and unknown fields before saving', async () => {
  const f = await authoringFixture();
  try {
    for (const input of [
      { content: 'SYNTHETIC INVALID FRONTMATTER' },
      { content: draft.content, files: [{ path: '../outside.txt', content: 'SYNTHETIC' }] },
      { content: draft.content, files: [{ path: 'SKILL.md', content: draft.content }] },
      {
        content: draft.content,
        files: [{ path: 'refs.txt', content: 'SYNTHETIC', unknown: true }],
      },
      { content: draft.content, files: [{ path: 'refs.txt', content: 123 }] },
      { content: draft.content, bot: 'mock-other' },
    ])
      await expect(f.tools.invoke(f.run, 'skill_create', input)).rejects.toThrow();
    expect((await f.store.list(f.run.bot)).items).toEqual([]);
    expect(await f.cards.list()).toEqual([]);
  } finally {
    await f.close();
  }
});

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
