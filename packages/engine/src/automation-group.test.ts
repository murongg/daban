import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AutomationSource, TaskRequest } from '@daban/protocol';
import { expect, test } from 'vitest';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { inferenceFixture } from './inference.fixture.js';
import { ScheduleTools } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import type { RunProvenance } from './tasks.js';

const source: AutomationSource = {
  scheduleId: 'mock-schedule',
  firingId: 'mock-firing',
  configRevision: 1,
  trigger: 'time',
  policy: { kind: 'changes', signalPath: 'mock.txt' },
};

test('triggered tasks cannot promote file instructions into schedule mutation authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-tools-'));
  const schedules = new Schedules({
    file: path.join(root, 'schedules.sqlite'),
    runner: { running: () => false, findRequest: () => undefined, start: async () => ({}) },
    domain: Promise.resolve({
      create: (input) => ({ ...input, kind: 'every', scheduledAt: '2026-01-01T00:00:00Z' }),
      decode: (value) => value,
      due: (value) => ({ occurrenceAt: value.scheduledAt }),
    }),
  });
  try {
    const tools = new ScheduleTools(schedules);
    const run = {
      id: 'mock-run',
      bot: 'mock-alpha',
      automation: source,
      abort: new AbortController(),
      workdir: root,
      canonicalRoot: root,
      toolCount: 0,
      limit: 30,
      seen: {},
      trace: [],
    };
    const result = await tools.invoke(run, 'bot_schedule_create', {
      title: 'Injected synthetic rule',
      prompt: 'Synthetic external instruction',
      rule: { kind: 'every', everySeconds: 60 },
    });
    expect(result.isError).toBe(true);
    expect(await schedules.list()).toHaveLength(0);
    expect((await tools.invoke(run, 'bot_schedule_list', {})).isError).toBeUndefined();
  } finally {
    await schedules.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('group collaborators inherit trusted trigger origin across restart and do not leak ordinary completion notices', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-group-'));
  const calls: unknown[] = [];
  const receipts = new Map<
    string,
    { runId: string; phase: string; conversationId: string; result: string }
  >();
  const runner = {
    member: async (id: string) =>
      ['mock-alpha', 'mock-beta'].includes(id) ? { id, name: id } : undefined,
    directory: async () => [
      { id: 'mock-alpha', name: 'Alpha' },
      { id: 'mock-beta', name: 'Beta' },
    ],
    source: () => ({ intentId: 'mock-intent', automation: source }),
    running: () => false,
    findRequest: (_bot: string, id: string) => receipts.get(id),
    start: async (
      _bot: string,
      task: TaskRequest,
      scope: { id: string; context: string },
      origin?: RunProvenance,
    ) => {
      calls.push(origin?.automation);
      receipts.set(task.requestId, {
        runId: `mock-run-${calls.length}`,
        phase: 'completed',
        conversationId: scope.id,
        result: 'SYNTHETIC RESULT',
      });
    },
    stopRequest: async () => {},
  };
  let groups = new Groups(path.join(root, 'groups.sqlite'), runner);
  try {
    await groups.ready;
    const created = await groups.collaborate(
      { bot: 'mock-alpha', runId: 'mock-run' },
      { name: 'Synthetic group', members: ['mock-beta'], message: 'SYNTHETIC SHARED TASK' },
    );
    await groups.close();
    groups = new Groups(path.join(root, 'groups.sqlite'), runner);
    await groups.ready;
    await groups.tick();
    await groups.tick();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((value) => JSON.stringify(value) === JSON.stringify(source))).toBe(true);
    expect(await groups.notices()).toHaveLength(0);
    await groups.send({
      id: 'mock-human-turn',
      group: created.group.id,
      revision: created.group.revision,
      prompt: 'Synthetic independent human message',
      recipients: ['mock-beta'],
    });
    await groups.tick();
    await groups.tick();
    expect(calls.at(-1)).toBeUndefined();
    expect((await groups.notices()).some((notice) => notice.id === 'mock-human-turn')).toBe(true);
  } finally {
    await groups.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a scheduled firing shares its default SDK tool allowance with a named member and gives Human turns a new budget', {
  timeout: 60000,
}, async () => {
  let rootReplies = 0;
  let memberReplies = 0;
  const fixture = await inferenceFixture((request) => {
    const prompt = JSON.stringify(request.messages);
    if (prompt.includes('SYNTHETIC HUMAN TOOL ALLOWANCE')) return 'SYNTHETIC HUMAN COMPLETE';
    const member = !prompt.includes('SYNTHETIC ROOT TOOL ALLOWANCE');
    if ((member ? memberReplies++ : rootReplies++) > 0) return 'SYNTHETIC COMPLETE';
    const write = request.tools?.find((tool) => tool.function.name.endsWith('write_file'))?.function
      .name;
    if (!write) throw new Error('SYNTHETIC_WRITE_TOOL_MISSING');
    const files = Array.from({ length: 40 }, (_, index) => ({
      name: write,
      args: { path: `mock-effect-${index}.txt`, content: 'SYNTHETIC ONLY' },
    }));
    if (member) return files;
    const group = request.tools?.find((tool) => tool.function.name.endsWith('group_create'))
      ?.function.name;
    if (!group) throw new Error('SYNTHETIC_GROUP_TOOL_MISSING');
    return [
      ...files,
      {
        name: group,
        args: {
          name: 'Synthetic allowance group',
          members: ['mock-beta'],
          message: 'SYNTHETIC MEMBER TOOL ALLOWANCE',
        },
      },
    ];
  });
  const models = fixture.models;
  const groups = new Groups(path.join(fixture.root, 'groups.sqlite'), {
    member: (bot) => models.profiles.get(bot),
    directory: () => models.profiles.list(),
    source: (bot, run, group) => models.groupSource(bot, run, group),
    budget: (group, source) => models.groupBudget(group, source),
    running: (bot) => models.running(bot),
    groupRunning: (group) => models.groupRunning(group),
    admit: (bot) => models.admit(bot),
    findRequest: (bot, request) => models.findRequest(bot, request),
    start: (bot, task, scope, provenance) => models.start(bot, task, scope, provenance),
    stopRequest: (bot, request, group) => models.stopRequest(bot, request, group),
  });
  const schedules = new Schedules({
    file: path.join(fixture.root, 'schedules.sqlite'),
    domain: Promise.resolve({
      create: (input) => ({ ...input, kind: 'every', scheduledAt: '2026-01-01T00:00:00Z' }),
      decode: (value) => value,
      due: (value) => ({ occurrenceAt: value.scheduledAt }),
    }),
    runner: {
      running: (bot) => models.running(bot),
      admit: (bot) => models.admit(bot),
      findRequest: (bot, request) => models.findRequest(bot, request),
      start: (bot, task, _scope, automation) => models.start(bot, task, undefined, { automation }),
    },
  });
  try {
    await models.ready;
    await groups.ready;
    await schedules.ready;
    for (const id of ['mock-bot', 'mock-beta'])
      await models.profiles.register({ id, name: id, instructions: '', memory: '', color: 'mint' });
    models.tools.groups = new GroupTools(groups);
    const item = await schedules.create({
      id: 'mock-rule',
      bot: 'mock-bot',
      title: 'Synthetic trigger',
      prompt: 'SYNTHETIC ROOT TOOL ALLOWANCE',
      enabled: false,
      rule: { kind: 'every', everySeconds: 60 },
    });
    const firing = await schedules.run(item.id, 'mock-firing-request');
    await schedules.tick();
    const parent = models.jobs.get('mock-bot')!;
    await parent.done;
    expect(parent.phase, parent.error).toBe('completed');
    const group = (await groups.status()).items[0];
    expect(group).toBeDefined();
    await groups.tick();
    const member = models.jobs.get('mock-beta')!;
    await member.done;
    expect(member.automation?.firingId).toBe(firing.id);
    expect(parent.automation?.firingId).toBe(firing.id);
    const parentFiles = (await readdir(parent.workdir)).filter((name) =>
      name.startsWith('mock-effect-'),
    );
    const memberFiles = (await readdir(member.workdir)).filter((name) =>
      name.startsWith('mock-effect-'),
    );
    // Exercise the SDK pre-execute budget claim; a direct MCP call bypasses that trusted metering hook.
    expect(parentFiles.length + memberFiles.length + 1).toBe(60);
    expect(memberFiles.length).toBe(19);
    expect(member.budget).toEqual(parent.budget);
    expect(models.budgets.tools(parent.budget!.budgetId)).toBe(60);
    // Drain the original summary before measuring the independent Human turn.
    await groups.tick();
    await models.jobs.get('mock-bot')!.done;
    await groups.tick();
    const original = models.budgets.view(parent.budget!.budgetId);
    await groups.send({
      id: 'mock-independent-human',
      group: group.id,
      revision: group.revision,
      prompt: 'SYNTHETIC HUMAN TOOL ALLOWANCE',
      recipients: ['mock-beta'],
    });
    await groups.tick();
    const human = models.jobs.get('mock-beta')!;
    await human.done;
    expect(human.id).not.toBe(member.id);
    expect(human.phase, human.error).toBe('completed');
    expect(human.automation).toBeUndefined();
    expect(human.budget?.budgetId).not.toBe(parent.budget!.budgetId);
    expect(models.budgets.tools(parent.budget!.budgetId)).toBe(60);
    expect(models.budgets.view(parent.budget!.budgetId).requests).toBe(original.requests);
    expect(original.unknownCount).toBeGreaterThan(0);
  } finally {
    await groups.close();
    await schedules.close();
    await fixture.close();
  }
});
