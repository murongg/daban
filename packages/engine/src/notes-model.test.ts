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
  const reply = value.result as ToolResult;
  assert.equal(reply.isError, undefined, JSON.stringify(reply));
  const block = reply.content[0];
  assert.equal(block.type, 'text');
  return JSON.parse(block.type === 'text' ? block.text : '');
}

test('native model RPC offers scoped notes, uses durable receipts and records calls without any computer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notes-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let models: ModelRuns,
    sequence = 0,
    wire = 0;
  let act: (bot: string) => Promise<unknown> = async () => {};
  const observers = new Map<string, (value: unknown) => unknown>();
  const call = async (bot: string, name: string, args: Record<string, unknown> = {}) => {
    const job = models.jobs.get(bot)!,
      callId = `mock-note-wire-${++wire}`;
    const emit = (type: string, data: unknown) =>
      observers.get(bot)?.({
        method: 'session.event',
        params: {
          sessionId: job.sessionId,
          event: { type, seq: ++wire, time: 1800000000000 + wire, data },
        },
      });
    emit('tool/call', { name: `mcp__computer__${name}`, callId, arguments: JSON.stringify(args) });
    const reply = await models.rpc(bot, `Bearer ${job.token}`, {
      id: callId,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    assert.ok(reply && 'result' in reply);
    emit('tool/result', { message: { toolCallId: callId, ...(reply.result as ToolResult) } });
    return reply;
  };
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-notes-session-${++sequence}`) {
      return {
        id,
        run: async (
          _prompt: unknown,
          observer: { onNotification: (value: unknown) => unknown },
        ) => {
          const job = [...models.jobs.values()].find(
            (value) => value.running && value.sessionId === id,
          )!;
          observers.set(job.bot, observer.onNotification);
          assert.ok(job.prompt?.includes('bot_notes_read'));
          const offered = await models.rpc(job.bot, `Bearer ${job.token}`, {
            id: 'mock-tools',
            method: 'tools/list',
          });
          assert.ok(offered && 'result' in offered);
          const list = offered.result as { tools: { name: string }[] };
          for (const name of [
            'bot_notes_list',
            'bot_notes_read',
            'bot_notes_add',
            'bot_notes_update',
            'bot_notes_trash',
            'bot_notes_restore',
          ])
            assert.ok(
              list.tools.some((tool) => tool.name === name),
              name,
            );
          assert.equal(
            list.tools.some((tool) => tool.name === 'screenshot'),
            false,
          );
          await act(job.bot);
          return { sessionId: id, finalResponse: 'MOCK VERIFIED NOTES REPLY' };
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
      prompt: 'MOCK CURRENT HUMAN NOTE REQUEST',
      ...(retryOf ? { retryOf } : {}),
    });
    const job = models.jobs.get(bot)!;
    await job.done;
    assert.equal(job.phase, 'completed', job.error);
    assert.equal(job.files.length, 0);
    return job;
  }
  try {
    await settings.save({ apiKey: 'mock-notes-provider-key' });
    await models.ready;
    for (const id of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id,
        name: id,
        instructions: 'MOCK ROLE',
        memory: '',
        color: 'mint',
      });
    const greeting = await turn('mock-alpha', 'mock-greeting');
    assert.equal(greeting.toolCount, 0);
    const args = { title: '合成模型便笺', body: 'MOCK ALPHA ONLY', status: 'open' };
    let noteId = '';
    act = async (bot) => {
      const note = result(await call(bot, 'bot_notes_add', args)).item;
      noteId = note.id;
      assert.deepEqual(note.createdBy, { kind: 'bot', bot });
      assert.equal(result(await call(bot, 'bot_notes_read', { id: noteId })).item.body, args.body);
    };
    const first = await turn('mock-alpha', 'mock-add');
    assert.equal(first.sessionId, greeting.sessionId);
    act = async (bot) => {
      const catalog = result(await call(bot, 'task_catalog'));
      assert.deepEqual(catalog.notes.page.items, []);
      const denied = await call(bot, 'bot_notes_read', { id: noteId });
      assert.match(JSON.stringify(denied), /NOTE_NOT_FOUND/);
      const own = result(
        await call(bot, 'bot_notes_add', { title: args.title, body: 'MOCK BETA ONLY' }),
      ).item;
      assert.equal(own.bot, bot);
      assert.notEqual(own.id, noteId);
    };
    const beta = await turn('mock-beta', 'mock-beta-add');
    assert.notEqual(beta.sessionId, first.sessionId);
    const human = await models.notes.write(
      'mock-alpha',
      {
        id: 'mock-human-newer',
        note: noteId,
        revision: 1,
        action: 'update',
        value: { body: 'MOCK HUMAN NEWER', status: 'done' },
      },
      { kind: 'human' },
    );
    act = async (bot) => {
      assert.deepEqual(result(await call(bot, 'bot_notes_add', args)).item, human.item);
    };
    const retry = await turn('mock-alpha', 'mock-explicit-retry', first.id);
    assert.equal(retry.intentId, first.intentId);
    assert.equal((await models.notes.status('mock-alpha')).available, true);
    assert.equal((await models.notes.list('mock-alpha', { filter: 'all' })).items.length, 1);
    assert.equal((await models.notes.list('mock-beta', { filter: 'all' })).items.length, 1);
    const transcript = await models.transcript({
      bot: 'mock-alpha',
      runId: first.id,
      chatRevision: 0,
    });
    assert.ok(
      transcript.items.some((row) => row.kind === 'call' && row.name?.endsWith('bot_notes_add')),
    );
    assert.ok(first.trace.every((row) => row.surface === 'notes'));
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('notes capabilities replace a general-v6 native tool context while retaining visible history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notes-migration-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json')),
    resumed: string[] = [];
  let sequence = 0;
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-notes-migration-${++sequence}`) {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'MOCK RETAINED ANSWER' }) };
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
    await settings.save({ apiKey: 'mock-notes-migration-key' });
    await models.start('mock-alpha', { requestId: 'mock-old', prompt: 'MOCK OLD MESSAGE' });
    const old = models.jobs.get('mock-alpha')!;
    await old.done;
    assert.equal(old.phase, 'completed');
    await models.close();
    const file = path.join(root, 'model/task-journal', `${old.id}.json`),
      journal = JSON.parse(await readFile(file, 'utf8'));
    journal.task.sessionProfile = 'general-v6';
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
      models.journal.history('mock-alpha').some((record) => record.prompt === 'MOCK OLD MESSAGE'),
    );
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
