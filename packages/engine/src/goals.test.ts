import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

test('goal control is explicit, bounded, root-owned and refuses blind retries or repeated creation', async () => {
  const { apply, goalCommand } = await import(new URL('./goals.js', import.meta.url).href);
  expect(goalCommand('Quote /goal clear in the document')).toBeUndefined();
  expect(goalCommand('/goal SYNTHETIC OBJECTIVE')).toStrictEqual({
    action: 'create',
    objective: 'SYNTHETIC OBJECTIVE',
  });
  const root = { id: 'mock-root' },
    child = { id: 'mock-child' };
  let guard!: (exec: { agent?: object; name: string; arguments?: unknown }) => string | undefined;
  const setup = async (retry: boolean) =>
    apply(
      {
        agents: { roots: () => [root], get: (id: string) => (id === root.id ? root : child) },
        goals: {},
        sessions: {},
        tools: {
          guard: (value: typeof guard) => {
            guard = value;
          },
        },
        on: () => undefined,
        effect: () => undefined,
      },
      {
        sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
        command: goalCommand('/goal SYNTHETIC OBJECTIVE'),
        retry,
      },
    );
  await setup(false);
  expect(
    guard({
      agent: root,
      name: 'create_goal',
      arguments: { objective: 'SYNTHETIC OBJECTIVE', max_goal_rounds: 4 },
    }),
  ).toBe('GOAL_ROUND_LIMIT');
  expect(
    guard({ agent: child, name: 'create_goal', arguments: { objective: 'SYNTHETIC OBJECTIVE' } }),
  ).toBe('GOAL_HUMAN_COMMAND_REQUIRED');
  expect(
    guard({
      agent: root,
      name: 'create_goal',
      arguments: { objective: 'SYNTHETIC OTHER OBJECTIVE' },
    }),
  ).toBe('GOAL_OBJECTIVE_MISMATCH');
  expect(
    guard({ agent: root, name: 'create_goal', arguments: { objective: 'SYNTHETIC OBJECTIVE' } }),
  ).toBeUndefined();
  expect(
    guard({ agent: root, name: 'create_goal', arguments: { objective: 'SYNTHETIC OBJECTIVE' } }),
  ).toBe('GOAL_ALREADY_ATTEMPTED');
  await setup(true);
  expect(
    guard({ agent: root, name: 'create_goal', arguments: { objective: 'SYNTHETIC OBJECTIVE' } }),
  ).toBe('GOAL_RETRY_READ_ONLY');
});

test('goal projection disarms terminal states and ignores control notices as continuation rounds', async () => {
  const { projectGoal } = await import(new URL('./goals.js', import.meta.url).href);
  const prior = {
    id: 'mock-goal',
    revision: 1,
    objective: 'SYNTHETIC GOAL',
    phase: 'active',
    activation: 'armed',
    rounds: 3,
    limit: 3,
  };
  const note = (type: string, data: unknown) => ({
    method: 'session.event',
    params: { sessionId: 'mock-session', event: { type, data } },
  });
  const blocked = projectGoal(
    note('goal/change', {
      operation: 'block',
      roundsStarted: 3,
      goal: {
        id: prior.id,
        revision: 2,
        objective: prior.objective,
        phase: 'blocked',
        maxGoalRounds: 3,
      },
    }),
    'mock-session',
    prior,
    (text: string) => text,
  );
  expect(blocked).toMatchObject({ activation: 'disarmed', rounds: 3 });
  expect(
    projectGoal(
      note('user/message', { source: { kind: 'goal', goalId: prior.id, revision: 1, round: 0 } }),
      'mock-session',
      prior,
      (text: string) => text,
    ),
  ).toBeUndefined();
});
