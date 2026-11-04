import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
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
  const prompts: string[] = [];
  let count = 0;
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-session-${++count}`) {
      return {
        id,
        run: async (prompt: unknown, observer: { onNotification: (note: unknown) => unknown }) => {
          prompts.push(String(prompt));
          await emit?.(observer.onNotification, id);
          return { sessionId: id, finalResponse: `SYNTHETIC RESULT ${prompts.length}` };
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
  return { root, settings, prompts, options, models: new ModelRuns(options) };
}

test('captures each accepted turn and settled state without storing source bodies', async () => {
  const value = await fixture();
  try {
    await value.models.start('a', {
      requestId: 'mock-context-turn',
      prompt: 'SYNTHETIC PRIVATE REQUEST',
    });
    const job = value.models.jobs.get('a')!;
    await job.done;
    const record = await value.models.journal.read('a', job.id);
    expect(record?.contextCaptures?.captures.map((capture) => capture.reason)).toEqual([
      'turn',
      'settled',
    ]);
    const source = record?.contextCaptures?.captures[0].sources[0];
    expect(source).toMatchObject({ evidence: 'estimated', membership: 'host-injected' });
    expect(source?.hostTokens).toBeGreaterThan(0);
    expect(record?.contextCaptures?.captures[0].sources[3].hostTokens).toBe(0);
    expect(record?.contextCaptures?.captures[0].sources[9].hostTokens).toBeGreaterThan(0);
    expect(JSON.stringify(record?.contextCaptures)).not.toMatch(
      /SYNTHETIC PRIVATE REQUEST|mock-context-key/,
    );
    expect(job.phase).toBe('completed');
  } finally {
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('accepts only current turn numeric projections and deduplicates each key independently', async () => {
  const replies: unknown[] = [];
  const value = await fixture(async (_observe, sessionId) => {
    const job = value.models.jobs.get('a')!;
    const params = {
      sessionId,
      turnId: 'mock-context-turn',
      key: 'contextPressure',
      seq: 0,
      value: { pressureTokens: 80, projectedTokens: 100 },
    };
    const update = (params: unknown, authorization = `Bearer ${job.token}`) =>
      value.models.rpc('a', authorization, { id: 1, method: 'context.update', params });
    replies.push(await update(params));
    replies.push(await update(params));
    replies.push(
      await update({
        ...params,
        key: 'contextBreakdown',
        value: { systemTokens: 2, toolsTokens: 3, messageTokens: 4 },
      }),
    );
    for (const invalid of [
      { ...params, turnId: 'mock-old-turn' },
      { ...params, sessionId: 'mock-child' },
      { ...params, rawOutput: 'SYNTHETIC PRIVATE' },
      { ...params, value: { pressureTokens: -1 } },
    ])
      await expect(update(invalid)).rejects.toMatchObject({ code: 'INVALID_CONTEXT_UPDATE' });
    await expect(update(params, 'Bearer mock-old-token')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  try {
    await value.models.start('a', { requestId: 'mock-context-turn', prompt: 'SYNTHETIC REQUEST' });
    const job = value.models.jobs.get('a')!;
    await job.done;
    expect(replies).toMatchObject([
      { result: { accepted: true } },
      { result: { accepted: false } },
      { result: { accepted: true } },
    ]);
    expect(job.phase).toBe('completed');
    const last = (await value.models.journal.read('a', job.id))?.contextCaptures?.captures.at(-1);
    expect(last).toMatchObject({
      pressure: { seq: 0, projectedTokens: 100 },
      breakdown: { seq: 0, messageTokens: 4 },
    });
  } finally {
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('a capture persistence failure does not stop or fail an otherwise successful task', async () => {
  const value = await fixture();
  const put = value.models.journal.put.bind(value.models.journal);
  let rejected = false;
  const spy = vi.spyOn(value.models.journal, 'put').mockImplementation(async (record) => {
    if (!rejected && record.contextCaptures?.captures.length) {
      rejected = true;
      throw new Error('SYNTHETIC CAPTURE WRITE FAILURE');
    }
    await put(record);
  });
  try {
    await value.models.start('a', {
      requestId: 'mock-capture-failure',
      prompt: 'SYNTHETIC REQUEST',
    });
    const job = value.models.jobs.get('a')!;
    await job.done;
    expect(rejected).toBe(true);
    expect(job.phase).toBe('completed');
    expect(await value.models.journal.read('a', job.id)).toHaveProperty(
      'contextCaptureFailed',
      true,
    );
  } finally {
    spy.mockRestore();
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('stopping while the turn capture is saving cannot start a later SDK run', async () => {
  const value = await fixture();
  const put = value.models.journal.put.bind(value.models.journal);
  let entered: () => unknown = () => {};
  let release: () => unknown = () => {};
  const waiting = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const paused = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const spy = vi.spyOn(value.models.journal, 'put').mockImplementation(async (record) => {
    if (record.contextCaptures?.captures.at(-1)?.reason === 'turn') {
      entered();
      await paused;
    }
    await put(record);
  });
  try {
    await value.models.start('a', {
      requestId: 'mock-stop-during-capture',
      prompt: 'SYNTHETIC REQUEST',
    });
    await waiting;
    const job = value.models.jobs.get('a')!;
    const stopping = value.models.stop('a');
    await vi.waitFor(() => expect(job.abort.signal.aborted).toBe(true));
    release();
    await stopping;
    expect(value.prompts).toHaveLength(0);
    expect(job.phase).toBe('stopped');
  } finally {
    release();
    spy.mockRestore();
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('compaction notifications delivered after cancellation cannot advertise a successful boundary', async () => {
  const value = await fixture(async (observe, sessionId) => {
    value.models.jobs.get('a')!.abort.abort();
    const event = (type: string, seq: number, data: unknown, extra: object = {}) =>
      observe({
        method: 'session.event',
        params: { sessionId, event: { type, seq, data, ...extra } },
      });
    event('compaction/start', 10, { compactionId: 'mock-cancelled', turn: 1 });
    event('compaction/summary', 11, {
      compactionId: 'mock-cancelled',
      summary: [{ type: 'text', text: 'SYNTHETIC SUMMARY' }],
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
    });
    event(
      'user/message',
      12,
      {},
      { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [10, 11] },
    );
    event('compaction/end', 13, { compactionId: 'mock-cancelled', turn: 1 });
  });
  try {
    await value.models.start('a', {
      requestId: 'mock-cancelled-boundary',
      prompt: 'SYNTHETIC REQUEST',
    });
    const job = value.models.jobs.get('a')!;
    await job.done;
    const record = await value.models.journal.read('a', job.id);
    expect(record?.checkpoint).toBeUndefined();
    expect(record?.contextCaptures?.captures.at(-1)?.boundary).toBeUndefined();
    expect(job.phase).toBe('stopped');
  } finally {
    await value.models.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

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
    const restored = value.prompts.at(-1)!;
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
