import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { ToolResult } from './computer-tools.js';
import { ModelRuns } from './model.js';
import { modelPhase, observeSearch } from './model-timing.fixture.js';
import { ModelSettings } from './settings.js';

function result(value: unknown) {
  expect.assert(value && typeof value === 'object' && 'result' in value);
  const reply = value.result as ToolResult;
  expect(reply.isError, JSON.stringify(reply)).toBe(undefined);
  const block = reply.content[0];
  expect(block.type).toBe('text');
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
    expect.assert(reply && 'result' in reply);
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
          expect.assert(job.prompt?.includes('bot_notes_read'));
          const offered = await models.rpc(job.bot, `Bearer ${job.token}`, {
            id: 'mock-tools',
            method: 'tools/list',
          });
          expect.assert(offered && 'result' in offered);
          const list = offered.result as { tools: { name: string }[] };
          for (const name of [
            'bot_notes_list',
            'bot_notes_read',
            'bot_notes_add',
            'bot_notes_update',
            'bot_notes_trash',
            'bot_notes_restore',
          ])
            expect.assert(
              list.tools.some((tool) => tool.name === name),
              name,
            );
          expect(list.tools.some((tool) => tool.name === 'screenshot')).toBe(false);
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
  observeSearch(models.search);
  async function turn(bot: string, requestId: string, retryOf?: string) {
    await modelPhase(`notes:${requestId}:start`, () =>
      models.start(bot, {
        requestId,
        prompt: 'MOCK CURRENT HUMAN NOTE REQUEST',
        ...(retryOf ? { retryOf } : {}),
      }),
    );
    const job = models.jobs.get(bot)!;
    await modelPhase(`notes:${requestId}:done`, () => job.done);
    expect(job.phase, job.error).toBe('completed');
    expect(job.files.length).toBe(0);
    return job;
  }
  try {
    await modelPhase('notes:settings', () => settings.save({ apiKey: 'mock-notes-provider-key' }));
    await modelPhase('notes:ready', () => models.ready);
    for (const id of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id,
        name: id,
        instructions: 'MOCK ROLE',
        memory: '',
        color: 'mint',
      });
    const greeting = await turn('mock-alpha', 'mock-greeting');
    expect(greeting.toolCount).toBe(0);
    const args = { title: '合成模型便笺', body: 'MOCK ALPHA ONLY', status: 'open' };
    let noteId = '';
    act = async (bot) => {
      const note = result(await call(bot, 'bot_notes_add', args)).item;
      noteId = note.id;
      expect(note.createdBy).toStrictEqual({ kind: 'bot', bot });
      expect(result(await call(bot, 'bot_notes_read', { id: noteId })).item.body).toBe(args.body);
    };
    const first = await turn('mock-alpha', 'mock-add');
    expect(first.sessionId).toBe(greeting.sessionId);
    act = async (bot) => {
      const catalog = result(await call(bot, 'task_catalog'));
      expect(catalog.notes.page.items).toStrictEqual([]);
      const denied = await call(bot, 'bot_notes_read', { id: noteId });
      expect(JSON.stringify(denied)).toMatch(/NOTE_NOT_FOUND/);
      const own = result(
        await call(bot, 'bot_notes_add', { title: args.title, body: 'MOCK BETA ONLY' }),
      ).item;
      expect(own.bot).toBe(bot);
      expect(own.id).not.toBe(noteId);
    };
    const beta = await turn('mock-beta', 'mock-beta-add');
    expect(beta.sessionId).not.toBe(first.sessionId);
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
      expect(result(await call(bot, 'bot_notes_add', args)).item).toStrictEqual(human.item);
    };
    const retry = await turn('mock-alpha', 'mock-explicit-retry', first.id);
    expect(retry.intentId).toBe(first.intentId);
    expect((await models.notes.status('mock-alpha')).available).toBe(true);
    expect((await models.notes.list('mock-alpha', { filter: 'all' })).items.length).toBe(1);
    expect((await models.notes.list('mock-beta', { filter: 'all' })).items.length).toBe(1);
    const transcript = await models.transcript({
      bot: 'mock-alpha',
      runId: first.id,
      chatRevision: 0,
    });
    expect.assert(
      transcript.items.some((row) => row.kind === 'call' && row.name?.endsWith('bot_notes_add')),
    );
    expect.assert(first.trace.every((row) => row.surface === 'notes'));
  } finally {
    await modelPhase('notes:close', () => models.close());
    await modelPhase('notes:cleanup', () => rm(root, { recursive: true, force: true }));
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
  observeSearch(models.search);
  try {
    await settings.save({ apiKey: 'mock-notes-migration-key' });
    await modelPhase('notes:migration:old:start', () =>
      models.start('mock-alpha', { requestId: 'mock-old', prompt: 'MOCK OLD MESSAGE' }),
    );
    const old = models.jobs.get('mock-alpha')!;
    await modelPhase('notes:migration:old:done', () => old.done);
    expect(old.phase).toBe('completed');
    await models.close();
    const file = path.join(root, 'model/task-journal', `${old.id}.json`),
      journal = JSON.parse(await readFile(file, 'utf8'));
    journal.task.sessionProfile = 'general-v6';
    await writeFile(file, JSON.stringify(journal), { mode: 0o600 });
    models = new ModelRuns(options);
    observeSearch(models.search);
    await modelPhase('notes:migration:new:start', () =>
      models.start('mock-alpha', { requestId: 'mock-new', prompt: 'MOCK NEW GREETING' }),
    );
    const current = models.jobs.get('mock-alpha')!;
    await modelPhase('notes:migration:new:done', () => current.done);
    expect(current.phase).toBe('completed');
    expect(current.sessionId).not.toBe(old.sessionId);
    expect(resumed).toStrictEqual([]);
    expect(current.toolCount).toBe(0);
    expect.assert(
      models.journal.history('mock-alpha').some((record) => record.prompt === 'MOCK OLD MESSAGE'),
    );
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
