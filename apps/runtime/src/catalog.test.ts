import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { CatalogTools } from './catalog.js';
import { ScheduleTools } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import { parseSkill } from './skills.js';
import { Work } from './work.js';
import { WorkspaceFiles } from './workspace.js';

test('task catalog reads actual shared Work, this Bot schedules, captured skills and only currently offered tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-catalog-'));
  const workdir = path.join(root, 'workspace');
  await mkdir(workdir);
  const work = new Work(path.join(root, 'work.sqlite'));
  let started = 0;
  const schedules = new Schedules({
    file: path.join(root, 'schedules.sqlite'),
    runner: {
      running: () => false,
      findRequest: () => undefined,
      start: async () => {
        started++;
        return {};
      },
    },
    domain: Promise.resolve({
      create: (input) => ({ ...input, kind: 'every', scheduledAt: '2026-01-01T01:00:00Z' }),
      due: () => ({ occurrenceAt: '2026-01-01T01:00:00Z' }),
      decode: (input) => input,
    }),
  });
  const tools = new AgentTools(undefined, new WorkspaceFiles(workdir));
  tools.schedules = new ScheduleTools(schedules);
  tools.catalog = new CatalogTools({
    work,
    schedules: () => schedules,
    offered: (run) => tools.list(run.bot, run.model, run.conversationId, run),
  });
  const run: AgentToolRun = {
    id: 'mock-catalog-run',
    bot: 'mock-alpha',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir,
    canonicalRoot: workdir,
    skills: {
      available: true,
      key: 'mock-captured',
      skills: [
        parseSkill('---\nname: mock-skill\ndescription: 合成技能\n---\nMOCK PRIVATE SKILL BODY'),
      ],
    },
  };
  try {
    await work.write(
      {
        id: 'mock-human-work',
        item: 'mock-open-card',
        action: 'create',
        revision: 0,
        value: {
          title: '合成真实待办',
          description: 'MOCK PRIVATE DETAIL',
          progress: '',
          status: 'todo',
        },
      },
      { kind: 'human' },
    );
    for (const bot of [run.bot, 'mock-beta'])
      await schedules.create({
        id: `${bot}-schedule`,
        bot,
        title: '合成暂停计划',
        prompt: 'MOCK PRIVATE SCHEDULE BODY',
        rule: { kind: 'every', everySeconds: 3600 },
        enabled: false,
      });
    const result = await tools.invoke(run, 'task_catalog');
    assert.equal(result.isError, undefined);
    const block = result.content[0];
    assert.equal(block.type, 'text');
    const catalog = JSON.parse(block.type === 'text' ? block.text : '');
    assert.equal(catalog.untrusted, true);
    assert.equal(catalog.work.page.items[0].id, 'mock-open-card');
    assert.deepEqual(
      catalog.schedules.items.map((row: { id: string }) => row.id),
      ['mock-alpha-schedule'],
    );
    assert.deepEqual(
      catalog.skills.items.map((row: { name: string }) => row.name),
      ['mock-skill'],
    );
    assert.deepEqual(
      catalog.tools.map((row: { name: string }) => row.name),
      tools.list(run.bot, run.model, run.conversationId, run).map((row) => row.name),
    );
    for (const secret of [
      'MOCK PRIVATE DETAIL',
      'MOCK PRIVATE SKILL BODY',
      'MOCK PRIVATE SCHEDULE BODY',
    ])
      assert.equal(JSON.stringify(catalog).includes(secret), false);
    assert.equal(
      catalog.tools.some((row: { name: string }) => row.name === 'screenshot'),
      false,
    );
    assert.equal(started, 0);
    assert.equal(run.toolCount, 1);
    assert.equal(run.trace[0].surface, 'catalog');
    assert.match(
      JSON.stringify(await tools.invoke(run, 'task_catalog', { bot: 'mock-beta' })),
      /INVALID_TOOL_ARGS/,
    );
  } finally {
    await schedules.close();
    await work.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog separately reports unavailable stores and honestly bounds tool metadata without inventing records', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-catalog-unavailable-'));
  const work = new Work(path.join(root, 'work.sqlite'));
  const tools = new CatalogTools({
    work,
    schedules: () => undefined,
    offered: () =>
      Array.from({ length: 130 }, (_, index) => ({
        name: `mock-tool-${index}`,
        description: '😀'.repeat(300),
      })),
  });
  const run: AgentToolRun = {
    id: 'mock-catalog-unavailable',
    bot: 'mock-alpha',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: root,
  };
  try {
    await work.close();
    const value = await tools.invoke(run, 'task_catalog', {});
    assert.equal(value.work.available, false);
    assert.equal(value.schedules.available, false);
    assert.equal(value.skills.available, false);
    assert.equal(value.tools.length, 128);
    assert.equal(value.toolsTotal, 130);
    assert.equal(value.toolsTruncated, true);
    assert.equal(Array.from(value.tools[0].description).length, 200);
    assert.equal(value.tools[0].descriptionTruncated, true);
    run.abort.abort();
    await assert.rejects(tools.invoke(run, 'task_catalog', {}));
  } finally {
    await work.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog redacts decoded values before shortening descriptions containing escaped credential characters', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-catalog-redaction-'));
  const work = new Work(path.join(root, 'work.sqlite'));
  const secret = `mock-"provider\\secret\n${'z'.repeat(50)}`;
  const prefix = 'x'.repeat(170);
  const tools = new CatalogTools({
    work,
    schedules: () => undefined,
    offered: () => [{ name: 'mock-tool', description: prefix + secret }],
  });
  const run: AgentToolRun = {
    id: 'mock-catalog-redaction',
    bot: 'mock-alpha',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: root,
    redact: (text) => text.replaceAll(secret, '[credential redacted]'),
  };
  try {
    const value = await tools.invoke(run, 'task_catalog', {});
    assert.equal(value.tools[0].description, `${prefix}[credential redacted]`);
    assert.equal(value.tools[0].descriptionTruncated, false);
  } finally {
    await work.close();
    await rm(root, { recursive: true, force: true });
  }
});
