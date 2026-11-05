import { defaultBudgetPolicy, type GoalResumeTarget } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { inferenceFixture, type SyntheticRequest } from './inference.fixture.js';

function currentGoal(request: SyntheticRequest) {
  for (const value of [...request.messages].reverse()) {
    const message = value as { role?: string; content?: unknown };
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const data = JSON.parse(message.content) as {
        goal?: { id: string; revision: number; phase: string };
      };
      if (data.goal) return data.goal;
    } catch {
      /* Synthetic non-goal tool output. */
    }
  }
  return undefined;
}
async function stoppedGoal() {
  let sends = 0;
  const fixture = await inferenceFixture((request) => {
    sends++;
    const goal = currentGoal(request);
    return goal
      ? 'SYNTHETIC PROGRESS'
      : [
          {
            name: 'create_goal',
            args: { objective: 'SYNTHETIC GUARDED GOAL', max_goal_rounds: 3 },
          },
        ];
  });
  await fixture.models.ready;
  fixture.models.budgets.configure(
    0,
    { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
    [],
    'synthetic-goal-policy',
  );
  await fixture.models.startHuman('mock-bot', {
    requestId: 'synthetic-goal-create',
    prompt: '/goal SYNTHETIC GUARDED GOAL',
    chatRevision: 0,
  });
  const first = fixture.models.jobs.get('mock-bot')!;
  await first.done;
  expect(first.goal?.id).toBeDefined();
  const owner = { bot: 'mock-bot', runId: first.id, chatRevision: 0 };
  const raised = fixture.models.budgets.increase(
    first.budget!.budgetId,
    1,
    { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 12 },
    'synthetic-goal-raise',
    () => true,
    owner,
  );
  const target = await fixture.models.goalTarget({ bot: 'mock-bot', chatRevision: 0 });
  expect(target.budget).toEqual(raised.scope);
  return {
    fixture,
    first,
    target,
    get sends() {
      return sends;
    },
  };
}
for (const kind of ['goal', 'budget', 'human'] as const)
  test(`SDK Goal continuation rejects a changed ${kind} before any model send`, {
    timeout: 60000,
  }, async () => {
    const f = await stoppedGoal();
    try {
      const before = f.sends;
      const target: GoalResumeTarget = structuredClone(f.target);
      if (kind === 'goal') target.goalId = 'foreign-goal';
      if (kind === 'budget') target.budget = { ...target.budget!, revision: 1 };
      if (kind === 'human')
        f.fixture.models.budgets.goals.noteHuman(target.owner, 'synthetic-newer-human');
      await expect(
        f.fixture.models.startHuman(
          'mock-bot',
          {
            requestId: `synthetic-bad-${kind}`,
            prompt: '/goal resume',
            chatRevision: 0,
            goalResume: target,
          },
          undefined,
          target.budget,
        ),
      ).rejects.toThrow();
      expect(f.sends).toBe(before);
      expect(f.fixture.models.budgets.view(f.first.budget!.budgetId).unknownCount).toBe(2);
    } finally {
      await f.fixture.close();
    }
  });
test('a Human turn accepted while the SDK waits invalidates the Goal pre-resume permission', {
  timeout: 60000,
}, async () => {
  const f = await stoppedGoal();
  const rpc = f.fixture.models.rpc.bind(f.fixture.models);
  let release: () => unknown = () => {},
    entered: () => unknown = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const waiting = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  f.fixture.models.rpc = async (bot, auth, value) => {
    if (value && typeof value === 'object' && 'method' in value && value.method === 'goal.resume') {
      entered();
      await gate;
    }
    return rpc(bot, auth, value);
  };
  try {
    const before = f.sends;
    await f.fixture.models.startHuman(
      'mock-bot',
      {
        requestId: 'synthetic-late-goal',
        prompt: '/goal resume',
        chatRevision: 0,
        goalResume: f.target,
      },
      undefined,
      f.target.budget,
    );
    const job = f.fixture.models.jobs.get('mock-bot')!;
    await waiting;
    await f.fixture.models.insert('mock-bot', {
      id: 'synthetic-new-human-turn',
      runId: job.id,
      chatRevision: 0,
      text: 'SYNTHETIC NEW HUMAN TURN',
    });
    release();
    await job.done;
    expect(job.phase).toBe('failed');
    expect(f.sends).toBe(before);
  } finally {
    release();
    f.fixture.models.rpc = rpc;
    await f.fixture.close();
  }
});
test('lost Goal permit acknowledgement cannot replay the same Human request or rearm on ordinary retry', {
  timeout: 60000,
}, async () => {
  const f = await stoppedGoal();
  const rpc = f.fixture.models.rpc.bind(f.fixture.models);
  let controls = 0;
  f.fixture.models.rpc = async (bot, auth, value) => {
    const result = await rpc(bot, auth, value);
    if (value && typeof value === 'object' && 'method' in value && value.method === 'goal.resume') {
      controls++;
      throw new Error('SYNTHETIC_CONTROL_ACK_LOST');
    }
    return result;
  };
  try {
    const before = f.sends;
    const request = {
      requestId: 'synthetic-uncertain-goal',
      prompt: '/goal resume',
      chatRevision: 0,
      goalResume: f.target,
    };
    await f.fixture.models.startHuman('mock-bot', request, undefined, f.target.budget);
    const job = f.fixture.models.jobs.get('mock-bot')!;
    await job.done;
    expect(controls).toBe(1);
    expect(f.sends).toBe(before);
    const duplicate = await f.fixture.models.startHuman(
      'mock-bot',
      structuredClone(request),
      undefined,
      f.target.budget,
    );
    expect(duplicate.runId).toBe(job.id);
    expect(controls).toBe(1);
    expect(f.sends).toBe(before);
    await expect(
      f.fixture.models.startHuman(
        'mock-bot',
        { ...request, goalResume: { ...f.target, goalId: 'foreign-goal' } },
        undefined,
        f.target.budget,
      ),
    ).rejects.toThrow('REQUEST_ID_REUSED');
  } finally {
    f.fixture.models.rpc = rpc;
    await f.fixture.close();
  }
});

test('concurrent identical Human Goal requests reconcile to one published run', {
  timeout: 60000,
}, async () => {
  const f = await stoppedGoal();
  const recovery = f.fixture.models.journal.recovery.bind(f.fixture.models.journal);
  let release: () => unknown = () => {},
    entered: () => unknown = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const waiting = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  let delayed = false;
  f.fixture.models.journal.recovery = async (...args) => {
    if (!delayed) {
      delayed = true;
      entered();
      await gate;
    }
    return recovery(...args);
  };
  const request = {
    requestId: 'synthetic-concurrent-goal',
    prompt: '/goal resume',
    chatRevision: 0,
    goalResume: f.target,
  };
  try {
    const first = f.fixture.models.startHuman('mock-bot', request, undefined, f.target.budget);
    await waiting;
    const second = await f.fixture.models.startHuman(
      'mock-bot',
      structuredClone(request),
      undefined,
      f.target.budget,
    );
    release();
    const duplicate = await first;
    expect(duplicate.runId).toBe(second.runId);
    await f.fixture.models.jobs.get('mock-bot')!.done;
  } finally {
    release();
    f.fixture.models.journal.recovery = recovery;
    await f.fixture.close();
  }
});

test.each(['time', 'finishRun'] as const)(
  'a budget %s storage failure still releases Host run ownership',
  { timeout: 60000 },
  async (method) => {
    const fixture = await inferenceFixture(() => 'SYNTHETIC COMPLETE');
    await fixture.models.ready;
    const failure = vi.spyOn(fixture.models.budgets, method).mockImplementation(() => {
      throw new Error('SYNTHETIC_BUDGET_STORAGE_FAILURE');
    });
    try {
      await fixture.models.startHuman('mock-bot', {
        requestId: `synthetic-${method}-failure`,
        prompt: 'SYNTHETIC COMPLETE',
        chatRevision: 0,
      });
      const job = fixture.models.jobs.get('mock-bot')!;
      await expect(job.done).resolves.toBeUndefined();
      expect(fixture.models.running('mock-bot')).toBe(false);
      expect(job.phase).toBe('failed');
    } finally {
      failure.mockRestore();
      await fixture.close();
    }
  },
);
