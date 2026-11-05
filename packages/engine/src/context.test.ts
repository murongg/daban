import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { CheckpointTracker, recoveryContext } from './checkpoint.js';
import { contextBudget, contextPrefix, recoveryBudget } from './context.js';
import { HistoryTools } from './history.js';
import { TaskJournal, type TaskRecord } from './tasks.js';

const row = (id: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({
  bot: 'mock-bot',
  runId: `mock-run-${id}`,
  kind: 'chat',
  prompt: `SYNTHETIC REQUEST ${id}`,
  result: `SYNTHETIC RESULT ${id}`,
  phase: 'completed',
  running: false,
  error: '',
  trace: [],
  createdAt: `2026-01-01T00:00:${id.padStart(2, '0')}Z`,
  ...extra,
});
const owner = {
  bot: 'mock-bot',
  runId: 'mock-current',
  chatRevision: 1,
  persona: 'mock-persona',
  redact: (value: string) => value.replaceAll('synthetic-secret', '[redacted]'),
};

test('committed boundaries use surface identities even when position endpoints descend', () => {
  const tracker = new CheckpointTracker('mock-session', (value) => value);
  const event = (type: string, seq: number, data: unknown, extra: object = {}) =>
    tracker.observe({
      method: 'session.event',
      params: { sessionId: 'mock-session', event: { type, seq, data, ...extra } },
    });
  event('compaction/start', 100, { compactionId: 'mock-summary', turn: 1 });
  event('compaction/summary', 101, {
    compactionId: 'mock-summary',
    summary: [{ type: 'text', text: 'SYNTHETIC SUMMARY' }],
    rawOutput: 'SYNTHETIC PRIVATE',
    shadowedRange: { start: 90, end: 20 },
    shadowedSeqs: [90, 10, 20],
  });
  expect(tracker.boundary).toBeUndefined();
  event(
    'user/message',
    102,
    {},
    { surfaceOp: { op: 'replace', startSeq: 90, endSeq: 20 }, sourceEventSeqs: [100, 101] },
  );
  expect(tracker.boundary).toBeUndefined();
  expect(event('compaction/end', 103, { compactionId: 'mock-summary', turn: 1 })).toMatchObject({
    sequence: 103,
  });
  expect(tracker.boundary).toEqual({
    kind: 'summary',
    endSeq: 103,
    shadowedSeqs: [90, 10, 20],
    omittedSeqs: 0,
  });
  expect(JSON.stringify(tracker.boundary)).not.toContain('SYNTHETIC');
  event('compaction/prune', 104, { shadowedRange: { start: 50, end: 50 }, shadowedSeqs: [50] });
  event(
    'tool/result',
    105,
    {},
    { surfaceOp: { op: 'replace', startSeq: 50, endSeq: 50 }, sourceEventSeqs: [50] },
  );
  expect(tracker.boundary).toEqual({
    kind: 'prune',
    endSeq: 105,
    shadowedSeqs: [50],
    omittedSeqs: 0,
  });
  const committed = tracker.boundary;
  event(
    'tool/result',
    105,
    {},
    { surfaceOp: { op: 'replace', startSeq: 50, endSeq: 50 }, sourceEventSeqs: [50] },
  );
  expect(tracker.boundary).toBe(committed);
});

test('partial and error references in a multi-turn checkpoint can be read through history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-checkpoint-reader-'));
  const journal = new TaskJournal(root);
  try {
    await journal.load();
    const saved = row('01', {
      chatRevision: 1,
      phase: 'failed',
      result: '',
      error: 'SYNTHETIC FAILURE '.repeat(1000),
      turns: [
        { id: 'mock-first', prompt: 'SYNTHETIC FIRST', result: 'SYNTHETIC ANSWER' },
        { id: 'mock-last', prompt: 'SYNTHETIC LAST', result: '' },
      ],
      response: {
        revision: 4,
        turnId: 'mock-last',
        state: 'streaming',
        text: 'SYNTHETIC PARTIAL '.repeat(1000),
      },
    });
    await journal.put(saved);
    const text = recoveryContext([saved], owner, 12000);
    const context = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
      recent: {
        partial?: { read: Record<string, unknown> };
        error?: { read: Record<string, unknown> };
      }[];
    };
    const history = new HistoryTools(journal);
    for (const field of ['partial', 'error'] as const) {
      const excerpt = context.recent.find((item) => item[field])?.[field];
      expect.assert(excerpt);
      const result = await history.invoke(
        { bot: owner.bot, id: owner.runId, abort: new AbortController() },
        'bot_history_read',
        excerpt.read,
      );
      expect.assert(
        JSON.stringify(result).includes(`SYNTHETIC ${field === 'partial' ? 'PARTIAL' : 'FAILURE'}`),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery reserves room for the current request and handles Unicode without splitting code points', () => {
  expect(() => contextBudget(16384, 16384)).toThrowError(
    expect.objectContaining({ code: 'MODEL_CONTEXT_BUDGET_INVALID' }),
  );
  expect(() => contextBudget(Number.NaN, 8192)).toThrowError(
    expect.objectContaining({ code: 'MODEL_CONTEXT_BUDGET_INVALID' }),
  );
  expect(recoveryBudget(16384, 8192, 'SYNTHETIC '.repeat(20000))).toBe(0);
  expect.assert(recoveryBudget(32768, 8192, '', 2) < recoveryBudget(32768, 8192, ''));
  expect(contextPrefix('prefix😀中文', 9)).toBe('prefix');
  expect(contextPrefix('prefix😀中文', 10)).toBe('prefix😀');
});

