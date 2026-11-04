import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type AutomationSource,
  type BudgetScope,
  defaultBudgetPolicy,
  type TaskRequest,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { GroupTools } from './group-tools.js';
import { type GroupRunner, Groups } from './groups.js';
import { inferenceFixture } from './inference.fixture.js';
import type { ModelRuns } from './model.js';
import { nativeSchedules } from './schedule-domain.js';
import { Schedules } from './schedules.js';

const source = {
  scheduleId: 'synthetic-budget-schedule',
  firingId: 'synthetic-budget-firing',
  configRevision: 1,
  trigger: 'manual' as const,
  policy: { kind: 'all' as const },
};
function start(models: ModelRuns, task: TaskRequest, origin = source) {
  return models.start('mock-bot', task, undefined, origin);
}

test('the trusted AutomationSource port coexists with a captured task budget', {
  timeout: 60000,
}, async () => {
  const fixture = await inferenceFixture(() => 'SYNTHETIC AUTOMATION RESULT');
  try {
    await fixture.models.ready;
    fixture.models.budgets.configure(
      0,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 1 },
      [],
      'synthetic-auto-budget-policy',
    );
    await start(fixture.models, {
      requestId: 'synthetic-auto-budget-task',
      prompt: 'SYNTHETIC AUTOMATION TASK',
    });
    const job = fixture.models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    expect(job.automation).toEqual(source);
    expect(fixture.models.budgets.view(job.budget!.budgetId).requests).toBe(1);
    expect((await fixture.models.journal.read('mock-bot', job.id))?.automation).toEqual(source);
  } finally {
    await fixture.close();
  }
});

