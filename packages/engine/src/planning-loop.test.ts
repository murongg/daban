import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { inferenceFixture } from './inference.fixture.js';

test('read-only planning survives restart and persona replacement without crossing Bots or new chats', {
  timeout: 60000,
}, async () => {
  let continued = 0,
    denied = false;
  const fixture = await inferenceFixture((request) => {
    const text = JSON.stringify(request.messages);
    denied ||= text.includes('PLAN_MODE_READ_ONLY');
    if (text.includes('SYNTHETIC CONTINUATION') && ++continued === 1) {
      const name = request.tools!.find((tool) => tool.function.name.endsWith('write_file'))!
        .function.name;
      return [{ name, args: { path: 'forbidden.txt', content: 'SYNTHETIC FORBIDDEN' } }];
    }
    return 'SYNTHETIC PLAN SAVED';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-plan-first',
      prompt: '/plan Synthetic investigation.',
    });
    await fixture.models.jobs.get('mock-bot')!.done;
    const previous = fixture.models.jobs.get('mock-bot')!.sessionId;
    await fixture.models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic planner',
      instructions: 'SYNTHETIC NEW PERSONA',
      memory: '',
      color: 'mint',
    });
    await fixture.restart();
    await fixture.models.start('mock-bot', {
      requestId: 'mock-plan-continue',
      prompt: 'SYNTHETIC CONTINUATION',
    });
    const next = fixture.models.jobs.get('mock-bot')!;
    await next.done;
    expect(next.sessionId).not.toBe(previous);
    expect(fixture.models.status().bots['mock-bot'].planning).toBe(true);
    expect(denied).toBe(true);
    await expect(readFile(path.join(next.workdir, 'forbidden.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fixture.models.start('mock-other', {
      requestId: 'mock-plan-other',
      prompt: 'Synthetic other Bot.',
    });
    await fixture.models.jobs.get('mock-other')!.done;
    expect(fixture.models.status().bots['mock-other'].planning).toBe(false);
    await fixture.models.chats.renew({ bot: 'mock-bot', id: 'mock-new-chat', revision: 0 });
    await fixture.models.start('mock-bot', {
      requestId: 'mock-plan-new-chat',
      prompt: 'Synthetic new chat.',
      chatRevision: 1,
    });
    await fixture.models.jobs.get('mock-bot')!.done;
    expect(fixture.models.status().bots['mock-bot'].planning).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('native plan review shows the full plan and permits writes only from the following step', {
  timeout: 60000,
}, async () => {
  const plan =
    '# Synthetic plan\n1. Inspect the synthetic input.\n2. Save the requested synthetic result.';
  let calls = 0,
    denied = false;
  const fixture = await inferenceFixture((request) => {
    const write =
      request.tools?.find((tool) => tool.function.name.endsWith('write_file'))?.function.name ??
      'mcp__computer__write_file';
    denied ||= JSON.stringify(request.messages).includes('PLAN_MODE_READ_ONLY');
    if (++calls === 1)
      return [{ name: write, args: { path: 'forbidden.txt', content: 'SYNTHETIC FORBIDDEN' } }];
    if (calls === 2)
      return [
        { name: 'exit_plan_mode', args: { plan } },
        { name: write, args: { path: 'same-batch.txt', content: 'SYNTHETIC FORBIDDEN' } },
      ];
    if (calls === 3)
      return [{ name: write, args: { path: 'result.txt', content: 'SYNTHETIC APPROVED RESULT' } }];
    return 'SYNTHETIC PLAN COMPLETE';
  });
  try {
    await fixture.models.start('mock-bot', {
      requestId: 'mock-plan',
      prompt: '/plan Inspect and save a synthetic result after review.',
    });
    const job = fixture.models.jobs.get('mock-bot')!;
    await expect
      .poll(
        async () =>
          (await fixture.models.interactions.list()).find((item) => item.status === 'pending'),
        { timeout: 15000 },
      )
      .toBeDefined();
    const question = (await fixture.models.interactions.list()).find(
      (item) => item.status === 'pending',
    )!;
    expect(question.kind).toBe('question');
    if (question.kind !== 'question') throw new Error('SYNTHETIC QUESTION EXPECTED');
    expect(question.questions[0].detail).toBe(plan);
    await expect(readFile(path.join(job.workdir, 'forbidden.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fixture.models.interactions.reply(job.bot, job.id, question.id, {
      kind: 'answer',
      answers: [{ id: question.questions[0].id, selected: ['Approve'] }],
    });
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    expect(fixture.models.status().bots['mock-bot'].planning).toBe(false);
    expect(denied).toBe(true);
    await expect(readFile(path.join(job.workdir, 'same-batch.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(job.workdir, 'result.txt'), 'utf8')).toBe(
      'SYNTHETIC APPROVED RESULT',
    );
  } finally {
    await fixture.close();
  }
});
