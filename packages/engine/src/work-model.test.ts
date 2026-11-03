import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ToolResult } from './computer-tools.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

function result(value: unknown) {
  expect.assert(value && typeof value === 'object' && 'result' in value);
  const rpc = value.result as ToolResult;
  expect(rpc.isError, JSON.stringify(rpc)).toBe(undefined);
  const block = rpc.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.type === 'text' ? block.text : '');
}

test('normal ModelRuns RPC offers shared Work and live task catalog to two independent Bot conversations with durable traces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let models: ModelRuns;
  let sequence = 0,
    wire = 0;
  const observers = new Map<string, (value: unknown) => unknown>();
  let act: (bot: string) => Promise<unknown> = async () => {};
  const call = (bot: string, name: string, args: Record<string, unknown> = {}) => {
    const job = models.jobs.get(bot)!;
    const callId = `mock-wire-${++wire}`;
    const emit = (type: string, data: unknown) =>
      observers.get(bot)?.({
        method: 'session.event',
        params: {
          sessionId: job.sessionId,
          event: { type, seq: ++wire, time: 1800000000000 + wire, data },
        },
      });
    emit('tool/call', { name, callId, arguments: JSON.stringify(args) });
    return models
      .rpc(bot, `Bearer ${job.token}`, {
        id: callId,
        method: 'tools/call',
        params: { name, arguments: args },
      })
      .then((reply) => {
        expect.assert(reply && 'result' in reply);
        emit('tool/result', { message: { toolCallId: callId, ...(reply.result as ToolResult) } });
        return reply;
      });
  };
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-work-session-${++sequence}`) {
      return {
        id,
        run: async (
          _prompt: unknown,
          observer: { onNotification: (value: unknown) => unknown },
        ) => {
          const job = [...models.jobs.values()].find(
            (item) => item.sessionId === id && item.running,
          )!;
          observers.set(job.bot, observer.onNotification);
          expect.assert(job.prompt?.includes('work_read'));
          expect.assert(job.prompt?.includes('work_comment'));
          const catalog = await models.rpc(job.bot, `Bearer ${job.token}`, {
            id: 'mock-list',
            method: 'tools/list',
          });
          expect.assert(catalog && 'result' in catalog);
          const tools = catalog.result as { tools: { name: string }[] };
          for (const name of [
            'work_list',
            'work_read',
            'work_comments',
            'work_comment',
            'work_create',
            'work_update',
            'work_trash',
            'work_restore',
            'task_catalog',
          ])
            expect.assert(
              tools.tools.some((tool) => tool.name === name),
              name,
            );
          await act(job.bot);
          return { sessionId: id, finalResponse: 'MOCK VERIFIED WORK REPLY' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  models = new ModelRuns({
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'shared'),
    origin: 'http://127.0.0.1:12345',
  });
  async function turn(bot: string, requestId: string, retryOf?: string) {
    await models.start(bot, {
      requestId,
      prompt: 'MOCK CURRENT HUMAN REQUEST',
      ...(retryOf ? { retryOf } : {}),
    });
    const job = models.jobs.get(bot)!;
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    expect(job.files.length).toBe(0);
    return job;
  }
  try {
    await settings.save({ apiKey: 'mock-work-provider-key' });
    await models.ready;
    for (const bot of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id: bot,
        name: bot,
        instructions: 'MOCK ROLE',
        memory: '',
        color: 'mint',
      });
    const greeting = await turn('mock-alpha', 'mock-greeting');
    expect(greeting.toolCount).toBe(0);
    let itemId = '';
    act = async (bot) => {
      const created = result(
        await call(bot, 'work_create', {
          title: '合成跨 Bot 待办',
          description: 'MOCK SHARED DATA',
        }),
      );
      itemId = created.item.id;
      expect(created.item.createdBy).toStrictEqual({ kind: 'bot', bot });
      expect(result(await call(bot, 'work_read', { id: itemId })).item.revision).toBe(1);
      const comment = result(
        await call(bot, 'work_comment', { id: itemId, revision: 1, body: '合成模型讨论甲' }),
      );
      expect(comment.comment.createdBy).toStrictEqual({ kind: 'bot', bot });
      expect(comment.item.revision).toBe(2);
    };
    const first = await turn('mock-alpha', 'mock-create');
    expect(first.sessionId).toBe(greeting.sessionId);
    act = async (bot) => {
      const catalog = result(await call(bot, 'task_catalog'));
      expect(catalog.work.page.items[0].id).toBe(itemId);
      expect(catalog.tools.some((tool: { name: string }) => tool.name === 'screenshot')).toBe(
        false,
      );
      expect(result(await call(bot, 'work_read', { id: itemId })).item.revision).toBe(2);
      const discussion = result(await call(bot, 'work_comments', { id: itemId }));
      expect(discussion.comments[0].body).toBe('合成模型讨论甲');
      expect(
        result(await call(bot, 'work_comment', { id: itemId, revision: 2, body: '合成模型讨论乙' }))
          .item.revision,
      ).toBe(3);
      await call(bot, 'work_read', { id: itemId });
      const changed = result(
        await call(bot, 'work_update', {
          id: itemId,
          revision: 3,
          patch: { status: 'doing', progress: 'MOCK VERIFIED STEP' },
        }),
      );
      expect(changed.item.status).toBe('doing');
      expect(changed.item.updatedBy).toStrictEqual({ kind: 'bot', bot });
    };
    const second = await turn('mock-beta', 'mock-update');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect.assert(second.trace.every((row) => ['work', 'catalog'].includes(row.surface)));
    expect(second.trace.filter((row) => row.phase === 'settled').length).toBe(6);
    const transcript = await models.transcript({
      bot: 'mock-beta',
      runId: second.id,
      chatRevision: 0,
    });
    expect.assert(
      transcript.items.some((row) => row.kind === 'call' && row.name === 'work_update'),
    );
    expect.assert(
      transcript.items.some((row) => row.kind === 'call' && row.name === 'work_comment'),
    );
    expect((await models.work.list()).items.length).toBe(1);
    await models.work.write(
      {
        id: 'mock-newer-human',
        item: itemId,
        action: 'update',
        revision: 4,
        value: { description: 'MOCK CURRENT HUMAN DETAIL' },
      },
      { kind: 'human' },
    );
    act = async (bot) => {
      const replay = result(
        await call(bot, 'work_comment', { id: itemId, revision: 1, body: '合成模型讨论甲' }),
      );
      expect(replay.acceptedRevision).toBe(2);
      expect(replay.item.description).toBe('MOCK CURRENT HUMAN DETAIL');
      expect(replay.item.revision).toBe(5);
    };
    await turn('mock-alpha', 'mock-comment-retry', first.id);
    expect((await models.work.comments({ item: itemId })).comments.length).toBe(2);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('new Work capabilities retire an old native tool context while preserving prior visible chat and zero-tool behavior', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-session-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const resumed: string[] = [];
  let sequence = 0;
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-work-migration-${++sequence}`) {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'MOCK VISIBLE OLD ANSWER' }) };
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
    await settings.save({ apiKey: 'mock-work-session-key' });
    await models.start('mock-alpha', { requestId: 'mock-old', prompt: 'MOCK OLD HUMAN MESSAGE' });
    const old = models.jobs.get('mock-alpha')!;
    await old.done;
    expect(old.phase).toBe('completed');
    await models.close();
    const file = path.join(root, 'model/task-journal', `${old.id}.json`);
    const journal = JSON.parse(await readFile(file, 'utf8'));
    expect(journal.version).toBe(1);
    journal.task.sessionProfile = 'general-v7';
    await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
    models = new ModelRuns(options);
    await models.start('mock-alpha', { requestId: 'mock-new', prompt: 'MOCK NEW GREETING' });
    const current = models.jobs.get('mock-alpha')!;
    await current.done;
    expect(current.phase).toBe('completed');
    expect(current.sessionId).not.toBe(old.sessionId);
    expect(resumed).toStrictEqual([]);
    expect(current.toolCount).toBe(0);
    expect.assert(
      models.journal.history('mock-alpha').some((row) => row.prompt === 'MOCK OLD HUMAN MESSAGE'),
    );
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
