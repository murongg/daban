import { expect, test } from 'vitest';
import { inferenceFixture, type SyntheticRequest } from './inference.fixture.js';

function observedGoal(request: SyntheticRequest) {
  for (const value of [...request.messages].reverse()) {
    const message = value as { role?: string; content?: unknown };
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const data = JSON.parse(message.content) as {
        goal?: { id: string; revision: number; phase: string; activation?: string };
      };
      if (data.goal) return data.goal;
    } catch {
      /* Other synthetic tools need not return goal data. */
    }
  }
}
test.each([true, false])(
  'owned native goal rounds finish or stop at the bound (complete=%s)',
  { timeout: 60000 },
  async (complete) => {
    const rounds = new Set<number>();
    const fixture = await inferenceFixture((request) => {
      const body = JSON.stringify(request.messages);
      if (body.includes('SYNTHETIC FRESH')) return 'SYNTHETIC FRESH REPLY';
      if (body.includes('SYNTHETIC EMPTY TURN')) return '';
      const goal = observedGoal(request);
      if (!goal)
        return [
          { name: 'create_goal', args: { objective: 'SYNTHETIC OBJECTIVE', max_goal_rounds: 3 } },
        ];
      if (goal.phase === 'complete') return 'SYNTHETIC GOAL MARKED COMPLETE';
      const matches = [...JSON.stringify(request.messages).matchAll(/Round: (\d+)\/3/g)];
      const round = Number(matches.at(-1)?.[1] ?? 0);
      if (round) rounds.add(round);
      if (complete && round >= 2)
        return [
          {
            name: 'update_goal',
            args: { goal_id: goal.id, revision: goal.revision, action: 'complete' },
          },
        ];
      return `SYNTHETIC PROGRESS ${round}`;
    });
    try {
      await fixture.models.start('mock-bot', {
        requestId: 'mock-goal-create',
        prompt: '/goal SYNTHETIC OBJECTIVE',
      });
      const job = fixture.models.jobs.get('mock-bot')!;
      await job.done;
      expect([...rounds]).toStrictEqual(complete ? [1, 2] : [1, 2, 3]);
      expect(job).toMatchObject({
        phase: complete ? 'completed' : 'failed',
        goal: { phase: complete ? 'complete' : 'blocked', rounds: complete ? 2 : 3, limit: 3 },
      });
      if (!complete) expect(job.error).toBe('GOAL_ROUND_LIMIT');
      if (complete) {
        await fixture.models.start('mock-bot', {
          requestId: 'mock-goal-empty',
          prompt: 'SYNTHETIC EMPTY TURN',
        });
        await fixture.models.jobs.get('mock-bot')!.done;
        await fixture.models.start('mock-bot', {
          requestId: 'mock-goal-fresh',
          prompt: 'SYNTHETIC FRESH',
        });
        const fresh = fixture.models.jobs.get('mock-bot')!;
        await fresh.done;
        expect(fresh.sessionId).not.toBe(job.sessionId);
      }
    } finally {
      await fixture.close();
    }
  },
);

