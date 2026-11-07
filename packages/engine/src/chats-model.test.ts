import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('trashed contexts reject new tasks and normal history until restored without restarting old work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-trashed-context-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let starts = 0;
  class Harness {
    async start() {}
    async close() {}
    session() {
      return {
        id: 'mock-trash-session',
        run: async () => {
          starts++;
          return { sessionId: 'mock-trash-session', finalResponse: 'SYNTHETIC RETAINED' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const models = new ModelRuns({
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'shared'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.ready;
    await models.start('a', { requestId: 'mock-trash-original', prompt: 'SYNTHETIC ORIGINAL' });
    await models.jobs.get('a')!.done;
    const request = {
      id: 'mock-trash-context',
      bot: 'a',
      revision: 0,
      version: 0,
      action: 'trash' as const,
      title: 'SYNTHETIC TOPIC',
    };
    await models.chats.action(request);
    const current = models.chats.current('a').revision;
    await expect(
      models.start('a', {
        requestId: 'mock-trashed-send',
        prompt: 'SYNTHETIC BLOCKED',
        chatRevision: current,
        contextRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_TRASHED' });
    await expect(models.chatHistory('a', 0)).rejects.toMatchObject({
      code: 'CONVERSATION_TRASHED',
    });
    await models.chats.action({
      ...request,
      id: 'mock-restore-context',
      version: 1,
      action: 'restore',
    });
    expect(starts).toBe(1);
    expect((await models.chatHistory('a', 0)).items).toHaveLength(1);
    await models.start('a', {
      requestId: 'mock-restored-send',
      prompt: 'SYNTHETIC AFTER RESTORE',
      chatRevision: current,
      contextRevision: 0,
    });
    await models.jobs.get('a')!.done;
    expect(starts).toBe(2);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit historical continuation resumes only its original context while retaining current-boundary and request-identity fences', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-chat-resume-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const resumed: string[] = [];
  let sequence = 0;
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-context-${++sequence}`) {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'SYNTHETIC ANSWER' }) };
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
  try {
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.ready;
    await models.profiles.register({
      id: 'a',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
      model: 'deepseek-v4-pro',
    });
    await models.start('a', { requestId: 'mock-first', prompt: 'SYNTHETIC FIRST' });
    await models.jobs.get('a')!.done;
    await models.chats.renew({ id: 'mock-new', bot: 'a', revision: 0 });
    await models.start('a', {
      requestId: 'mock-second',
      prompt: 'SYNTHETIC SECOND',
      chatRevision: 1,
    });
    await models.jobs.get('a')!.done;
    const request = {
      requestId: 'mock-resume',
      prompt: 'SYNTHETIC CONTINUE',
      chatRevision: 1,
      contextRevision: 0,
    };
    const accepted = await models.start('a', request);
    expect(accepted.chatRevision).toBe(0);
    await models.jobs.get('a')!.done;
    expect(resumed).toEqual(['mock-context-1']);
    await expect(models.start('a', { ...request, contextRevision: 1 })).rejects.toMatchObject({
      code: 'REQUEST_ID_REUSED',
    });
    await expect(models.start('a', { ...request, model: 'deepseek-v4-pro' })).rejects.toMatchObject(
      { code: 'REQUEST_ID_REUSED' },
    );
    await expect(
      models.start('a', { ...request, requestId: 'mock-stale', chatRevision: 0 }),
    ).rejects.toMatchObject({ code: 'CHAT_CONFLICT' });
    await expect(
      models.start('a', { ...request, requestId: 'mock-future', contextRevision: 2 }),
    ).rejects.toMatchObject({ code: 'INVALID_TASK' });
    expect((await models.chatHistory('a', 0)).items).toHaveLength(2);
    expect((await models.chatHistory('a', 1)).items).toHaveLength(1);
    expect(models.journal.conversations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bot: 'a', revision: 0, title: 'SYNTHETIC FIRST' }),
        expect.objectContaining({ bot: 'a', revision: 1, title: 'SYNTHETIC SECOND' }),
      ]),
    );
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    expect((await models.start('a', request)).runId).toBe(accepted.runId);
    await models.start('a', { ...request, requestId: 'mock-restarted' });
    await models.jobs.get('a')!.done;
    expect(resumed.at(-1)).toBe('mock-context-1');
    await models.start('a', {
      requestId: 'mock-model-choice',
      prompt: 'SYNTHETIC MODEL CHOICE',
      chatRevision: 1,
      contextRevision: 1,
      model: 'deepseek-flash',
    });
    expect(models.jobs.get('a')!.model).toBe('deepseek-flash');
    expect(models.jobs.get('a')!.attemptSummary).toEqual([
      expect.objectContaining({ model: 'deepseek-flash', phase: 'starting', fence: 'clean' }),
    ]);
    expect((await models.profiles.get('a'))?.model).toBe('deepseek-v4-pro');
    await models.jobs.get('a')!.done;
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    expect(resumed).toStrictEqual(['mock-session-1']);
    await models.start(
      'a',
      { requestId: 'mock-group-before', prompt: 'SYNTHETIC GROUP' },
      { id: 'mock-group', context: 'SYNTHETIC GROUP CONTEXT' },
    );
    await models.jobs.get('a')!.done;
    await models.chats.renew({ id: 'mock-new-context', bot: 'a', revision: 0 });
    expect(models.status().bots.a.history.length).toBe(0);
    const oldPage = await models.chatHistory('a', 0);
    expect(oldPage.items.length).toBe(2);
    expect(oldPage.items[0].prompt).toBe(original.prompt);
    await expect(
      models.start('a', { requestId: 'mock-late', prompt: 'SYNTHETIC LATE' }),
    ).rejects.toMatchObject({
      code: 'CHAT_REVISION_REQUIRED',
    });
    await expect(
      models.start('a', { requestId: 'mock-late-0', prompt: 'SYNTHETIC LATE', chatRevision: 0 }),
    ).rejects.toMatchObject({ code: 'CHAT_CONFLICT' });
    await expect(
      models.start('a', {
        requestId: 'mock-old-retry',
        prompt: 'SYNTHETIC RETRY',
        retryOf: old,
        chatRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY' });
    expect((await models.start('a', original)).runId).toBe(old);
    await models.start('a', {
      requestId: 'mock-after',
      prompt: 'SYNTHETIC FRESH',
      chatRevision: 1,
    });
    await models.jobs.get('a')!.done;
    expect(resumed.length).toBe(1);
    expect.assert(!prompts.at(-1)!.includes(original.prompt));
    expect(models.status().bots.a.history.length).toBe(1);
    expect((await models.journal.all('a')).filter((row) => !row.conversationId).length).toBe(3);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    expect(models.status().bots.a.phase).toBe('completed');
    expect(models.status().bots.a.chatRevision).toBe(1);
    await models.start('a', {
      requestId: 'mock-after-restart',
      prompt: 'SYNTHETIC FRESH CONTINUE',
      chatRevision: 1,
    });
    await models.jobs.get('a')!.done;
    expect(resumed).toStrictEqual(['mock-session-1', 'mock-session-3']);
    await models.start(
      'a',
      { requestId: 'mock-group-after', prompt: 'SYNTHETIC GROUP CONTINUE' },
      { id: 'mock-group', context: 'SYNTHETIC GROUP CONTEXT' },
    );
    await models.jobs.get('a')!.done;
    expect(resumed.at(-1)).toBe('mock-session-2');
    expect(models.chats.current('b').revision).toBe(0);
    hold();
    await models.start('b', { requestId: 'mock-busy-private', prompt: 'SYNTHETIC-HOLD-47' });
    await expect(
      models.chats.renew({ id: 'mock-busy-boundary', bot: 'b', revision: 0 }),
    ).rejects.toMatchObject({
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
      expect.assert(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024 + 1024);
      for (const item of page.items) {
        expect.assert(!seen.has(item.runId));
        seen.add(item.runId);
        expect(item.result).toBe('合成'.repeat(32000));
      }
      if (!page.nextBefore) break;
      expect(page.nextBefore).not.toBe(before);
      before = page.nextBefore;
    }
    expect(seen.size).toBe(23);
    hold();
    await models.start(
      'b',
      { requestId: 'mock-busy-group', prompt: 'SYNTHETIC-HOLD-47' },
      { id: 'mock-other-group', context: 'SYNTHETIC GROUP' },
    );
    expect(
      (await models.chats.renew({ id: 'mock-group-independent', bot: 'b', revision: 0 })).chat
        .revision,
    ).toBe(1);
    expect(models.jobs.get('b')!.running).toBe(true);
    release();
    await models.jobs.get('b')!.done;
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