test('automation provenance is part of request deduplication and never accepted from TaskRequest', {
  timeout: 60000,
}, async () => {
  const fixture = await inferenceFixture(() => 'SYNTHETIC AUTOMATION RESULT');
  const task = { requestId: 'synthetic-auto-dedup', prompt: 'SYNTHETIC AUTOMATION TASK' };
  try {
    await start(fixture.models, task);
    const job = fixture.models.jobs.get('mock-bot')!;
    await job.done;
    await expect(
      start(fixture.models, task, { ...source, firingId: 'synthetic-other-firing' }),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    await expect(
      fixture.models.start('mock-bot', {
        ...task,
        requestId: 'synthetic-injected-source',
        automation: source,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TASK' });
    expect(fixture.models.budgets.view(job.budget!.budgetId).requests).toBe(1);
  } finally {
    await fixture.close();
  }
});

test('a Human retry retains saved automation provenance and the original unknown budget occupancy', {
  timeout: 60000,
}, async () => {
  const fixture = await inferenceFixture(() => 'SYNTHETIC AUTOMATION RESULT');
  try {
    await start(fixture.models, {
      requestId: 'synthetic-auto-before-retry',
      prompt: 'SYNTHETIC AUTOMATION TASK',
    });
    const first = fixture.models.jobs.get('mock-bot')!;
    await first.done;
    await fixture.models.startHuman('mock-bot', {
      requestId: 'synthetic-auto-human-retry',
      retryOf: first.id,
      prompt: 'SYNTHETIC AUTOMATION TASK',
    });
    const next = fixture.models.jobs.get('mock-bot')!;
    await next.done;
    expect(next.automation).toEqual(source);
    expect(next.budget?.budgetId).toBe(first.budget!.budgetId);
    const view = fixture.models.budgets.view(first.budget!.budgetId);
    expect(view.requests).toBe(2);
    expect(view.unknownCount).toBe(2);
    await expect(
      start(
        fixture.models,
        {
          requestId: 'synthetic-auto-wrong-origin-retry',
          retryOf: next.id,
          prompt: 'SYNTHETIC AUTOMATION TASK',
        },
        { ...source, firingId: 'synthetic-new-firing' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AUTOMATION_SOURCE' });
    expect(fixture.models.budgets.view(first.budget!.budgetId).requests).toBe(2);
  } finally {
    await fixture.close();
  }
});

test('automation metadata and a quota increase cannot arm a Goal; the named Human path retains provenance', {
  timeout: 60000,
}, async () => {
  let sends = 0;
  const fixture = await inferenceFixture(() =>
    ++sends === 1
      ? [
          {
            name: 'create_goal',
            args: { objective: 'SYNTHETIC AUTOMATED GOAL', max_goal_rounds: 3 },
          },
        ]
      : 'SYNTHETIC GOAL PROGRESS',
  );
  try {
    await fixture.models.ready;
    fixture.models.budgets.configure(
      0,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
      [],
      'synthetic-auto-goal-policy',
    );
    await start(fixture.models, {
      requestId: 'synthetic-auto-goal-create',
      prompt: '/goal SYNTHETIC AUTOMATED GOAL',
      chatRevision: 0,
    });
    const first = fixture.models.jobs.get('mock-bot')!;
    await first.done;
    expect(sends).toBe(2);
    const owner = { bot: 'mock-bot', runId: first.id, chatRevision: 0 };
    const raised = fixture.models.budgets.increase(
      first.budget!.budgetId,
      1,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 12 },
      'synthetic-auto-goal-human-quota',
      () => true,
      owner,
    );
    expect(raised.state).toBe('stopped');
    expect(sends).toBe(2);
    const target = await fixture.models.goalTarget({ bot: 'mock-bot', chatRevision: 0 });
    const request = {
      requestId: 'synthetic-auto-illegal-goal-resume',
      prompt: '/goal resume',
      chatRevision: 0,
      goalResume: target,
    };
    await expect(start(fixture.models, request)).rejects.toMatchObject({
      code: 'GOAL_HUMAN_COMMAND_REQUIRED',
    });
    expect(sends).toBe(2);
    expect(fixture.models.budgets.view(raised.scope.budgetId).state).toBe('stopped');
    await fixture.models.startHuman(
      'mock-bot',
      { ...request, requestId: 'synthetic-auto-explicit-human-goal' },
      undefined,
      raised.scope,
      source,
    );
    const resumed = fixture.models.jobs.get('mock-bot')!;
    await resumed.done;
    expect(resumed.automation).toEqual(source);
    expect(resumed.goal?.id).toBe(first.goal!.id);
    expect(resumed.goal?.rounds).toBe(3);
    expect(resumed.budget).toEqual(raised.scope);
    expect(sends).toBeGreaterThan(2);
    expect(fixture.models.budgets.view(raised.scope.budgetId).unknownCount).toBe(sends);
  } finally {
    await fixture.close();
  }
});

test('a real firing and reopened group deliveries retain one budget, immutable prices and exact provenance without automatic continuation', {
  timeout: 60000,
}, async () => {
  let sends = 0;
  const fixture = await inferenceFixture((request) => {
    sends++;
    if (sends === 1) {
      const name = request.tools?.find((tool) => tool.function.name.endsWith('group_create'))
        ?.function.name;
      if (!name) throw new Error('SYNTHETIC_GROUP_TOOL_MISSING');
      return [
        {
          name,
          args: {
            name: 'Synthetic automation group',
            members: ['mock-beta', 'mock-gamma'],
            message: 'SYNTHETIC SHARED FIRING STAGE',
          },
        },
      ];
    }
    return 'SYNTHETIC AUTOMATION STAGE COMPLETE';
  });
  const models = fixture.models;
  const captures: {
    request: string;
    source?: string;
    budget?: BudgetScope;
    origin?: AutomationSource;
  }[] = [];
  const runner: GroupRunner = {
    member: (bot) => models.profiles.get(bot),
    source: (bot, run, group) => models.groupSource(bot, run, group),
    budget: (group, id) => models.groupBudget(group, id),
    running: (bot) => models.running(bot),
    findRequest: (bot, id) => models.findRequest(bot, id),
    start: async (bot, task, context, origin) => {
      captures.push({
        request: task.requestId,
        source: context.sourceId,
        budget: context.budget && structuredClone(context.budget),
        origin: origin && structuredClone(origin),
      });
      return models.start(bot, task, context, origin);
    },
    stopRequest: (bot, id, group) => models.stopRequest(bot, id, group),
  };
  const openGroups = () => new Groups(path.join(fixture.root, 'groups.sqlite'), runner);
  let groups = openGroups();
  const schedules = new Schedules({
    file: path.join(fixture.root, 'schedules.sqlite'),
    domain: nativeSchedules(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')),
    runner: {
      running: (bot) => models.running(bot),
      admit: (bot) => models.admit(bot),
      findRequest: (bot, id) => models.findRequest(bot, id),
      start: (bot, task, _conversation, origin) =>
        models.start(bot, { ...task, chatRevision: 0 }, undefined, origin),
    },
  });
  try {
    await models.ready;
    await schedules.ready;
    await groups.ready;
    for (const id of ['mock-bot', 'mock-beta', 'mock-gamma'])
      await models.profiles.register({
        id,
        name: id,
        instructions: 'SYNTHETIC',
        memory: '',
        color: 'mint',
      });
    models.tools.groups = new GroupTools(groups);
    const route = await models.settings.capture();
    const price = {
      id: 'synthetic-price-before',
      routeKey: JSON.stringify([
        route.primary.provider,
        route.primary.api,
        route.primary.apiModel,
        route.revision,
      ]),
      currency: 'CNY',
      createdAt: '2026-01-01T00:00:00Z',
      input: 1000000,
      output: 2000000,
      cacheRead: 500000,
      cacheWrite: 1000000,
    };
    models.budgets.configure(
      0,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 4 },
      [price],
      'synthetic-firing-policy',
    );
    await schedules.create({
      id: 'synthetic-real-firing-rule',
      bot: 'mock-bot',
      title: 'Synthetic shared firing',
      prompt: 'SYNTHETIC AUTOMATION ROOT',
      rule: { kind: 'every', everySeconds: 60 },
      enabled: false,
    });
    const firing = await schedules.run('synthetic-real-firing-rule', 'synthetic-human-fire');
    await schedules.tick();
    const root = models.jobs.get('mock-bot')!;
    await root.done;
    expect(root.phase, root.error).toBe('completed');
    const origin = root.automation!;
    expect(origin).toMatchObject({
      firingId: firing.id,
      scheduleId: 'synthetic-real-firing-rule',
      trigger: 'manual',
    });
    expect(sends).toBe(2);
    const original = models.budgets.view(root.budget!.budgetId);
    expect(original.rootId).not.toBe(firing.id);
    models.budgets.configure(
      1,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 100 },
      [{ ...price, id: 'synthetic-price-after', input: 9000000 }],
      'synthetic-new-defaults',
    );
    await groups.close();
    groups = openGroups();
    await groups.ready;
    models.tools.groups = new GroupTools(groups);
    for (const bot of ['mock-beta', 'mock-gamma', 'mock-bot']) {
      await groups.tick();
      await models.jobs.get(bot)!.done;
    }
    await groups.tick();
    expect(captures).toHaveLength(3);
    expect(new Set(captures.map((capture) => capture.request)).size).toBe(3);
    expect(new Set(captures.map((capture) => capture.source)).size).toBe(1);
    expect(captures[0].source).toEqual(expect.any(String));
    expect(captures[0].source).not.toBe(firing.id);
    for (const capture of captures) {
      expect(capture.budget).toEqual(root.budget);
      expect(capture.origin).toEqual(origin);
    }
    const held = models.budgets.view(root.budget!.budgetId);
    expect(held.rootId).toBe(original.rootId);
    expect(held.requests).toBe(4);
    expect(held.unknownCount).toBe(4);
    expect(held.policy.maxRequests).toBe(4);
    expect(held.receipts).toHaveLength(4);
    expect(held.receipts.every((receipt) => receipt.price?.id === price.id)).toBe(true);
    expect(sends).toBe(4);
    await schedules.run('synthetic-real-firing-rule', 'synthetic-human-fire');
    await schedules.tick();
    await groups.tick();
    expect(sends).toBe(4);
    expect(captures).toHaveLength(3);
    expect(models.budgets.view(root.budget!.budgetId).state).toBe('limit-reached');
    const nextFiring = await schedules.run(
      'synthetic-real-firing-rule',
      'synthetic-human-fire-again',
    );
    await schedules.tick();
    const next = models.jobs.get('mock-bot')!;
    await next.done;
    expect(nextFiring.id).not.toBe(firing.id);
    expect(next.automation?.firingId).toBe(nextFiring.id);
    expect(next.budget?.budgetId).not.toBe(root.budget!.budgetId);
    expect(models.budgets.view(next.budget!.budgetId).receipts[0].price?.id).toBe(
      'synthetic-price-after',
    );
    expect(models.budgets.view(root.budget!.budgetId).requests).toBe(4);
  } finally {
    await schedules.close();
    await groups.close();
    await fixture.close();
  }
});
