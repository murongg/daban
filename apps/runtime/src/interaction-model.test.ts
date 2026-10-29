import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskPlan } from '@daban/protocol';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('DSH questions pause only their own task, receive exact replies, persist plans and cannot impersonate another session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-human-model-'));
  let models: ModelRuns | undefined;
  try {
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'mock-private-key' });
    let entered: () => unknown = () => undefined;
    const ready = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    class Harness {
      async start() {}
      async close() {}
      session() {
        return {
          id: 'mock-human-session',
          run: async (
            _prompt: unknown,
            observer: { onNotification: (note: unknown) => unknown },
          ) => {
            assert.ok(models);
            const job = models.jobs.get('mock-bot')!;
            observer.onNotification({
              method: 'session.event',
              params: {
                sessionId: 'mock-human-session',
                event: {
                  type: 'todo/write',
                  data: { todos: [{ content: '等待合成选择', status: 'in_progress' }] },
                },
              },
            });
            const auth = `Bearer ${job.token}`;
            await assert.rejects(
              models.rpc('mock-bot', auth, {
                id: 1,
                method: 'interaction.open',
                params: {
                  id: 'mock-forged',
                  kind: 'question',
                  sessionId: 'other-session',
                  questions: [{ id: 'choice', question: '合成选择？' }],
                },
              }),
              { code: 'INVALID_INTERACTION' },
            );
            await models.rpc('mock-bot', auth, {
              id: 2,
              method: 'interaction.open',
              params: {
                id: 'mock-request',
                kind: 'question',
                sessionId: 'mock-human-session',
                questions: [{ id: 'choice', question: '合成选择？' }],
              },
            });
            entered();
            const result = await models.rpc('mock-bot', auth, {
              id: 3,
              method: 'interaction.wait',
              params: { id: 'mock-request' },
            });
            assert.deepEqual((result as { result: { reply: unknown } }).result.reply, {
              kind: 'answer',
              answers: [{ id: 'choice', selected: [], custom: '合成答案' }],
            });
            observer.onNotification({
              method: 'session.event',
              params: {
                sessionId: 'mock-human-session',
                event: {
                  type: 'todo/write',
                  data: { todos: [{ content: '等待合成选择', status: 'completed' }] },
                },
              },
            });
            return { sessionId: 'mock-human-session', finalResponse: '收到合成答案。' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    const options = {
      settings,
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness,
    };
    models = new ModelRuns(options);
    await models.start('mock-bot', {
      requestId: 'mock-human-task',
      prompt: '先询问合成选择，再执行计划。',
    });
    await ready;
    assert.equal(models.status().bots['mock-bot'].phase, 'waiting');
    assert.equal(models.status().bots.b.running, false);
    await models.interactions.reply('mock-bot', models.jobs.get('mock-bot')!.id, 'mock-request', {
      kind: 'answer',
      answers: [{ id: 'choice', selected: [], custom: '合成答案' }],
    });
    await models.jobs.get('mock-bot')!.done;
    assert.equal(models.status().bots['mock-bot'].phase, 'completed');
    const plan = models.status().bots['mock-bot'].plan as TaskPlan;
    assert.equal(plan[0].status, 'completed');
    await models.close();
    const restored = new ModelRuns(options);
    await restored.ready;
    assert.deepEqual(restored.status().bots['mock-bot'].plan, plan);
    assert.equal((await restored.interactions.list())[0].status, 'resolved');
    await restored.close();
  } finally {
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('a long human wait preserves the active execution budget and cancellation still stops the run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const root = await mkdtemp(path.join(tmpdir(), 'mock-human-budget-'));
  let models: ModelRuns | undefined;
  try {
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'mock-budget-key' });
    let entered: () => unknown = () => undefined;
    let complete: (value: { sessionId: string; finalResponse: string }) => unknown = () =>
      undefined;
    const ready = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    const pending = new Promise<{ sessionId: string; finalResponse: string }>((resolve) => {
      complete = resolve;
    });
    class Harness {
      async start() {}
      async close() {
        complete({ sessionId: 'mock-wait-session', finalResponse: '合成结束' });
      }
      session() {
        return {
          id: 'mock-wait-session',
          run: async () => {
            entered();
            return pending;
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    models = new ModelRuns({
      settings,
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness,
    });
    await models.start('mock-bot', { requestId: 'mock-wait-task', prompt: '合成等待任务' });
    await ready;
    const job = models.jobs.get('mock-bot')!;
    await models.rpc('mock-bot', `Bearer ${job.token}`, {
      id: 1,
      method: 'interaction.open',
      params: {
        id: 'mock-wait',
        sessionId: 'mock-wait-session',
        kind: 'question',
        questions: [{ id: 'choice', question: '合成选择？' }],
      },
    });
    now = 600000;
    t.mock.timers.tick(600000);
    await new Promise(setImmediate);
    assert.equal(job.abort.signal.aborted, false, 'waiting must not trigger a background timeout');
    assert.equal(models.running('mock-bot'), true, 'human waiting is not model execution time');
    await models.interactions.reply('mock-bot', job.id, 'mock-wait', {
      kind: 'answer',
      answers: [{ id: 'choice', selected: [], custom: '合成答案' }],
    });
    t.mock.timers.tick(1000);
    now += 300001;
    t.mock.timers.tick(300001);
    await job.done;
    assert.equal(models.status().bots['mock-bot'].phase, 'stopped');
    assert.match(models.status().bots['mock-bot'].error || '', /时长上限/);
  } finally {
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('a failure to persist cancellation still closes DSH and drains the task', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-human-stop-failure-'));
  let models: ModelRuns | undefined;
  let restore = () => {};
  try {
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'mock-stop-key' });
    let entered: () => unknown = () => undefined,
      finish: (value: { sessionId: string; finalResponse: string }) => unknown = () => undefined,
      closed = 0;
    const ready = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    const pending = new Promise<{ sessionId: string; finalResponse: string }>((resolve) => {
      finish = resolve;
    });
    class Harness {
      async start() {}
      async close() {
        closed++;
        finish({ sessionId: 'mock-stop-session', finalResponse: '合成停止' });
      }
      session() {
        return {
          id: 'mock-stop-session',
          run: async () => {
            entered();
            return pending;
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    models = new ModelRuns({
      settings,
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness,
    });
    await models.start('mock-bot', { requestId: 'mock-stop-task', prompt: '合成任务' });
    await ready;
    const failure = t.mock.method(models.interactions, 'endRun', async () => {
      throw new Error('mock disk failure');
    });
    restore = () => failure.mock.restore();
    await assert.rejects(models.stop('mock-bot'), { code: 'INTERACTION_SAVE_FAILED' });
    assert.ok(closed > 0);
    assert.equal(models.running('mock-bot'), false);
  } finally {
    restore();
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});
