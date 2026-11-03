import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
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
    expect(result.isError).toBe(undefined);
    const block = result.content[0];
    expect(block.type).toBe('text');
    const catalog = JSON.parse(block.type === 'text' ? block.text : '');
    expect(catalog.untrusted).toBe(true);
    expect(catalog.work.page.items[0].id).toBe('mock-open-card');
    expect(catalog.schedules.items.map((row: { id: string }) => row.id)).toStrictEqual([
      'mock-alpha-schedule',
    ]);
    expect(catalog.skills.items.map((row: { name: string }) => row.name)).toStrictEqual([
      'mock-skill',
    ]);
    expect(catalog.tools.map((row: { name: string }) => row.name)).toStrictEqual(
      tools.list(run.bot, run.model, run.conversationId, run).map((row) => row.name),
    );
    for (const secret of [
      'MOCK PRIVATE DETAIL',
      'MOCK PRIVATE SKILL BODY',
      'MOCK PRIVATE SCHEDULE BODY',
    ])
      expect(JSON.stringify(catalog).includes(secret)).toBe(false);
    expect(catalog.tools.some((row: { name: string }) => row.name === 'screenshot')).toBe(false);
    expect(started).toBe(0);
    expect(run.toolCount).toBe(1);
    expect(run.trace[0].surface).toBe('catalog');
    expect(JSON.stringify(await tools.invoke(run, 'task_catalog', { bot: 'mock-beta' }))).toMatch(
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
    expect(value.work.available).toBe(false);
    expect(value.schedules.available).toBe(false);
    expect(value.skills.available).toBe(false);
    expect(value.tools.length).toBe(128);
    expect(value.toolsTotal).toBe(130);
    expect(value.toolsTruncated).toBe(true);
    expect(Array.from(value.tools[0].description).length).toBe(200);
    expect(value.tools[0].descriptionTruncated).toBe(true);
    run.abort.abort();
    await expect(tools.invoke(run, 'task_catalog', {})).rejects.toThrowError();
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
    expect(value.tools[0].description).toBe(`${prefix}[credential redacted]`);
    expect(value.tools[0].descriptionTruncated).toBe(false);
  } finally {
    await work.close();
    await rm(root, { recursive: true, force: true });
  }
});
