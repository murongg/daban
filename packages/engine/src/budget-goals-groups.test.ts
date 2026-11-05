import path from 'node:path';
import { defaultBudgetPolicy } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Groups } from './groups.js';
import { inferenceFixture, type SyntheticRequest } from './inference.fixture.js';

function goalIn(request: SyntheticRequest) {
  for (const value of [...request.messages].reverse()) {
    const message = value as { role?: string; content?: unknown };
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const data = JSON.parse(message.content) as {
        goal?: { id: string; revision: number; phase: string };
      };
      if (data.goal) return data.goal;
    } catch {
      /* Synthetic non-goal tool response. */
    }
  }
  return undefined;
}
test('SDK named-group Human continuation keeps the Goal and budget and never replays the failed stage', {
  timeout: 60000,
}, async () => {
  let sends = 0,
    finish = false,
    refreshed = false;
  const fixture = await inferenceFixture((request) => {
    sends++;
    if (finish && !refreshed) {
      refreshed = true;
      return [{ name: 'get_goal', args: {} }];
    }
    const goal = goalIn(request);
    if (!goal)
      return [
        { name: 'create_goal', args: { objective: 'SYNTHETIC GROUP GOAL', max_goal_rounds: 3 } },
      ];
    if (goal.phase === 'complete') return 'SYNTHETIC GROUP COMPLETE';
    return finish
      ? [
          {
            name: 'update_goal',
            args: { goal_id: goal.id, revision: goal.revision, action: 'complete' },
          },
        ]
      : 'SYNTHETIC GROUP PROGRESS';
  });
  const models = fixture.models;
  const issue = models.budgetResumeIssue.bind(models);
  const groups = new Groups(path.join(fixture.root, 'synthetic-groups.sqlite'), {
    member: (bot) => models.profiles.get(bot),
    source: (bot, run, group) => models.groupSource(bot, run, group),
    budget: (group, source) => models.groupBudget(group, source),
    running: (bot) => models.running(bot),
    findRequest: (bot, id) => models.findRequest(bot, id),
    budgetResumeIssue: (bot, run, goal) => issue(bot, run, goal),
    start: (bot, task, scope) =>
      task.goalResume ? models.startHuman(bot, task, scope) : models.start(bot, task, scope),
    stopRequest: (bot, id, group) => models.stopRequest(bot, id, group),
  });
  try {
    await models.ready;
    models.budgets.configure(
      0,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
      [],
      'synthetic-group-policy',
    );
    for (const id of ['mock-bot', 'mock-peer'])
      await models.profiles.register({
        id,
        name: id,
        instructions: 'SYNTHETIC',
        memory: '',
        color: 'mint',
      });
    await groups.register({
      id: 'mock-goal-group',
      name: 'Synthetic group',
      members: ['mock-bot', 'mock-peer'],
    });
    await groups.send({
      id: 'synthetic-group-send',
      group: 'mock-goal-group',
      prompt: '/goal SYNTHETIC GROUP GOAL',
      recipients: ['mock-bot'],
    });
    await groups.tick();
    const first = models.jobs.get('mock-bot')!;
    await first.done;
    await groups.tick();
    expect(sends).toBe(2);
    const target = await models.goalTarget({ bot: 'mock-bot', conversationId: 'mock-goal-group' });
    expect(issue('mock-bot', first.id)).toBe('GOAL_TARGET_REQUIRED');
    expect(
      issue('mock-bot', first.id, {
        ...target,
        owner: { bot: 'mock-peer', conversationId: 'mock-goal-group' },
      }),
    ).toBe('GOAL_TARGET_CHANGED');
    const raised = models.budgets.increase(
      first.budget!.budgetId,
      1,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 12 },
      'synthetic-group-raise',
    );
    expect(sends).toBe(2);
    const goalResume = { ...target, budget: raised.scope };
    await expect(
      groups.resumeBudget(raised.scope, 'synthetic-wrong-group', {
        ...goalResume,
        goalId: 'foreign-goal',
      }),
    ).rejects.toThrow('GOAL_TARGET_CHANGED');
    finish = true;
    await groups.resumeBudget(raised.scope, 'synthetic-group-continue', goalResume);
    await groups.tick();
    const resumed = models.jobs.get('mock-bot')!;
    await resumed.done;
    await groups.tick();
    expect(resumed.id).not.toBe(first.id);
    expect(resumed.goal?.id).toBe(first.goal?.id);
    expect(resumed.phase, JSON.stringify({ error: resumed.error, goal: resumed.goal, sends })).toBe(
      'completed',
    );
    expect(resumed.goal?.phase).toBe('complete');
    expect(resumed.budget).toEqual(raised.scope);
    const count = sends;
    await groups.resumeBudget(raised.scope, 'synthetic-group-continue', goalResume);
    await groups.tick();
    expect(sends).toBe(count);
    const page = await groups.read('mock-goal-group');
    expect(page.deliveries.filter((row) => row.state === 'failed')).toHaveLength(1);
    expect(page.deliveries.filter((row) => row.state === 'completed')).toHaveLength(1);
  } finally {
    await groups.close();
    await fixture.close();
  }
});
