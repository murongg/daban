import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Schedule } from '@daban/protocol';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { ScheduleTools, scheduleToolList } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import { WorkspaceFiles } from './workspace.js';

function value(result: ToolResult): Schedule {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const block = result.content[0];
  assert.equal(block.type, 'text');
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
    assert.ok(
      scheduleToolList.every((item) => tools.list(run.bot).some((tool) => tool.name === item.name)),
    );
    assert.equal(
      tools.list(run.bot).some((item) => item.name === 'schedule_create'),
      false,
    );
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
    assert.equal(first.id, duplicate.id);
    assert.equal(
      value(
        await tools.invoke(
          { ...run, id: 'mock-new-retry-run', intentId: run.id },
          'bot_schedule_create',
          args,
        ),
      ).id,
      first.id,
    );
    assert.equal(
      (await tools.invoke(run, 'bot_schedule_create', { ...args, enabled: null })).isError,
      true,
    );
    const paused = value(
      await tools.invoke(run, 'bot_schedule_create', {
        ...args,
        title: '合成暂停计划',
        enabled: false,
      }),
    );
    assert.equal(paused.enabled, false);
    await store.remove(paused.id, paused.revision);
    assert.equal((await store.list()).length, 1);
    assert.equal(
      (await tools.invoke(run, 'bot_schedule_create', { ...args, bot: 'mock-beta' })).isError,
      true,
    );
    const changed = value(
      await tools.invoke(run, 'bot_schedule_update', {
        id: first.id,
        revision: first.revision,
        patch: { title: '合成已修改' },
      }),
    );
    assert.equal(changed.title, '合成已修改');
    const locked = await store.update(first.id, changed.revision, { locked: true });
    assert.equal(
      value(await tools.invoke(run, 'bot_schedule_list', { id: first.id })).locked,
      true,
    );
    assert.match(
      JSON.stringify(
        await tools.invoke(run, 'bot_schedule_delete', { id: first.id, revision: locked.revision }),
      ),
      /SCHEDULE_LOCKED/,
    );
    assert.match(
      JSON.stringify(
        await tools.invoke({ ...run, bot: 'mock-beta' }, 'bot_schedule_list', { id: first.id }),
      ),
      /SCHEDULE_NOT_FOUND/,
    );
    const unlocked = await store.update(first.id, locked.revision, { locked: false });
    const result = await tools.invoke(run, 'bot_schedule_delete', {
      id: first.id,
      revision: unlocked.revision,
    });
    assert.equal(result.isError, undefined);
    assert.equal((await store.list()).length, 0);
    assert.ok(run.trace.every((item) => item.surface === 'schedule'));
    assert.equal(
      run.trace.some((item) => item.phase === 'running'),
      false,
    );
    assert.equal(JSON.stringify(run.trace).includes(args.prompt), false);
    const limited = { ...run, toolCount: 0, limit: 1, trace: [], abort: new AbortController() };
    await tools.invoke(limited, 'bot_schedule_list');
    assert.match(
      JSON.stringify(await tools.invoke(limited, 'bot_schedule_create', args)),
      /TOOL_LIMIT/,
    );
    assert.equal((await store.list()).length, 0);
    const stopped = { ...run, toolCount: 0, abort: new AbortController() };
    stopped.abort.abort();
    assert.match(
      JSON.stringify(await tools.invoke(stopped, 'bot_schedule_create', args)),
      /MODEL_CANCELLED/,
    );
    await tools.drain(run);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
