import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('model runs retain scoped native execution and durable human decisions across resume and restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-model-transcript-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const gates: (() => unknown)[] = [];
  const observers: ((note: unknown) => unknown)[] = [];
  const sessions: string[] = [];
  let event = 0;
  class Harness {
    async start() {}
    async close() {
      gates.at(-1)?.();
    }
    session(id = `mock-session-${sessions.length + 1}`) {
      sessions.push(id);
      return {
        id,
        run: async (
          _prompt: unknown,
          observer: { onNotification: (value: unknown) => unknown },
        ) => {
          observers.push(observer.onNotification);
          const emit = (type: string, data: unknown) =>
            observer.onNotification({
              method: 'session.event',
              params: {
                sessionId: id,
                event: { type, seq: ++event, time: 1800000000000 + event, data },
              },
            });
          emit('system/message', { text: 'SYNTHETIC PRIVATE SYSTEM' });
          emit('tool/call', {
            callId: `mock-call-${event}`,
            name: 'web_search',
            arguments: '{"query":"合成请求 mock-provider-secret"}',
          });
          emit('tool/result', {
            message: {
              toolCallId: `mock-call-${event - 1}`,
              content: [{ type: 'text', text: '合成结果 mock-provider-secret' }],
            },
          });
          await new Promise((resolve) => gates.push(() => resolve(undefined)));
          emit('assistant/message', {
            message: {
              content: [
                { type: 'text', text: '合成回复' },
                { type: 'reasoning', text: '合成模型思考' },
              ],
            },
          });
          return { sessionId: id, finalResponse: '合成回复' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const options = {
    settings,
    Harness,
    workspace: path.join(root, 'shared'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns(options);
  const settle = async (bot: string) => {
    gates.at(-1)!();
    await models.jobs.get(bot)!.done;
  };
  const entered = async (count: number) => {
    for (let attempt = 0; gates.length < count && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gates.length).toBe(count);
  };
  try {
    await settings.save({ apiKey: 'mock-provider-secret' });
    await models.start('a', { requestId: 'mock-private-first', prompt: '合成私聊任务' });
    await entered(1);
    const job = models.jobs.get('a')!;
    const scope = { bot: 'a', runId: job.id, chatRevision: 0 };
    const question = await models.rpc('a', `Bearer ${job.token}`, {
      id: 1,
      method: 'interaction.open',
      params: {
        id: 'mock-human-question',
        sessionId: job.sessionId,
        kind: 'question',
        questions: [
          {
            id: 'mock-choice',
            question: '合成选择？',
            options: [{ label: '甲' }, { label: '乙' }],
          },
        ],
      },
    });
    expect.assert(question);
    await models.interactions.reply('a', job.id, 'mock-human-question', {
      kind: 'answer',
      answers: [{ id: 'mock-choice', selected: ['甲'] }],
    });
    const before = await models.transcript(scope);
    expect(before.state).toBe('recording');
    expect(before.items.map((item) => item.kind)).toStrictEqual([
      'call',
      'result',
      'interaction',
      'interaction',
    ]);
    await settle('a');
    const complete = await models.transcript(scope);
    expect(complete.state).toBe('complete');
    expect(complete.items.length).toBe(6);
    expect(complete.items.some((item) => item.kind === 'thinking')).toBe(true);
    let combined = '';
    for (const item of complete.items)
      combined += (await models.transcriptContent(scope, item.seq)).text;
    expect.assert(combined.includes('合成选择'));
    expect.assert(combined.includes('"甲"'));
    expect(/PRIVATE|mock-provider-secret|sessionId/.test(combined)).toBe(false);
    await models.start('a', { requestId: 'mock-private-second', prompt: '合成后续任务' });
    await entered(2);
    await settle('a');
    expect(sessions[0]).toBe(sessions[1]);
    expect((await models.transcript(scope)).items.length).toBe(6);
    await models.start(
      'a',
      { requestId: 'mock-group-first', prompt: '合成群聊任务' },
      { id: 'mock-group', context: '合成群上下文' },
    );
    await entered(3);
    const groupScope = { bot: 'a', runId: models.jobs.get('a')!.id, conversationId: 'mock-group' };
    await settle('a');
    await expect(models.transcript({ ...scope, bot: 'b' })).rejects.toMatchObject({
      code: 'TRANSCRIPT_NOT_FOUND',
    });
    await expect(models.transcript({ ...scope, chatRevision: 1 })).rejects.toMatchObject({
      code: 'TRANSCRIPT_NOT_FOUND',
    });
    await expect(
      models.transcript({ bot: 'a', runId: scope.runId, conversationId: 'mock-group' }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_NOT_FOUND' });
    await expect(
      models.transcript({ bot: 'a', runId: groupScope.runId, chatRevision: 0 }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_NOT_FOUND' });
    expect((await models.transcript(groupScope)).items.length).toBe(4);
    const legacy = { bot: 'a', runId: 'mock-legacy-run', chatRevision: 0 };
    await models.journal.put({
      ...legacy,
      kind: 'chat',
      prompt: '合成旧任务',
      phase: 'completed',
      running: false,
      result: '合成旧回复',
      error: '',
      trace: [],
    });
    expect((await models.transcript(legacy)).state).toBe('unavailable');
    const append = models.transcripts.append;
    models.transcripts.append = () => {
      throw new Error('SYNTHETIC STORAGE FAILURE');
    };
    await models.start('b', { requestId: 'mock-capture-failure', prompt: '合成失败记录' });
    await entered(4);
    const failedScope = { bot: 'b', runId: models.jobs.get('b')!.id, chatRevision: 0 };
    await settle('b');
    models.transcripts.append = append;
    expect(models.status().bots.b.phase).toBe('completed');
    expect((await models.transcript(failedScope)).state).toBe('interrupted');
    expect((await models.transcript(scope)).state).toBe('complete');
    await models.start('b', { requestId: 'mock-stop-prefix', prompt: '合成停止请求' });
    await entered(5);
    const stoppedScope = { bot: 'b', runId: models.jobs.get('b')!.id, chatRevision: 0 };
    const stopping = models.jobs.get('b')!;
    await models.rpc('b', `Bearer ${stopping.token}`, {
      id: 2,
      method: 'interaction.open',
      params: {
        id: 'mock-pending-stop',
        sessionId: stopping.sessionId,
        kind: 'question',
        questions: [{ id: 'mock-stop-choice', question: '合成未回答问题？' }],
      },
    });
    await models.stop('b');
    expect(models.status().bots.b.phase).toBe('stopped');
    expect((await models.transcript(stoppedScope)).state).toBe('complete');
    const cards = (await models.transcript(stoppedScope)).items.filter(
      (item) => item.kind === 'interaction',
    );
    expect(cards.length).toBe(2);
    expect(
      JSON.parse((await models.transcriptContent(stoppedScope, cards[1].seq)).text).status,
    ).toBe('cancelled');
    const finishLog = models.transcripts.finish;
    models.transcripts.finish = () => {
      throw new Error('SYNTHETIC CLOSE FAILURE');
    };
    await models.start('b', { requestId: 'mock-finish-failure', prompt: '合成结束记录失败' });
    await entered(6);
    const unfinishedScope = { bot: 'b', runId: models.jobs.get('b')!.id, chatRevision: 0 };
    await settle('b');
    models.transcripts.finish = finishLog;
    expect((await models.transcript(unfinishedScope)).state).toBe('interrupted');
    await models.chats.renew({ bot: 'a', id: 'mock-fresh-chat', revision: 0 });
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    expect(await models.transcript(scope)).toStrictEqual(complete);
    expect((await models.transcript(groupScope)).items.length).toBe(4);
    expect((await models.transcript(failedScope)).state).toBe('interrupted');
    expect((await models.transcript(legacy)).state).toBe('unavailable');
  } finally {
    gates.at(-1)?.();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
