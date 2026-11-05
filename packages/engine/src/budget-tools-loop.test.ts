import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultBudgetPolicy } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Groups } from './groups.js';
import { inferenceFixture } from './inference.fixture.js';

test('SDK responses with a reused provider call ID charge distinct executions and stop the next group stage', {
  timeout: 60000,
}, async () => {
  let requests = 0;
  const fixture = await inferenceFixture((request) => {
    const call = ++requests;
    if ([1, 2, 4].includes(call)) {
      const name = request.tools?.find((tool) => tool.function.name.endsWith('write_file'))
        ?.function.name;
      if (!name) throw new Error('SYNTHETIC_WRITE_TOOL_MISSING');
      return [
        {
          id: 'synthetic-reused-call',
          name,
          args: { path: `synthetic-${call}.txt`, content: `SYNTHETIC ${call}` },
        },
      ];
    }
    return 'SYNTHETIC STAGE COMPLETE';
  });
  const models = fixture.models;
  const groups = new Groups(path.join(fixture.root, 'groups.sqlite'), {
    member: (bot) => models.profiles.get(bot),
    source: (bot, run, group) => models.groupSource(bot, run, group),
    budget: (group, source) => models.groupBudget(group, source),
    running: (bot) => models.running(bot),
    findRequest: (bot, id) => models.findRequest(bot, id),
    start: (bot, task, scope) => models.start(bot, task, scope),
    stopRequest: (bot, id, group) => models.stopRequest(bot, id, group),
  });
  try {
    await models.ready;
    models.budgets.configure(
      0,
      { ...defaultBudgetPolicy, toolLimit: 2 },
      [],
      'synthetic-tool-policy',
    );
    for (const id of ['mock-first', 'mock-next'])
      await models.profiles.register({
        id,
        name: id,
        instructions: 'SYNTHETIC',
        memory: '',
        color: 'mint',
      });
    await groups.register({
      id: 'mock-tools-group',
      name: 'Synthetic tool identity',
      members: ['mock-first', 'mock-next'],
    });
    await groups.send({
      id: 'synthetic-tool-turn',
      group: 'mock-tools-group',
      prompt: 'SYNTHETIC GROUP EXECUTIONS',
      recipients: ['mock-first', 'mock-next'],
    });
    await groups.tick();
    const first = models.jobs.get('mock-first')!;
    await first.done;
    expect(first.phase, first.error).toBe('completed');
    expect(await readFile(path.join(first.workdir, 'synthetic-1.txt'), 'utf8')).toBe('SYNTHETIC 1');
    expect(await readFile(path.join(first.workdir, 'synthetic-2.txt'), 'utf8')).toBe('SYNTHETIC 2');
    const firstTools = models.budgets.tools(first.budget!.budgetId);
    await groups.tick();
    const next = models.jobs.get('mock-next')!;
    await next.done;
    expect(next.budget?.budgetId).toBe(first.budget!.budgetId);
    await expect(
      readFile(path.join(next.workdir, 'synthetic-4.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(firstTools).toBe(2);
    expect(models.budgets.tools(first.budget!.budgetId)).toBe(2);
  } finally {
    await groups.close();
    await fixture.close();
  }
});

test.each([false, true])(
  'SDK child sessions charge reused provider IDs independently (parallel=%s)',
  { timeout: 60000 },
  async (parallel) => {
    let rootCalls = 0;
    const childCalls = new Map<string, number>();
    const fixture = await inferenceFixture((request) => {
      const text = JSON.stringify(request.messages);
      if (text.includes('SYNTHETIC ROOT DUPLICATE')) {
        rootCalls++;
        if (parallel && rootCalls === 1)
          return [1, 2].map((index) => ({
            id: `synthetic-parent-${index}`,
            name: 'subagent',
            args: {
              description: 'Synthetic reader',
              prompt: `SYNTHETIC CHILD ${index}: read input.csv once and finish.`,
            },
          }));
        if (!parallel && rootCalls <= 2)
          return [
            {
              id: 'synthetic-reused-call',
              name: 'subagent',
              args: {
                description: 'Synthetic reader',
                prompt: `SYNTHETIC CHILD ${rootCalls}: read input.csv once and finish.`,
              },
            },
          ];
        return 'SYNTHETIC ROOT COMPLETE';
      }
      const child = text.includes('SYNTHETIC CHILD 1') ? 'first' : 'second';
      const calls = (childCalls.get(child) ?? 0) + 1;
      childCalls.set(child, calls);
      if (calls === 1) {
        const name = request.tools?.find((tool) => tool.function.name.endsWith('read_file'))
          ?.function.name;
        if (!name) throw new Error('SYNTHETIC_READ_TOOL_MISSING');
        return [{ id: 'synthetic-reused-call', name, args: { path: 'input.csv' } }];
      }
      return 'SYNTHETIC CHILD COMPLETE';
    });
    try {
      await fixture.models.startHuman('mock-bot', {
        requestId: 'synthetic-reused-child-ids',
        prompt: 'SYNTHETIC ROOT DUPLICATE',
      });
      const job = fixture.models.jobs.get('mock-bot')!;
      await job.done;
      expect(job.phase, job.error).toBe('completed');
      expect(childCalls.size).toBe(2);
      expect(fixture.models.budgets.tools(job.budget!.budgetId)).toBe(4);
    } finally {
      await fixture.close();
    }
  },
);

test.each([1, 2])(
  'SDK cache downgrade obtains a separate physical-send permit (request cap=%s)',
  { timeout: 60000 },
  async (cap) => {
    const cacheKeys: boolean[] = [];
    const fixture = await inferenceFixture((request) => {
      cacheKeys.push(Object.hasOwn(request, 'prompt_cache_key'));
      if (cacheKeys.length === 1)
        return { status: 400, error: { message: 'Unknown parameter: prompt_cache_key' } };
      return 'SYNTHETIC CACHE DOWNGRADE COMPLETE';
    });
    try {
      await fixture.models.ready;
      fixture.models.budgets.configure(
        0,
        { ...defaultBudgetPolicy, mode: 'strict', maxRequests: cap },
        [],
        'synthetic-cache-policy',
      );
      await fixture.models.startHuman('mock-bot', {
        requestId: `synthetic-cache-${cap}`,
        prompt: 'SYNTHETIC CACHE DOWNGRADE',
      });
      const job = fixture.models.jobs.get('mock-bot')!;
      await job.done;
      const budget = fixture.models.budgets.view(job.budget!.budgetId);
      expect(cacheKeys).toEqual(cap === 1 ? [true] : [true, false]);
      expect(budget.requests).toBe(cacheKeys.length);
      expect(new Set(budget.receipts.map((receipt) => receipt.attemptId)).size).toBe(
        cacheKeys.length,
      );
      expect(job.phase, job.error).toBe(cap === 1 ? 'failed' : 'completed');
    } finally {
      await fixture.close();
    }
  },
);
