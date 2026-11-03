import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Schedule } from '@daban/protocol';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { ScheduleTools, scheduleToolList } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import { WorkspaceFiles } from './workspace.js';

function value(result: ToolResult): Schedule {
  expect(result.isError, JSON.stringify(result)).toBe(undefined);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.type === 'text' ? block.text : '') as Schedule;
}
test('scoped model tools share the catalog, create idempotently, respect locks and keep budget metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-schedule-tools-'));
  const store = new Schedules({
    file: path.join(directory, 'schedules.sqlite'),
    runner: { running: () => false, findRequest: () => undefined, start: async () => ({}) },
    domain: Promise.resolve({
      create: (input) => ({ ...input, kind: 'every', scheduledAt: '2026-01-01T01:00:00Z' }),
      due: () => ({ occurrenceAt: '2026-01-01T01:00:00Z' }),
      decode: (input) => input,
    }),
  });
  try {
    const workdir = path.join(directory, 'workspace');
    await mkdir(workdir);
    const tools = new AgentTools(undefined, new WorkspaceFiles(workdir));
    tools.schedules = new ScheduleTools(store);
    const run: AgentToolRun = {
      id: 'mock-accepted-run',
      bot: 'mock-alpha',
      abort: new AbortController(),
      toolCount: 0,
      limit: 30,
      seen: {},
      trace: [],
      workdir,
      canonicalRoot: workdir,
    };
    expect.assert(
      scheduleToolList.every((item) => tools.list(run.bot).some((tool) => tool.name === item.name)),
    );
    expect(tools.list(run.bot).some((item) => item.name === 'schedule_create')).toBe(false);
    const args = {
      title: '合成模型日程',
      prompt: '只处理合成数据',
      rule: { kind: 'every', everySeconds: 3600 },
    };
    const first = value(await tools.invoke(run, 'bot_schedule_create', args));
    const duplicate = value(
      await tools.invoke(run, 'bot_schedule_create', {
        rule: args.rule,
        prompt: args.prompt,
        title: args.title,
      }),
    );
    expect(first.id).toBe(duplicate.id);
    expect(
      value(
        await tools.invoke(
          { ...run, id: 'mock-new-retry-run', intentId: run.id },
          'bot_schedule_create',
          args,
        ),
      ).id,
    ).toBe(first.id);
    expect(
      (await tools.invoke(run, 'bot_schedule_create', { ...args, enabled: null })).isError,
    ).toBe(true);
    const paused = value(
      await tools.invoke(run, 'bot_schedule_create', {
        ...args,
        title: '合成暂停计划',
        enabled: false,
      }),
    );
    expect(paused.enabled).toBe(false);
    await store.remove(paused.id, paused.revision);
    expect((await store.list()).length).toBe(1);
    expect(
      (await tools.invoke(run, 'bot_schedule_create', { ...args, bot: 'mock-beta' })).isError,
    ).toBe(true);
    const changed = value(
      await tools.invoke(run, 'bot_schedule_update', {
        id: first.id,
        revision: first.revision,
        patch: { title: '合成已修改' },
      }),
    );
    expect(changed.title).toBe('合成已修改');
    const locked = await store.update(first.id, changed.revision, { locked: true });
    expect(value(await tools.invoke(run, 'bot_schedule_list', { id: first.id })).locked).toBe(true);
    expect(
      JSON.stringify(
        await tools.invoke(run, 'bot_schedule_delete', { id: first.id, revision: locked.revision }),
      ),
    ).toMatch(/SCHEDULE_LOCKED/);
    expect(
      JSON.stringify(
        await tools.invoke({ ...run, bot: 'mock-beta' }, 'bot_schedule_list', { id: first.id }),
      ),
    ).toMatch(/SCHEDULE_NOT_FOUND/);
    const unlocked = await store.update(first.id, locked.revision, { locked: false });
    const result = await tools.invoke(run, 'bot_schedule_delete', {
      id: first.id,
      revision: unlocked.revision,
    });
    expect(result.isError).toBe(undefined);
    expect((await store.list()).length).toBe(0);
    expect.assert(run.trace.every((item) => item.surface === 'schedule'));
    expect(run.trace.some((item) => item.phase === 'running')).toBe(false);
    expect(JSON.stringify(run.trace).includes(args.prompt)).toBe(false);
    const limited = { ...run, toolCount: 0, limit: 1, trace: [], abort: new AbortController() };
    await tools.invoke(limited, 'bot_schedule_list');
    expect(JSON.stringify(await tools.invoke(limited, 'bot_schedule_create', args))).toMatch(
      /TOOL_LIMIT/,
    );
    expect((await store.list()).length).toBe(0);
    const stopped = { ...run, toolCount: 0, abort: new AbortController() };
    stopped.abort.abort();
    expect(JSON.stringify(await tools.invoke(stopped, 'bot_schedule_create', args))).toMatch(
      /MODEL_CANCELLED/,
    );
    await tools.drain(run);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
