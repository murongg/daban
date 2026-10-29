import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('new private context fences stale sends/retries, retains records, and neither resumes nor injects the old DSH context across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chat-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const resumed: string[] = [],
    prompts: string[] = [];
  let sequence = 0;
  let release = () => {};
  let gate: Promise<unknown> = Promise.resolve();
  const hold = () => {
    gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
  };
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-session-${++sequence}`) {
      return {
        id,
        run: async (prompt: string | object[]) => {
          prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
          if (prompts.at(-1)!.includes('SYNTHETIC-HOLD-47')) await gate;
          return { sessionId: id, finalResponse: 'SYNTHETIC ANSWER' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'shared'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns(options);
  const original = { requestId: 'mock-before', prompt: 'SYNTHETIC-OLD-CONTEXT-47' };
  try {
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.ready;
    await models.start('a', original);
    await models.jobs.get('a')!.done;
    const old = models.status().bots.a.runId!;
    await models.start('a', { requestId: 'mock-before-2', prompt: 'SYNTHETIC CONTINUE' });
    await models.jobs.get('a')!.done;
    assert.deepEqual(resumed, ['mock-session-1']);
    await models.start(
      'a',
      { requestId: 'mock-group-before', prompt: 'SYNTHETIC GROUP' },
      { id: 'mock-group', context: 'SYNTHETIC GROUP CONTEXT' },
    );
    await models.jobs.get('a')!.done;
    await models.chats.renew({ id: 'mock-new-context', bot: 'a', revision: 0 });
    assert.equal(models.status().bots.a.history.length, 0);
    const oldPage = await models.chatHistory('a', 0);
    assert.equal(oldPage.items.length, 2);
    assert.equal(oldPage.items[0].prompt, original.prompt);
    await assert.rejects(models.start('a', { requestId: 'mock-late', prompt: 'SYNTHETIC LATE' }), {
      code: 'CHAT_REVISION_REQUIRED',
    });
    await assert.rejects(
      models.start('a', { requestId: 'mock-late-0', prompt: 'SYNTHETIC LATE', chatRevision: 0 }),
      { code: 'CHAT_CONFLICT' },
    );
    await assert.rejects(
      models.start('a', {
        requestId: 'mock-old-retry',
        prompt: 'SYNTHETIC RETRY',
        retryOf: old,
        chatRevision: 1,
      }),
      { code: 'INVALID_RETRY' },
    );
    assert.equal((await models.start('a', original)).runId, old);
    await models.start('a', {
      requestId: 'mock-after',
      prompt: 'SYNTHETIC FRESH',
      chatRevision: 1,
    });
    await models.jobs.get('a')!.done;
    assert.equal(resumed.length, 1);
    assert.ok(!prompts.at(-1)!.includes(original.prompt));
    assert.equal(models.status().bots.a.history.length, 1);
    assert.equal((await models.journal.all('a')).filter((row) => !row.conversationId).length, 3);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    assert.equal(models.status().bots.a.phase, 'completed');
    assert.equal(models.status().bots.a.chatRevision, 1);
    await models.start('a', {
      requestId: 'mock-after-restart',
      prompt: 'SYNTHETIC FRESH CONTINUE',
      chatRevision: 1,
    });
    await models.jobs.get('a')!.done;
    assert.deepEqual(resumed, ['mock-session-1', 'mock-session-3']);
    await models.start(
      'a',
      { requestId: 'mock-group-after', prompt: 'SYNTHETIC GROUP CONTINUE' },
      { id: 'mock-group', context: 'SYNTHETIC GROUP CONTEXT' },
    );
    await models.jobs.get('a')!.done;
    assert.equal(resumed.at(-1), 'mock-session-2');
    assert.equal(models.chats.current('b').revision, 0);
    hold();
    await models.start('b', { requestId: 'mock-busy-private', prompt: 'SYNTHETIC-HOLD-47' });
    await assert.rejects(models.chats.renew({ id: 'mock-busy-boundary', bot: 'b', revision: 0 }), {
      code: 'CHAT_BUSY',
    });
    release();
    await models.jobs.get('b')!.done;
    for (let index = 0; index < 23; index++)
      await models.journal.put({
        bot: 'mock-reader',
        runId: `mock-${String(index).padStart(3, '0')}`,
        requestId: `mock-request-${index}`,
        prompt: 'SYNTHETIC PAGED QUESTION',
        kind: 'chat',
        running: false,
        phase: 'completed',
        result: '合成'.repeat(32000),
        error: '',
        trace: [],
      });
    const seen = new Set<string>();
    let before: string | undefined;
    for (let pages = 0; pages < 24; pages++) {
      const page = await models.chatHistory('mock-reader', 0, before);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024 + 1024);
      for (const item of page.items) {
        assert.ok(!seen.has(item.runId));
        seen.add(item.runId);
        assert.equal(item.result, '合成'.repeat(32000));
      }
      if (!page.nextBefore) break;
      assert.notEqual(page.nextBefore, before);
      before = page.nextBefore;
    }
    assert.equal(seen.size, 23);
    hold();
    await models.start(
      'b',
      { requestId: 'mock-busy-group', prompt: 'SYNTHETIC-HOLD-47' },
      { id: 'mock-other-group', context: 'SYNTHETIC GROUP' },
    );
    assert.equal(
      (await models.chats.renew({ id: 'mock-group-independent', bot: 'b', revision: 0 })).chat
        .revision,
      1,
    );
    assert.equal(models.jobs.get('b')!.running, true);
    release();
    await models.jobs.get('b')!.done;
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
