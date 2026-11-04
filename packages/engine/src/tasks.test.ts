import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { agentInstructionsFor } from './tasks.js';

test('full guest instructions describe VM sudo and host approval without exposing host execution', () => {
  const prompt = agentInstructionsFor(true);
  expect(prompt).toMatch(/passwordless sudo/);
  expect(prompt).toMatch(/npm/);
  expect(prompt).toMatch(/process_start/);
  expect(prompt).toMatch(/approval.*outside the VM/);
  expect(prompt).not.toMatch(
    /installation requires software_install|without credentials or network/,
  );
  expect(agentInstructionsFor(false)).toMatch(/installation requires software_install/);
});

import { captureContext, contextSources, emptyContextArchive } from './context-inspector.js';
import { TaskJournal, taskPrompt, validateTask } from './tasks.js';
import { WorkspaceFiles } from './workspace.js';

test('journal preserves bounded captures across restart and isolates a corrupt archive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-journal-'));
  const captures = captureContext(emptyContextArchive(), {
    at: '2026-01-01T00:00:00.000Z',
    reason: 'turn',
    coverage: 'partial',
    turnId: 'mock-turn',
    estimator: 'daban-text-v1',
    configuredWindow: 16384,
    configuredOutput: 1024,
    sources: contextSources({ request: 'SYNTHETIC REQUEST' }),
    gaps: ['sdk-envelope'],
  });
  const record = {
    bot: 'mock-bot',
    runId: 'mock-run',
    chatRevision: 0,
    kind: 'chat' as const,
    phase: 'completed',
    running: false,
    prompt: 'SYNTHETIC REQUEST',
    result: 'SYNTHETIC RESULT',
    error: '',
    trace: [],
    contextCaptures: captures,
  };
  try {
    const journal = new TaskJournal(root);
    await journal.put(record);
    expect(await journal.read(record.bot, record.runId)).toHaveProperty(
      'contextCaptures',
      captures,
    );
    const loaded = new TaskJournal(root);
    await loaded.load();
    expect(await loaded.read(record.bot, record.runId)).toHaveProperty('contextCaptures', captures);
    await writeFile(
      path.join(root, `${record.runId}.json`),
      JSON.stringify({
        version: 1,
        task: {
          ...record,
          contextCaptures: { ...captures, nextRevision: 0 },
        },
      }),
    );
    const corrupt = new TaskJournal(root);
    await corrupt.load();
    expect(await corrupt.read(record.bot, record.runId)).toMatchObject({
      result: record.result,
      contextCaptureFailed: true,
    });
    expect(await corrupt.read(record.bot, record.runId)).not.toHaveProperty('contextCaptures');
    const invalid = { ...record, contextCaptures: { ...captures, nextRevision: 0 } };
    await expect(journal.put(invalid)).rejects.toMatchObject({ code: 'INVALID_CONTEXT_CAPTURE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task approval mode accepts only the three explicit user policies', () => {
  const task = { requestId: 'mock-policy-request', prompt: 'Synthetic task' };
  for (const approvalMode of ['ask', 'auto', 'full'])
    expect(validateTask({ ...task, approvalMode })).toEqual({ ...task, approvalMode });
  for (const approvalMode of ['never', null, true, {}, ''])
    expect(() => validateTask({ ...task, approvalMode })).toThrowError();
});

test('a continuation turn requires a bounded retry reference', () => {
  const input = {
    requestId: 'mock-retry-request',
    prompt: 'SYNTHETIC REQUEST',
    retryOf: 'mock-run',
    retryTurn: 'mock-turn',
  };
  expect(validateTask(input)).toStrictEqual(input);
  for (const invalid of [
    { ...input, retryOf: undefined },
    { ...input, retryTurn: '../foreign' },
  ]) {
    expect(() => validateTask(invalid)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TASK' }),
    );
  }
});

test('workspace downloads preserve binary bytes, reject escapes and refuse invalid UTF-8 text previews', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-download-'));
  try {
    const files = new WorkspaceFiles(root);
    const bytes = Buffer.from([37, 80, 68, 70, 45, 255, 0, 128]);
    await writeFile(path.join(root, 'mock.pdf'), bytes);
    const downloaded = await files.download('mock.pdf');
    expect(Buffer.from(downloaded.data, 'base64').equals(bytes)).toBe(true);
    expect(downloaded.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(files.download('../escape.pdf')).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await symlink('/etc/passwd', path.join(root, 'link.pdf'));
    await expect(files.download('link.pdf')).rejects.toMatchObject({ code: 'FILE_NOT_READABLE' });
    await writeFile(path.join(root, 'bad.txt'), Buffer.from([255, 128]));
    await expect(files.read('bad.txt')).rejects.toMatchObject({ code: 'FILE_NOT_TEXT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('request deduplication reaches records older than the bounded UI history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-old-history-'));
  try {
    const store = new TaskJournal(dir);
    await store.load();
    for (let i = 0; i < 135; i++)
      await store.put({
        bot: 'a',
        runId: `mock-history-${String(i).padStart(4, '0')}`,
        requestId: `mock-request-${i}`,
        prompt: `合成任务 ${i}`,
        phase: 'completed',
        running: false,
        result: `合成结果 ${i}`,
        error: '',
        trace: [],
      });
    expect(store.history('a').length).toBe(100);
    expect(store.findRequest('a', 'mock-request-0')?.runId).toBe('mock-history-0000');
    expect(store.findRequest('b', 'mock-request-0')).toBe(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed journal write is never published as durable history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-journal-failure-'));
  try {
    const store = new TaskJournal(dir);
    await store.load();
    await mkdir(path.join(dir, 'mock-failed.json.tmp'));
    await expect(
      store.put({
        bot: 'a',
        runId: 'mock-failed',
        requestId: 'mock-uncommitted',
        prompt: '合成未提交',
        phase: 'completed',
        running: false,
        result: '不得作为成功证据',
        error: '',
        trace: [],
      }),
    ).rejects.toThrowError();
    expect(store.history('a').length).toBe(0);
    expect(store.findRequest('a', 'mock-uncommitted')).toBe(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('freeform requests preserve actual user instructions and reject unsafe or oversized inputs', () => {
  const input = {
    requestId: 'mock-task-1',
    prompt: '请根据实际输入 CSV 输出 summary.md',
    memory: '先给结论',
    files: [{ name: 'synthetic.csv', content: 'kind,value\nmock,3' }],
  };
  expect(validateTask(input)).toStrictEqual(input);
  const prompt = taskPrompt('a', '/synthetic/run-1', input);
  expect.assert(prompt.includes(input.prompt));
  expect.assert(prompt.includes(input.memory));
  expect.assert(!prompt.includes('paid_count'));
  for (const bad of [
    { ...input, prompt: '' },
    { ...input, requestId: '../escape' },
    { ...input, files: [{ name: '../secret', content: '' }] },
    {
      ...input,
      files: [
        { name: 'same', content: '' },
        { name: 'same', content: 'x' },
      ],
    },
  ])
    expect(() => validateTask(bad)).toThrowError();
});

test('durable task history recovers interrupted work and never stores capability fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-journal-'));
  try {
    const store = new TaskJournal(dir);
    await store.load();
    await store.put({
      bot: 'a',
      runId: 'run-1',
      requestId: 'request-1',
      prompt: '合成任务',
      phase: 'running',
      running: true,
      result: '',
      error: '',
      sessionId: 'mock-session',
      token: 'synthetic-capability',
      trace: [],
      response: { revision: 7, text: '合成崩溃前已提交的回复', state: 'streaming' },
    });
    const recovered = new TaskJournal(dir);
    await recovered.load();
    const task = recovered.history('a')[0];
    expect(task.phase).toBe('interrupted');
    expect(task.running).toBe(false);
    expect(task.sessionId).toBe('mock-session');
    expect(task.response?.text).toBe('合成崩溃前已提交的回复');
    expect('token' in task).toBe(false);
    expect(recovered.findRequest('a', 'request-1')?.runId).toBe('run-1');
    expect(recovered.findRequest('b', 'request-1')).toBe(undefined);
    await store.put({
      ...task,
      runId: 'run-waiting',
      requestId: 'request-waiting',
      phase: 'waiting',
      running: false,
      plan: [{ content: '等待合成回答', status: 'in_progress' }],
    });
    const waiting = new TaskJournal(dir);
    await waiting.load();
    expect(waiting.findRequest('a', 'request-waiting')?.phase).toBe('interrupted');
    expect(waiting.findRequest('a', 'request-waiting')?.plan?.[0].content).toBe('等待合成回答');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace reads actual nested files while rejecting traversal, symlink escape and oversized output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-workspace-'));
  try {
    await mkdir(path.join(root, 'run-1'));
    await writeFile(path.join(root, 'run-1/summary.md'), '# 合成结果\n数量=3');
    await symlink('/etc/hosts', path.join(root, 'escape.txt'));
    const files = new WorkspaceFiles(root);
    const listed = await files.list();
    expect.assert(listed.some((f) => f.path === 'run-1/summary.md'));
    expect.assert(!listed.some((f) => f.path === 'escape.txt'));
    expect((await files.read('run-1/summary.md')).content).toBe('# 合成结果\n数量=3');
    await expect(files.read('../credentials.json')).rejects.toThrowError();
    await expect(files.read('escape.txt')).rejects.toThrowError();
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    await expect(files.read('large.txt')).rejects.toThrowError();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('the turn carries current computer availability rather than advertising unavailable tools', () => {
  const input = { requestId: 'mock-capabilities', prompt: '你有什么功能' };
  expect(taskPrompt('chief', '/synthetic/run', input)).toMatch(/No computer is connected/);
  expect(taskPrompt('a', '/synthetic/run', input, [], true)).toMatch(/A computer is connected/);
});
