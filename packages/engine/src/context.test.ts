import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CheckpointTracker, recoveryContext } from './checkpoint.js';
import { contextBudget, contextPrefix, recoveryBudget } from './context.js';
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

test('recovery reserves room for the current request and handles Unicode without splitting code points', () => {
  assert.throws(() => contextBudget(16384, 16384), { code: 'MODEL_CONTEXT_BUDGET_INVALID' });
  assert.throws(() => contextBudget(Number.NaN, 8192), { code: 'MODEL_CONTEXT_BUDGET_INVALID' });
  assert.equal(recoveryBudget(16384, 8192, 'SYNTHETIC '.repeat(20000)), 0);
  assert.ok(recoveryBudget(32768, 8192, '', 2) < recoveryBudget(32768, 8192, ''));
  assert.equal(contextPrefix('prefix😀中文', 9), 'prefix');
  assert.equal(contextPrefix('prefix😀中文', 10), 'prefix😀');
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
  assert.match(text, /SYNTHETIC CURRENT GOAL/);
  assert.match(text, /SYNTHETIC UNFINISHED/);
  assert.equal(/CLEARED CHAT|OTHER BOT|GROUP PRIVATE|synthetic-secret/.test(text), false);
  assert.match(text, /"incomplete":true/);
});

test('a bounded recovery checkpoint marks omissions and keeps exact read-back references', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    row(String(i), { chatRevision: 1, result: '合成中文😀'.repeat(1000) }),
  );
  const text = recoveryContext(records, owner, 4000);
  assert.ok(Buffer.byteLength(text) <= 4000);
  assert.match(text, /"truncated":true/);
  assert.match(text, /"field":"result"/);
  assert.match(text, /bot_history_read/);
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
    omittedCount: number;
    recent: unknown[];
  };
  assert.ok(data.omittedCount > 0);
  assert.ok(data.recent.length > 0);
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
  assert.equal(text.includes('RETIRED PERSONA'), false);
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
    assert.equal(
      (await reopened.read('mock-bot', 'mock-run-01'))?.checkpoint?.text,
      'SYNTHETIC SAVED CHECKPOINT',
    );
    assert.equal((await reopened.read('mock-bot', 'mock-run-02'))?.checkpoint, undefined);
    assert.equal((await reopened.read('mock-bot', 'mock-run-02'))?.prompt, row('02').prompt);
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
  assert.equal(
    event('compaction/start', 1, { compactionId: 'mock-foreign', turn: 1 }, 'mock-other'),
    undefined,
  );
  assert.equal(
    event('compaction/summary', 2, {
      compactionId: 'mock-foreign',
      summary: [{ type: 'text', text: 'SYNTHETIC FOREIGN' }],
    }),
    undefined,
  );
  event('compaction/start', 3, { compactionId: 'mock-incomplete', turn: 1 });
  event('compaction/summary', 4, {
    compactionId: 'mock-incomplete',
    summary: [{ type: 'text', text: 'SYNTHETIC UNCOMMITTED' }],
    shadowedRange: { start: 0, end: 2 },
  });
  assert.equal(event('compaction/end', 5, { compactionId: 'mock-incomplete', turn: 1 }), undefined);
});
