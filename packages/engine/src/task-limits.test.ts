import { expect, test } from 'vitest';
import { inferenceFixture } from './inference.fixture.js';

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
      expect((await fixture.models.journal.recovery(job.bot, job.id))?.toolCount).toBe(4);
      expect(fixture.models.status().bots['mock-bot'].toolCount).toBe(4);
      await fixture.restart();
      expect((await fixture.models.journal.recovery(job.bot, job.id))?.toolCount).toBe(4);
      const repeated = await fixture.models.startHuman('mock-bot', {
        requestId: 'synthetic-reused-child-ids',
        prompt: 'SYNTHETIC ROOT DUPLICATE',
      });
      expect(repeated.runId).toBe(job.id);
    } finally {
      await fixture.close();
    }
  },
);