test('portable context stays inside Bot, group and cleared-chat boundaries and redacts task plans', () => {
  const text = recoveryContext(
    [
      row('01', { chatRevision: 0, prompt: 'SYNTHETIC CLEARED CHAT' }),
      row('02', { chatRevision: 1, prompt: 'SYNTHETIC CURRENT GOAL' }),
      row('03', { bot: 'mock-other', chatRevision: 1, prompt: 'SYNTHETIC OTHER BOT' }),
      row('04', { conversationId: 'mock-group', prompt: 'SYNTHETIC GROUP PRIVATE' }),
      row('05', {
        chatRevision: 1,
        phase: 'stopped',
        response: { revision: 1, text: 'SYNTHETIC UNFINISHED', state: 'settled' },
        plan: [{ content: 'SYNTHETIC PLAN synthetic-secret', status: 'in_progress' }],
      }),
    ],
    owner,
    16000,
  );
  expect(text).toMatch(/SYNTHETIC CURRENT GOAL/);
  expect(text).toMatch(/SYNTHETIC UNFINISHED/);
  expect(/CLEARED CHAT|OTHER BOT|GROUP PRIVATE|synthetic-secret/.test(text)).toBe(false);
  expect(text).toMatch(/"incomplete":true/);
});

test('a bounded recovery checkpoint marks omissions and keeps exact read-back references', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    row(String(i), { chatRevision: 1, result: '合成中文😀'.repeat(1000) }),
  );
  const text = recoveryContext(records, owner, 4000);
  expect.assert(Buffer.byteLength(text) <= 4000);
  expect(text).toMatch(/"truncated":true/);
  expect(text).toMatch(/"field":"result"/);
  expect(text).toMatch(/bot_history_read/);
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
    omittedCount: number;
    recent: unknown[];
  };
  expect.assert(data.omittedCount > 0);
  expect.assert(data.recent.length > 0);
});

test('recovery keeps every inserted turn of a finished run in chronological order', () => {
  const text = recoveryContext(
    [
      row('01', {
        chatRevision: 1,
        prompt: 'SYNTHETIC ORIGINAL',
        result: 'SYNTHETIC FINAL',
        turns: [
          { id: 'mock-turn-a', prompt: 'SYNTHETIC ORIGINAL', result: 'SYNTHETIC ANSWER A' },
          { id: 'mock-turn-b', prompt: 'SYNTHETIC INSERT', result: 'SYNTHETIC ANSWER B' },
        ],
      }),
    ],
    owner,
    16000,
  );
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
    omittedCount: number;
    recent: {
      request: { text: string; read: { turn?: number } };
      answer?: { text: string };
    }[];
  };
  expect(data.omittedCount).toBe(0);
  expect(data.recent.map((item) => [item.request.text, item.answer?.text])).toStrictEqual([
    ['SYNTHETIC ORIGINAL', 'SYNTHETIC ANSWER A'],
    ['SYNTHETIC INSERT', 'SYNTHETIC ANSWER B'],
  ]);
  expect(data.recent.map((item) => item.request.read.turn)).toStrictEqual([0, 1]);
});

test('old persona summaries do not reintroduce removed preferences into a rebuilt context', () => {
  const text = recoveryContext(
    [
      row('01', {
        chatRevision: 1,
        sessionPersona: 'old-persona',
        checkpoint: { version: 1, sequence: 12, text: 'SYNTHETIC RETIRED PERSONA' },
      }),
    ],
    owner,
    16000,
  );
  expect(text.includes('RETIRED PERSONA')).toBe(false);
});

test('the journal reloads valid checkpoints and discards corrupt optional checkpoints without losing history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-checkpoint-journal-'));
  try {
    const journal = new TaskJournal(root);
    await journal.load();
    await journal.put(
      row('01', { checkpoint: { version: 1, sequence: 7, text: 'SYNTHETIC SAVED CHECKPOINT' } }),
    );
    await writeFile(
      path.join(root, 'mock-run-02.json'),
      JSON.stringify({
        version: 1,
        task: row('02', {
          checkpoint: {
            version: 1,
            sequence: 9,
            text: '',
            rawOutput: 'SYNTHETIC PRIVATE',
          } as unknown as TaskRecord['checkpoint'],
        }),
      }),
    );
    const reopened = new TaskJournal(root);
    await reopened.load();
    expect((await reopened.read('mock-bot', 'mock-run-01'))?.checkpoint?.text).toBe(
      'SYNTHETIC SAVED CHECKPOINT',
    );
    expect((await reopened.read('mock-bot', 'mock-run-02'))?.checkpoint).toBe(undefined);
    expect((await reopened.read('mock-bot', 'mock-run-02'))?.prompt).toBe(row('02').prompt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('foreign, failed and incomplete compaction transactions never become recovery checkpoints', () => {
  const tracker = new CheckpointTracker('mock-session', (value) => value);
  const event = (
    type: string,
    seq: number,
    data: unknown,
    session = 'mock-session',
    extra: object = {},
  ) =>
    tracker.observe({
      method: 'session.event',
      params: { sessionId: session, event: { type, seq, data, ...extra } },
    });
  expect(
    event('compaction/start', 1, { compactionId: 'mock-foreign', turn: 1 }, 'mock-other'),
  ).toBe(undefined);
  expect(
    event('compaction/summary', 2, {
      compactionId: 'mock-foreign',
      summary: [{ type: 'text', text: 'SYNTHETIC FOREIGN' }],
    }),
  ).toBe(undefined);
  event('compaction/start', 3, { compactionId: 'mock-incomplete', turn: 1 });
  event('compaction/summary', 4, {
    compactionId: 'mock-incomplete',
    summary: [{ type: 'text', text: 'SYNTHETIC UNCOMMITTED' }],
    shadowedRange: { start: 0, end: 2 },
  });
  expect(event('compaction/end', 5, { compactionId: 'mock-incomplete', turn: 1 })).toBe(undefined);
});