test('stopped goals remain inspectable after restart without autonomous replay and can be explicitly cleared', {
  timeout: 60000,
}, async () => {
  let entered = false,
    greets = 0,
    statusCalls = 0,
    clearCalls = 0,
    clearedState = false;
  const fixture = await inferenceFixture((request, signal) => {
    const text = JSON.stringify(request.messages);
    if (text.includes('/goal clear')) {
      if (++clearCalls === 1) return [{ name: 'get_goal', args: {} }];
      const last = [...request.messages]
        .reverse()
        .find((item) => (item as { role?: string }).role === 'tool') as { content: string };
      clearedState = JSON.parse(last.content).goal === null;
      return 'SYNTHETIC GOAL CLEARED';
    }
    if (text.includes('/goal status')) {
      if (++statusCalls === 1) return [{ name: 'get_goal', args: {} }];
      return 'SYNTHETIC GOAL STATUS';
    }
    if (text.includes('SYNTHETIC GREETING')) {
      greets++;
      return 'SYNTHETIC GREETING REPLY';
    }
    if (!observedGoal(request))
      return [
        {
          name: 'create_goal',
          args: { objective: 'SYNTHETIC STOP OBJECTIVE', max_goal_rounds: 3 },
        },
      ];
    if (text.includes('<goal_round>')) {
      entered = true;
      return new Promise<string>((resolve) =>
        signal.addEventListener('abort', () => resolve('SYNTHETIC CANCELLED'), { once: true }),
      );
    }
    return 'SYNTHETIC INITIAL PROGRESS';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-goal-stop',
      prompt: '/goal SYNTHETIC STOP OBJECTIVE',
    });
    await expect.poll(() => entered, { timeout: 15000 }).toBe(true);
    await fixture.models.stop('mock-bot');
    await fixture.restart();
    await fixture.models.start('mock-bot', {
      requestId: 'mock-goal-greeting',
      prompt: 'SYNTHETIC GREETING',
    });
    await fixture.models.jobs.get('mock-bot')!.done;
    expect(greets).toBe(1);
    await fixture.models.start('mock-bot', {
      requestId: 'mock-goal-status',
      prompt: '/goal status',
    });
    const status = fixture.models.jobs.get('mock-bot')!;
    await status.done;
    expect(status).toMatchObject({
      goal: { objective: 'SYNTHETIC STOP OBJECTIVE', activation: 'disarmed' },
    });
    await fixture.models.start('mock-bot', { requestId: 'mock-goal-clear', prompt: '/goal clear' });
    const cleared = fixture.models.jobs.get('mock-bot')!;
    await cleared.done;
    expect(Reflect.get(cleared, 'goal')).toBeUndefined();
    expect(clearedState).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('a fresh human command can pause and resume a goal while an ordinary retry cannot rearm it', {
  timeout: 60000,
}, async () => {
  let stage: 'create' | 'pause' | 'retry' | 'resume' = 'create';
  let pauseCalls = 0,
    resumeCalls = 0,
    paused = false;
  const fixture = await inferenceFixture((request) => {
    const goal = observedGoal(request);
    if (stage === 'create')
      return goal
        ? [
            {
              name: 'ask_user_question',
              args: { questions: [{ id: 'mock-input', question: 'Synthetic missing input?' }] },
            },
          ]
        : [
            {
              name: 'create_goal',
              args: { objective: 'SYNTHETIC RESUME OBJECTIVE', max_goal_rounds: 3 },
            },
          ];
    if (stage === 'pause') {
      if (++pauseCalls === 1) return [{ name: 'get_goal', args: {} }];
      paused = goal?.phase === 'paused';
      return 'SYNTHETIC GOAL PAUSED';
    }
    if (stage === 'retry') return 'SYNTHETIC READ ONLY RETRY';
    if (++resumeCalls === 1) return [{ name: 'get_goal', args: {} }];
    if (goal?.phase === 'complete') return 'SYNTHETIC GOAL RESUMED AND MARKED COMPLETE';
    if (JSON.stringify(request.messages).includes('Round: 1/3') && goal)
      return [
        {
          name: 'update_goal',
          args: { goal_id: goal.id, revision: goal.revision, action: 'complete' },
        },
      ];
    return 'SYNTHETIC RESUME PROGRESS';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-resume-create',
      prompt: '/goal SYNTHETIC RESUME OBJECTIVE',
    });
    await expect
      .poll(
        async () =>
          (await fixture.models.interactions.list()).some((item) => item.status === 'pending'),
        { timeout: 15000 },
      )
      .toBe(true);
    const original = fixture.models.jobs.get('mock-bot')!.id;
    await fixture.models.stop('mock-bot');
    stage = 'pause';
    await fixture.models.start('mock-bot', {
      requestId: 'mock-resume-pause',
      prompt: '/goal pause',
    });
    await fixture.models.jobs.get('mock-bot')!.done;
    const pausedJob = fixture.models.jobs.get('mock-bot')!;
    expect(pausedJob.phase, pausedJob.error).toBe('completed');
    expect(paused).toBe(true);
    stage = 'retry';
    await fixture.models.start('mock-bot', {
      requestId: 'mock-resume-retry',
      prompt: 'Synthetic retry',
      retryOf: original,
    });
    await fixture.models.jobs.get('mock-bot')!.done;
    expect(fixture.models.jobs.get('mock-bot')).toMatchObject({
      goal: { phase: 'paused', activation: 'disarmed' },
    });
    stage = 'resume';
    await fixture.models.startHuman('mock-bot', {
      requestId: 'mock-resume-explicit',
      prompt: '/goal resume',
      chatRevision: 0,
      goalResume: await fixture.models.goalTarget({ bot: 'mock-bot', chatRevision: 0 }),
    });
    const resumed = fixture.models.jobs.get('mock-bot')!;
    await resumed.done;
    expect(resumed.phase, resumed.error).toBe('completed');
    expect(resumed).toMatchObject({ goal: { phase: 'complete', rounds: 1 } });
  } finally {
    await fixture.close();
  }
});

test('explicit budget continuation resumes the same native Goal through its existing owner without resetting rounds', {
  timeout: 60000,
}, async () => {
  const { defaultBudgetPolicy } = await import('@daban/protocol');
  let resuming = false;
  let refreshed = false;
  const fixture = await inferenceFixture((request) => {
    if (resuming && !refreshed) {
      refreshed = true;
      return [{ name: 'get_goal', args: {} }];
    }
    const goal = observedGoal(request);
    if (!goal)
      return [
        { name: 'create_goal', args: { objective: 'SYNTHETIC BUDGET GOAL', max_goal_rounds: 3 } },
      ];
    if (goal.phase === 'complete') return 'SYNTHETIC GOAL COMPLETE';
    const round = Number(
      [...JSON.stringify(request.messages).matchAll(/Round: (\d+)\/3/g)].at(-1)?.[1] ?? 0,
    );
    if (resuming && round >= 2)
      return [
        {
          name: 'update_goal',
          args: { goal_id: goal.id, revision: goal.revision, action: 'complete' },
        },
      ];
    return 'SYNTHETIC GOAL PROGRESS';
  });
  try {
    await fixture.models.ready;
    fixture.models.budgets.configure(
      0,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
      [],
      'synthetic-goal-budget',
    );
    await fixture.models.start('mock-bot', {
      requestId: 'synthetic-goal-first',
      prompt: '/goal SYNTHETIC BUDGET GOAL',
    });
    const first = fixture.models.jobs.get('mock-bot')!;
    await first.done;
    expect(first.goal?.id).toBeDefined();
    expect(fixture.models.budgets.view(first.budget!.budgetId).state).toBe('limit-reached');
    const owner = { bot: 'mock-bot', runId: first.id, chatRevision: 0 };
    const raised = fixture.models.budgets.increase(
      first.budget!.budgetId,
      1,
      { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 12 },
      'synthetic-goal-human',
      () => true,
      owner,
    );
    fixture.models.budgets.activate(raised.scope, 'synthetic-goal-human', owner);
    resuming = true;
    const target = await fixture.models.goalTarget({ bot: 'mock-bot', chatRevision: 0 });
    await fixture.models.startHuman(
      'mock-bot',
      {
        requestId: 'budget-synthetic-goal-human',
        prompt: '/goal resume',
        chatRevision: 0,
        goalResume: target,
      },
      undefined,
      raised.scope,
    );
    const last = fixture.models.jobs.get('mock-bot')!;
    await last.done;
    expect(last.phase, last.error).toBe('completed');
    expect(last.goal?.id).toBe(first.goal!.id);
    expect(last.goal?.phase).toBe('complete');
    expect(last.goal?.rounds).toBeLessThanOrEqual(3);
    expect(last.budget?.budgetId).toBe(first.budget!.budgetId);
    expect(fixture.models.budgets.view(first.budget!.budgetId).requests).toBeGreaterThan(2);
  } finally {
    await fixture.close();
  }
});
