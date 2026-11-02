import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeWorkspace } from './native-workspace.js';
import { Skills } from './skills.js';

test('reads resources progressively and materializes relative paths without running scripts or granting host shell', async () => {
  const { SkillTools } = await import(new URL('./skill-tools.js', import.meta.url).href);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-tools-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const content =
      '---\nname: mock-tools\ndescription: Synthetic skill tools\n---\nRead references/guide.txt.\n';
    const skill = await store.importPackage({
      files: [
        { path: 'SKILL.md', data: Buffer.from(content).toString('base64') },
        {
          path: 'references/guide.txt',
          data: Buffer.from('SYNTHETIC ' + 'x'.repeat(33000)).toString('base64'),
        },
        { path: 'references/emoji.txt', data: Buffer.from('😀X').toString('base64') },
        {
          path: 'scripts/run.py',
          data: Buffer.from('raise SystemExit("MUST NOT AUTO RUN")').toString('base64'),
        },
      ],
    });
    await store.bind('mock-a', {
      id: skill.id,
      revision: skill.revision,
      bindingRevision: 0,
      enabled: true,
    });
    const snapshot = await store.capture('mock-a'),
      files = new NativeWorkspace(path.join(root, 'workspace'));
    await files.prepare();
    const run = {
      bot: 'mock-a',
      id: 'mock-run',
      abort: new AbortController(),
      skills: snapshot,
      task: { prompt: 'Use the skill' },
      vision: false,
    };
    const tools = new SkillTools(
      store,
      async (_run: unknown, bundle: Parameters<typeof files.stageSkill>[0]) => ({
        directory: await files.stageSkill(bundle),
        execution: 'native-gui',
      }),
    );
    const first = JSON.parse(
      (await tools.invoke(run, 'skill_read', { skill: 'mock-tools', path: 'references/guide.txt' }))
        .content[0].text,
    );
    assert.equal(first.content.length, 16000);
    assert.equal(first.nextOffset, 16000);
    const emoji = JSON.parse(
      (
        await tools.invoke(run, 'skill_read', {
          skill: 'mock-tools',
          path: 'references/emoji.txt',
          limit: 1,
        })
      ).content[0].text,
    );
    assert.equal(emoji.content, '😀');
    assert.equal(emoji.nextOffset, 2);
    const prepared = JSON.parse(
      (await tools.invoke(run, 'skill_prepare', { skill: 'mock-tools' })).content[0].text,
    );
    assert.equal(prepared.execution, 'native-gui');
    assert.equal(
      (await readFile(path.join(prepared.directory, 'scripts/run.py'))).toString(),
      'raise SystemExit("MUST NOT AUTO RUN")',
    );
    assert.equal(
      JSON.parse(
        (await tools.invoke(run, 'skill_prepare', { skill: 'mock-tools' })).content[0].text,
      ).directory,
      prepared.directory,
    );
    await assert.rejects(
      tools.invoke({ ...run, skills: await store.capture('mock-b') }, 'skill_read', {
        skill: 'mock-tools',
        path: 'SKILL.md',
      }),
      { code: 'SKILL_NOT_AVAILABLE' },
    );
    await assert.rejects(
      tools.invoke(run, 'skill_read', { skill: 'mock-tools', path: '../outside.txt' }),
      { code: 'INVALID_SKILL_PATH' },
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('manual-only resource access requires a slash invocation in the accepted human prompt', async () => {
  const { SkillTools } = await import(new URL('./skill-tools.js', import.meta.url).href);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-manual-'));
  const store = new Skills(path.join(root, 'skills.sqlite'));
  try {
    const content =
      '---\nname: mock-manual\ndescription: Synthetic manual\ndisable-model-invocation: true\n---\nSynthetic instructions.\n';
    const skill = await store.import(content);
    await store.bind('mock-a', { id: skill.id, revision: 1, bindingRevision: 0, enabled: true });
    const tools = new SkillTools(store, async () => {
      throw new Error('MUST NOT STAGE');
    });
    const run = {
      bot: 'mock-a',
      id: 'mock-run',
      abort: new AbortController(),
      skills: await store.capture('mock-a'),
      task: { prompt: 'Synthetic request' },
    };
    await assert.rejects(
      tools.invoke(run, 'skill_read', { skill: 'mock-manual', path: 'SKILL.md' }),
      { code: 'SKILL_NOT_AVAILABLE' },
    );
    const result = await tools.invoke(
      { ...run, task: { prompt: '/mock-manual Synthetic request' } },
      'skill_read',
      { skill: 'mock-manual', path: 'SKILL.md' },
    );
    assert.equal(JSON.parse(result.content[0].text).content, content);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
