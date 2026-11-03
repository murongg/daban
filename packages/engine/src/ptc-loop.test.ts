import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { inferenceFixture } from './inference.fixture.js';

test('real DSH PTC calls the existing scoped workspace tools through the pure runtime', {
  timeout: 60000,
}, async () => {
  let calls = 0,
    onlyProgram = false;
  const fixture = await inferenceFixture((request) => {
    onlyProgram = request.tools?.every((tool) => tool.function.name === 'run_code') ?? false;
    if (++calls === 1)
      return [
        {
          name: 'run_code',
          args: {
            description: 'Synthetic file check',
            code: 'await tools.mcp__computer__write_file({path:"ptc.txt",content:"SYNTHETIC PTC RESULT"}); return await tools.mcp__computer__read_file({path:"ptc.txt"});',
          },
        },
      ];
    return 'SYNTHETIC PTC COMPLETE';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-ptc',
      prompt: '/ptc Write and read the synthetic file.',
    });
    const job = fixture.models.jobs.get('mock-bot')!;
    await job.done;
    expect(onlyProgram).toBe(true);
    expect(job.phase, job.error).toBe('completed');
    expect(await readFile(path.join(job.workdir, 'ptc.txt'), 'utf8')).toBe('SYNTHETIC PTC RESULT');
  } finally {
    await fixture.close();
  }
});

test('requesting PTC cannot bypass a persisted read-only plan', { timeout: 60000 }, async () => {
  let stage = 'plan',
    calls = 0,
    offeredProgram = false,
    refused = false;
  const fixture = await inferenceFixture((request) => {
    if (stage === 'plan') return 'SYNTHETIC PLAN';
    offeredProgram ||= request.tools?.some((tool) => tool.function.name === 'run_code') ?? false;
    refused ||= JSON.stringify(request.messages).includes('PLAN_MODE_READ_ONLY');
    if (++calls === 1)
      return [
        {
          name: 'mcp__computer__write_file',
          args: { path: 'forbidden.txt', content: 'SYNTHETIC FORBIDDEN' },
        },
      ];
    return 'SYNTHETIC PLAN REMAINS READ ONLY';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-ptc-plan',
      prompt: '/plan Synthetic investigation.',
    });
    await fixture.models.jobs.get('mock-bot')!.done;
    stage = 'ptc';
    await fixture.models.start('mock-bot', {
      requestId: 'mock-ptc-blocked',
      prompt: '/ptc Write a synthetic file.',
    });
    const job = fixture.models.jobs.get('mock-bot')!;
    await job.done;
    expect(offeredProgram).toBe(false);
    expect(refused).toBe(true);
    await expect(readFile(path.join(job.workdir, 'forbidden.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await fixture.close();
  }
});

test('PTC delegation keeps children native, read-only and owned until completion', {
  timeout: 60000,
}, async () => {
  let rootCalls = 0,
    childCalls = 0,
    childNative = false,
    refused = false;
  const fixture = await inferenceFixture((request) => {
    if (JSON.stringify(request.messages).includes('SYNTHETIC PTC ROOT')) {
      if (++rootCalls === 1)
        return [
          {
            name: 'run_code',
            args: {
              description: 'Synthetic delegation check',
              code: 'return await tools.subagent({description:"Synthetic reader",prompt:"Try writing forbidden.txt once, then report the refusal and finish."});',
            },
          },
        ];
      return 'SYNTHETIC PTC ROOT COMPLETE';
    }
    childNative =
      !request.tools?.some((tool) => tool.function.name === 'run_code') &&
      !!request.tools?.some((tool) => tool.function.name === 'mcp__computer__read_file');
    if (++childCalls === 1)
      return [
        {
          name: 'mcp__computer__write_file',
          args: { path: 'forbidden.txt', content: 'SYNTHETIC FORBIDDEN' },
        },
      ];
    refused ||= JSON.stringify(request.messages).includes('DELEGATION_READ_ONLY');
    return 'SYNTHETIC CHILD COMPLETE';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-ptc-delegation',
      prompt: '/ptc SYNTHETIC PTC ROOT: delegate a short read-only check.',
    });
    const job = fixture.models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    expect(childCalls).toBeGreaterThanOrEqual(2);
    expect(childNative).toBe(true);
    expect(refused).toBe(true);
    await expect(readFile(path.join(job.workdir, 'forbidden.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await fixture.close();
  }
});
