import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
                { type: 'reasoning', text: 'SYNTHETIC PRIVATE REASONING' },
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
    assert.equal(gates.length, count);
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
    assert.ok(question);
    await models.interactions.reply('a', job.id, 'mock-human-question', {
      kind: 'answer',
      answers: [{ id: 'mock-choice', selected: ['甲'] }],
    });
    const before = await models.transcript(scope);
    assert.equal(before.state, 'recording');
    assert.deepEqual(
      before.items.map((item) => item.kind),
      ['call', 'result', 'interaction', 'interaction'],
    );
    await settle('a');
    const complete = await models.transcript(scope);
    assert.equal(complete.state, 'complete');
    assert.equal(complete.items.length, 5);
    let combined = '';
    for (const item of complete.items)
      combined += (await models.transcriptContent(scope, item.seq)).text;
    assert.ok(combined.includes('合成选择'));
    assert.ok(combined.includes('"甲"'));
    assert.equal(/PRIVATE|mock-provider-secret|sessionId/.test(combined), false);
    await models.start('a', { requestId: 'mock-private-second', prompt: '合成后续任务' });
    await entered(2);
    await settle('a');
    assert.equal(sessions[0], sessions[1]);
    assert.equal((await models.transcript(scope)).items.length, 5);
    await models.start(
      'a',
      { requestId: 'mock-group-first', prompt: '合成群聊任务' },
      { id: 'mock-group', context: '合成群上下文' },
    );
    await entered(3);
    const groupScope = { bot: 'a', runId: models.jobs.get('a')!.id, conversationId: 'mock-group' };
    await settle('a');
    await assert.rejects(models.transcript({ ...scope, bot: 'b' }), {
      code: 'TRANSCRIPT_NOT_FOUND',
    });
    await assert.rejects(models.transcript({ ...scope, chatRevision: 1 }), {
      code: 'TRANSCRIPT_NOT_FOUND',
    });
    await assert.rejects(
      models.transcript({ bot: 'a', runId: scope.runId, conversationId: 'mock-group' }),
      { code: 'TRANSCRIPT_NOT_FOUND' },
    );
    await assert.rejects(
      models.transcript({ bot: 'a', runId: groupScope.runId, chatRevision: 0 }),
      { code: 'TRANSCRIPT_NOT_FOUND' },
    );
    assert.equal((await models.transcript(groupScope)).items.length, 3);
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
    assert.equal((await models.transcript(legacy)).state, 'unavailable');
    const append = models.transcripts.append;
    models.transcripts.append = () => {
      throw new Error('SYNTHETIC STORAGE FAILURE');
    };
    await models.start('b', { requestId: 'mock-capture-failure', prompt: '合成失败记录' });
    await entered(4);
    const failedScope = { bot: 'b', runId: models.jobs.get('b')!.id, chatRevision: 0 };
    await settle('b');
    models.transcripts.append = append;
    assert.equal(models.status().bots.b.phase, 'completed');
    assert.equal((await models.transcript(failedScope)).state, 'interrupted');
    assert.equal((await models.transcript(scope)).state, 'complete');
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
    assert.equal(models.status().bots.b.phase, 'stopped');
    assert.equal((await models.transcript(stoppedScope)).state, 'complete');
    const cards = (await models.transcript(stoppedScope)).items.filter(
      (item) => item.kind === 'interaction',
    );
    assert.equal(cards.length, 2);
    assert.equal(
      JSON.parse((await models.transcriptContent(stoppedScope, cards[1].seq)).text).status,
      'cancelled',
    );
    const finishLog = models.transcripts.finish;
    models.transcripts.finish = () => {
      throw new Error('SYNTHETIC CLOSE FAILURE');
    };
    await models.start('b', { requestId: 'mock-finish-failure', prompt: '合成结束记录失败' });
    await entered(6);
    const unfinishedScope = { bot: 'b', runId: models.jobs.get('b')!.id, chatRevision: 0 };
    await settle('b');
    models.transcripts.finish = finishLog;
    assert.equal((await models.transcript(unfinishedScope)).state, 'interrupted');
    await models.chats.renew({ bot: 'a', id: 'mock-fresh-chat', revision: 0 });
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    assert.deepEqual(await models.transcript(scope), complete);
    assert.equal((await models.transcript(groupScope)).items.length, 3);
    assert.equal((await models.transcript(failedScope)).state, 'interrupted');
    assert.equal((await models.transcript(legacy)).state, 'unavailable');
  } finally {
    gates.at(-1)?.();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
