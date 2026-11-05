import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AutomationSource, TaskRequest } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Groups } from './groups.js';
import { ScheduleTools } from './schedule-tools.js';
import { Schedules } from './schedules.js';

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
      origin?: AutomationSource,
    ) => {
      calls.push(origin);
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
