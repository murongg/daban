import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns, sdkPatch } from './model.js';
import { ModelSettings, type ResolvedModel } from './settings.js';

const route: ResolvedModel = {
  provider: 'mock-context',
  model: 'provider:mock-context:mock-model',
  apiModel: 'mock-model',
  api: 'openai-completions',
  baseURL: 'https://models.example.test/v1',
  apiKey: 'mock-context-key',
  secrets: ['mock-context-key'],
  vision: false,
  binding: 'b'.repeat(64),
  contextWindow: 16384,
  maxTokens: 8192,
};

test('DSH compaction budgets fit small windows and grow retention for larger models', () => {
  const policy = (window: number, output: number) => {
    const patch = sdkPatch(
      'http://127.0.0.1:12345',
      'a',
      'mock-capability',
      undefined,
      60,
      route.model,
      undefined,
      undefined,
      { ...route, contextWindow: window, maxTokens: output },
    );
    const item = patch.find((item) => 'id' in item && item.id === 'compaction-basic');
    expect.assert(item && 'config' in item);
    return item.config as {
      thresholdRatio: number;
      headroomTokens: number;
      retainTokens: number;
      maxTokens: number;
    };
  };
  for (const [window, output] of [
    [4096, 512],
    [16384, 8192],
    [32768, 16384],
    [128000, 8192],
    [1000000, 262144],
  ]) {
    const value = policy(window, output);
    const threshold = Math.min(
      window * value.thresholdRatio,
      window - output - value.headroomTokens,
    );
    expect.assert(threshold > value.retainTokens && value.retainTokens > 0);
    expect.assert(value.maxTokens > 0 && value.maxTokens <= output);
  }
  expect.assert(policy(1000000, 8192).retainTokens > policy(16384, 8192).retainTokens);
  const patch = sdkPatch('http://127.0.0.1:12345', 'a', 'mock-capability');
  expect.assert(
    patch.some(
      (row) => 'insert' in row && row.insert.some((item) => item.id === 'tool-result-pruner'),
    ),
  );
});

