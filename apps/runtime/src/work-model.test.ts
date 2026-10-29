import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolResult } from './computer-tools.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

function result(value: unknown) {
  assert.ok(value && typeof value === 'object' && 'result' in value);
  const rpc = value.result as ToolResult;
  assert.equal(rpc.isError, undefined, JSON.stringify(rpc));
  const block = rpc.content[0];
  assert.equal(block.type, 'text');
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
        assert.ok(reply && 'result' in reply);
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
          assert.ok(job.prompt?.includes('work_read'));
          const catalog = await models.rpc(job.bot, `Bearer ${job.token}`, {
            id: 'mock-list',
            method: 'tools/list',
          });
          assert.ok(catalog && 'result' in catalog);
          const tools = catalog.result as { tools: { name: string }[] };
          for (const name of [
            'work_list',
            'work_read',
            'work_create',
            'work_update',
            'work_trash',
            'work_restore',
            'task_catalog',
          ])
            assert.ok(
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
  async function turn(bot: string, requestId: string) {
    await models.start(bot, { requestId, prompt: 'MOCK CURRENT HUMAN REQUEST' });
    const job = models.jobs.get(bot)!;
    await job.done;
    assert.equal(job.phase, 'completed', job.error);
    assert.equal(job.files.length, 0);
    return job;
  }
  try {
    await settings.save({ apiKey: 'mock-work-provider-key' });
    await models.ready;
    const greeting = await turn('mock-alpha', 'mock-greeting');
    assert.equal(greeting.toolCount, 0);
    let itemId = '';
    act = async (bot) => {
      const created = result(
        await call(bot, 'work_create', {
          title: '合成跨 Bot 待办',
          description: 'MOCK SHARED DATA',
        }),
      );
      itemId = created.item.id;
      assert.deepEqual(created.item.createdBy, { kind: 'bot', bot });
      assert.equal(result(await call(bot, 'work_read', { id: itemId })).item.revision, 1);
    };
    const first = await turn('mock-alpha', 'mock-create');
    assert.equal(first.sessionId, greeting.sessionId);
    act = async (bot) => {
      const catalog = result(await call(bot, 'task_catalog'));
      assert.equal(catalog.work.page.items[0].id, itemId);
      assert.equal(
        catalog.tools.some((tool: { name: string }) => tool.name === 'screenshot'),
        false,
      );
      assert.equal(result(await call(bot, 'work_read', { id: itemId })).item.revision, 1);
      const changed = result(
        await call(bot, 'work_update', {
          id: itemId,
          revision: 1,
          patch: { status: 'doing', progress: 'MOCK VERIFIED STEP' },
        }),
      );
      assert.equal(changed.item.status, 'doing');
      assert.deepEqual(changed.item.updatedBy, { kind: 'bot', bot });
    };
    const second = await turn('mock-beta', 'mock-update');
    assert.notEqual(second.sessionId, first.sessionId);
    assert.ok(second.trace.every((row) => ['work', 'catalog'].includes(row.surface)));
    assert.equal(second.trace.filter((row) => row.phase === 'settled').length, 3);
    const transcript = await models.transcript({
      bot: 'mock-beta',
      runId: second.id,
      chatRevision: 0,
    });
    assert.ok(transcript.items.some((row) => row.kind === 'call' && row.name === 'work_update'));
    assert.equal((await models.work.list()).items.length, 1);
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
    assert.equal(old.phase, 'completed');
    await models.close();
    const file = path.join(root, 'model/task-journal', `${old.id}.json`);
    const journal = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(journal.version, 1);
    journal.task.sessionProfile = 'general-v5';
    await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
    models = new ModelRuns(options);
    await models.start('mock-alpha', { requestId: 'mock-new', prompt: 'MOCK NEW GREETING' });
    const current = models.jobs.get('mock-alpha')!;
    await current.done;
    assert.equal(current.phase, 'completed');
    assert.notEqual(current.sessionId, old.sessionId);
    assert.deepEqual(resumed, []);
    assert.equal(current.toolCount, 0);
    assert.ok(
      models.journal.history('mock-alpha').some((row) => row.prompt === 'MOCK OLD HUMAN MESSAGE'),
    );
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
