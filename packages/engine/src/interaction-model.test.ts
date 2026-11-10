import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TaskPlan } from '@daban/protocol';
import { expect, onTestFinished, test, vi } from 'vitest';
import type { ComputerFacade } from './computer-tools.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test.each(['auto', 'full'] as const)(
  'DSH %s policy keeps questions human-owned and approvals bound to the accepted task',
  async (approvalMode) => {
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
              expect.assert(models);
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
              const approval = await models.rpc('mock-bot', auth, {
                id: 'mock-web-policy',
                method: 'interaction.open',
                params: {
                  id: 'mock-web-policy',
                  sessionId: 'mock-human-session',
                  kind: 'approval',
                  tool: 'web_fetch',
                  url: 'https://example.test/mock',
                },
              });
              expect(approval).toMatchObject({
                result: { status: approvalMode === 'full' ? 'resolved' : 'pending' },
              });
              if (approvalMode === 'auto')
                await models.interactions.reply('mock-bot', job.id, 'mock-web-policy', {
                  kind: 'decision',
                  allow: true,
                });
              else
                expect(approval).toMatchObject({
                  result: { decisionSource: 'policy', reply: { kind: 'decision', allow: true } },
                });
              await expect(
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
              ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
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
              expect((result as { result: { reply: unknown } }).result.reply).toStrictEqual({
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
        approvalMode,
      });
      await ready;
      expect(models.status().bots['mock-bot'].phase).toBe('waiting');
      expect(models.status().bots.b.running).toBe(false);
      await models.interactions.reply('mock-bot', models.jobs.get('mock-bot')!.id, 'mock-request', {
        kind: 'answer',
        answers: [{ id: 'choice', selected: [], custom: '合成答案' }],
      });
      await models.jobs.get('mock-bot')!.done;
      expect(models.status().bots['mock-bot'].phase).toBe('completed');
      const plan = models.status().bots['mock-bot'].plan as TaskPlan;
      expect(plan[0].status).toBe('completed');
      await expect(
        models.start('mock-bot', {
          requestId: 'mock-human-task',
          prompt: '先询问合成选择，再执行计划。',
          approvalMode: approvalMode === 'full' ? 'auto' : 'full',
        }),
      ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
      await models.close();
      const restored = new ModelRuns(options);
      await restored.ready;
      expect(restored.status().bots['mock-bot'].plan).toStrictEqual(plan);
      expect((await restored.interactions.list())[0].status).toBe('resolved');
      await restored.close();
    } finally {
      await models?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(['allow', 'deny', 'full'] as const)(
  'the live model task handles on-demand browser approval: %s',
  async (decision) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-computer-policy-'));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'mock-policy-key' });
    const release = vi.fn(async () => {});
    const open = vi.fn(async () => release);
    const hostBrowser = {
      available: () => false,
      browser: { autoStart: { allowed: async () => false, open }, tabs: {} },
    } as unknown as ComputerFacade;
    let outcome: unknown;
    class Harness {
      async start() {}
      async close() {}
      session() {
        return {
          id: 'mock-computer-session',
          run: async () => {
            const job = models.jobs.get('mock-bot')!;
            outcome = await models.rpc('mock-bot', `Bearer ${job.token}`, {
              id: 1,
              method: 'tools/call',
              params: { name: 'computer_access', arguments: { target: 'browser' } },
            });
            return { sessionId: 'mock-computer-session', finalResponse: 'Synthetic result.' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    const models = new ModelRuns({
      settings,
      workspace,
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      hostBrowser,
      Harness,
    });
    onTestFinished(async () => {
      await models.close();
      await rm(root, { recursive: true, force: true });
    });
    await models.start('mock-bot', {
      requestId: 'mock-computer-task',
      prompt: 'Open a synthetic website.',
      approvalMode: decision === 'full' ? 'full' : 'auto',
    });
    const job = models.jobs.get('mock-bot')!;
    const approval = await vi.waitFor(async () => {
      const item = (await models.interactions.list()).find(
        (row) => row.kind === 'approval' && row.tool === 'computer_access',
      );
      expect(item).toMatchObject({
        bot: 'mock-bot',
        runId: job.id,
        sessionId: 'mock-computer-session',
        target: 'browser',
        status: decision === 'full' ? 'resolved' : 'pending',
      });
      return item!;
    });
    if (decision !== 'full') {
      expect(open).not.toHaveBeenCalled();
      await models.interactions.reply('mock-bot', job.id, approval.id, {
        kind: 'decision',
        allow: decision === 'allow',
      });
    } else {
      expect(approval).toMatchObject({ decisionSource: 'policy', reply: { allow: true } });
    }
    await job.done;
    if (decision === 'deny') {
      expect(outcome).toMatchObject({
        result: { isError: true, content: [{ type: 'text', text: 'COMPUTER_ACCESS_DENIED' }] },
      });
      expect(open).not.toHaveBeenCalled();
    } else {
      expect(outcome).toMatchObject({
        result: { content: [{ type: 'text', text: '{"connected":"browser"}' }] },
      });
      expect(open).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    }
  },
);
test('a long human wait preserves the active execution budget and cancellation still stops the run', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
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
    vi.advanceTimersByTime(600000);
    await new Promise(setImmediate);
    expect(job.abort.signal.aborted, 'waiting must not trigger a background timeout').toBe(false);
    expect(models.running('mock-bot'), 'human waiting is not model execution time').toBe(true);
    await models.interactions.reply('mock-bot', job.id, 'mock-wait', {
      kind: 'answer',
      answers: [{ id: 'choice', selected: [], custom: '合成答案' }],
    });
    vi.advanceTimersByTime(1000);
    now += 300001;
    vi.advanceTimersByTime(300001);
    await job.done;
    expect(models.status().bots['mock-bot'].phase).toBe('stopped');
    expect(models.status().bots['mock-bot'].error).toBe('MODEL_TIME_LIMIT');
  } finally {
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('a failure to persist cancellation still closes DSH and drains the task', async () => {
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
    const failure = vi.spyOn(models.interactions, 'endRun').mockImplementation(async () => {
      throw new Error('mock disk failure');
    });
    restore = () => failure.mockRestore();
    await expect(models.stop('mock-bot')).rejects.toMatchObject({
      code: 'INTERACTION_SAVE_FAILED',
    });
    expect.assert(closed > 0);
    expect(models.running('mock-bot')).toBe(false);
  } finally {
    restore();
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});