async function fixture(
  emit?: (observer: (note: unknown) => unknown, session: string) => Promise<unknown> | undefined,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-context-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const contexts: string[] = [];
  let count = 0;
  class Harness {
    constructor(readonly options: { cwd: string }) {}
    async start() {}
    async close() {}
    session(id = `mock-session-${++count}`) {
      return {
        id,
        run: async (prompt: unknown, observer: { onNotification: (note: unknown) => unknown }) => {
          expect(typeof prompt).toBe('string');
          contexts.push(await readFile(path.join(this.options.cwd, 'task-context.json'), 'utf8'));
          await emit?.(observer.onNotification, id);
          return { sessionId: id, finalResponse: `SYNTHETIC RESULT ${contexts.length}` };
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
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  };
  await settings.save({ apiKey: 'mock-context-key' });
  return { root, settings, contexts, options, models: new ModelRuns(options) };
}

test('model changes and restart recover an initial constraint beyond the last three turns', async () => {
  const value = await fixture();
  let models = value.models;
  const initial =
    'SYNTHETIC REQUIREMENT: currency=MOCK_UNIT; output=csv; preserve reference [mock-73].';
  try {
    for (const [index, prompt] of [
      initial,
      ...Array.from({ length: 6 }, (_, i) => `SYNTHETIC FOLLOWUP ${i}`),
    ].entries()) {
      await models.start('a', { requestId: `mock-turn-${index}`, prompt });
      await models.jobs.get('a')!.done;
    }
    await models.close();
    await value.settings.save({ apiKey: 'mock-context-key-v2' });
    models = new ModelRuns(value.options);
    await models.start('a', { requestId: 'mock-recovery', prompt: 'Continue the synthetic task.' });
    await models.jobs.get('a')!.done;
    const restored = value.contexts.at(-1)!;
    expect.assert(restored.includes(initial));
    expect(restored).toMatch(/mock-turn-|runId/);
    expect(restored.includes('mock-context-key')).toBe(false);
  } finally {
    await models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('only a committed root-session compaction checkpoint is saved and can be read as history', async () => {
  const value = await fixture(async (observer, session) => {
    const emit = (type: string, seq: number, data: unknown, extra: object = {}) =>
      observer({
        method: 'session.event',
        params: {
          sessionId: session,
          event: { type, seq, time: 1800000000000 + seq, data, ...extra },
        },
      });
    emit('compaction/start', 100, { compactionId: 'mock-compact', turn: 1 });
    emit('compaction/summary', 101, {
      compactionId: 'mock-compact',
      summary: [{ type: 'text', text: 'SYNTHETIC CHECKPOINT mock-context-key' }],
      rawOutput: [{ type: 'reasoning', text: 'SYNTHETIC PRIVATE REASONING' }],
      shadowedRange: { start: 1, end: 50 },
    });
    emit(
      'user/message',
      102,
      { content: [{ type: 'text', text: 'SYNTHETIC CHECKPOINT' }] },
      { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 50 }, sourceEventSeqs: [100, 101] },
    );
    emit('compaction/end', 103, { compactionId: 'mock-compact', turn: 1 });
    emit('compaction/start', 104, { compactionId: 'mock-failed', turn: 1 });
    emit('compaction/summary', 105, {
      compactionId: 'mock-failed',
      summary: [{ type: 'text', text: 'SYNTHETIC FAILED SUMMARY' }],
      shadowedRange: { start: 1, end: 50 },
    });
    emit('compaction/end', 106, {
      compactionId: 'mock-failed',
      turn: 1,
      error: 'SYNTHETIC CANCELLED',
    });
  });
  try {
    await value.models.start('a', {
      requestId: 'mock-checkpoint',
      prompt: 'Synthetic checkpoint task.',
    });
    const job = value.models.jobs.get('a')!;
    await job.done;
    const saved = await value.models.journal.read('a', job.id);
    expect.assert(saved && 'checkpoint' in saved);
    const json = JSON.stringify(saved.checkpoint);
    expect(json).toMatch(/SYNTHETIC CHECKPOINT/);
    expect(/PRIVATE REASONING|FAILED SUMMARY|mock-context-key/.test(json)).toBe(false);
    const result = await value.models.tools.history!.invoke(
      { bot: 'a', id: 'mock-next', abort: new AbortController() },
      'bot_history_read',
      { runId: job.id, field: 'checkpoint' },
    );
    expect(JSON.stringify(result)).toMatch(/SYNTHETIC CHECKPOINT/);
  } finally {
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('the current run can page a prior visible tool result without exposing private SDK events', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  let entered = () => {};
  const ready = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const text = 'SYNTHETIC OUTPUT '.repeat(1200) + 'EXACT_END_73';
  const value = await fixture(async (observer, session) => {
    const emit = (type: string, seq: number, data: unknown) =>
      observer({
        method: 'session.event',
        params: { sessionId: session, event: { type, seq, time: 1800000000000 + seq, data } },
      });
    emit('system/message', 1, { text: 'SYNTHETIC PRIVATE SYSTEM' });
    emit('tool/call', 2, { callId: 'mock-call', name: 'mock_tool', arguments: '{}' });
    emit('tool/result', 3, {
      message: { toolCallId: 'mock-call', content: [{ type: 'text', text }] },
    });
    entered();
    await gate;
  });
  try {
    await value.models.start('a', {
      requestId: 'mock-output',
      prompt: 'Read the synthetic output.',
    });
    await ready;
    const job = value.models.jobs.get('a')!;
    const history = value.models.tools.history!;
    const listed = (await history.invoke(job, 'bot_tool_result_read', {})) as {
      results: { seq: number; callId: string }[];
    };
    expect(listed.results).toStrictEqual([
      { seq: 2, callId: 'mock-call', isError: false, characters: text.length },
    ]);
    let offset = 0,
      content = '';
    do {
      const result = (await history.invoke(job, 'bot_tool_result_read', {
        seq: 2,
        offset,
        limit: 2000,
      })) as { content: string; nextOffset?: number; untrusted: boolean };
      expect(result.untrusted).toBe(true);
      expect.assert(Buffer.byteLength(JSON.stringify(result)) < 8192);
      content += result.content;
      if (result.nextOffset === undefined) break;
      expect.assert(result.nextOffset > offset);
      offset = result.nextOffset;
    } while (offset < 50000);
    expect(content).toBe(text);
    await expect(
      history.invoke({ ...job, bot: 'b' }, 'bot_tool_result_read', { runId: job.id, seq: 2 }),
    ).rejects.toMatchObject({ code: 'HISTORY_NOT_FOUND' });
    await expect(history.invoke(job, 'bot_tool_result_read', { seq: 1 })).rejects.toMatchObject({
      code: 'HISTORY_NOT_FOUND',
    });
    expect.assert(
      value.models.tools
        .list('a', job.model, undefined, job)
        .some((tool) => tool.name === 'bot_tool_result_read'),
    );
  } finally {
    release();
    await value.models.jobs.get('a')?.done;
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
