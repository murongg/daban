import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskJournal, type TaskRecord } from './tasks.js';

test('completion metadata includes durable between-poll private results across contexts without content, active jobs or diagnostic runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notice-journal-'));
  let journal = new TaskJournal(root);
  const record: TaskRecord = {
    bot: 'mock-alpha',
    runId: 'mock-result',
    requestId: 'mock-request',
    kind: 'chat',
    prompt: 'SYNTHETIC PRIVATE PROMPT',
    phase: 'completed',
    running: false,
    result: 'SYNTHETIC PRIVATE ANSWER',
    error: '',
    trace: [],
    chatRevision: 2,
  };
  try {
    await journal.load();
    await journal.put(record);
    await journal.put({ ...record, runId: 'mock-active', running: true });
    await journal.put({ ...record, runId: 'mock-diagnostic', kind: 'acceptance' });
    await journal.put({ ...record, runId: 'mock-group', conversationId: 'mock-crew' });
    await journal.put({ ...record, runId: 'mock-stopped', phase: 'stopped' });
    const expected = [
      { kind: 'task', id: record.runId, bot: record.bot, chatRevision: 2, phase: 'completed' },
    ];
    assert.deepEqual(journal.notices(), expected);
    assert.ok(!JSON.stringify(journal.notices()).includes('SYNTHETIC PRIVATE'));
    journal = new TaskJournal(root);
    await journal.load();
    assert.ok(journal.notices().some((item) => item.id === record.runId));
    await journal.put({ ...record, runId: 'mock-failed', phase: 'failed' });
    assert.ok(
      journal.notices().some((item) => item.id === 'mock-failed' && item.phase === 'failed'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
