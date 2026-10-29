import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskJournal, taskPrompt, validateTask } from './tasks.js';
import { WorkspaceFiles } from './workspace.js';

test('workspace downloads preserve binary bytes, reject escapes and refuse invalid UTF-8 text previews', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-download-'));
  try {
    const files = new WorkspaceFiles(root);
    const bytes = Buffer.from([37, 80, 68, 70, 45, 255, 0, 128]);
    await writeFile(path.join(root, 'mock.pdf'), bytes);
    const downloaded = await files.download('mock.pdf');
    assert.equal(Buffer.from(downloaded.data, 'base64').equals(bytes), true);
    assert.equal(downloaded.sha256, createHash('sha256').update(bytes).digest('hex'));
    await assert.rejects(files.download('../escape.pdf'), { code: 'INVALID_FILE' });
    await symlink('/etc/passwd', path.join(root, 'link.pdf'));
    await assert.rejects(files.download('link.pdf'), { code: 'FILE_NOT_READABLE' });
    await writeFile(path.join(root, 'bad.txt'), Buffer.from([255, 128]));
    await assert.rejects(files.read('bad.txt'), { code: 'FILE_NOT_TEXT' });
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
    assert.equal(store.history('a').length, 100);
    assert.equal(store.findRequest('a', 'mock-request-0')?.runId, 'mock-history-0000');
    assert.equal(store.findRequest('b', 'mock-request-0'), undefined);
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
    await assert.rejects(
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
    );
    assert.equal(store.history('a').length, 0);
    assert.equal(store.findRequest('a', 'mock-uncommitted'), undefined);
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
  assert.deepEqual(validateTask(input), input);
  const prompt = taskPrompt('a', '/synthetic/run-1', input);
  assert.ok(prompt.includes(input.prompt));
  assert.ok(prompt.includes(input.memory));
  assert.ok(!prompt.includes('paid_count'));
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
    assert.throws(() => validateTask(bad));
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
    assert.equal(task.phase, 'interrupted');
    assert.equal(task.running, false);
    assert.equal(task.sessionId, 'mock-session');
    assert.equal(task.response?.text, '合成崩溃前已提交的回复');
    assert.equal('token' in task, false);
    assert.equal(recovered.findRequest('a', 'request-1')?.runId, 'run-1');
    assert.equal(recovered.findRequest('b', 'request-1'), undefined);
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
    assert.equal(waiting.findRequest('a', 'request-waiting')?.phase, 'interrupted');
    assert.equal(waiting.findRequest('a', 'request-waiting')?.plan?.[0].content, '等待合成回答');
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
    assert.ok(listed.some((f) => f.path === 'run-1/summary.md'));
    assert.ok(!listed.some((f) => f.path === 'escape.txt'));
    assert.equal((await files.read('run-1/summary.md')).content, '# 合成结果\n数量=3');
    await assert.rejects(files.read('../credentials.json'));
    await assert.rejects(files.read('escape.txt'));
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(files.read('large.txt'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('the turn carries current computer availability rather than advertising unavailable tools', () => {
  const input = { requestId: 'mock-capabilities', prompt: '你有什么功能' };
  assert.match(taskPrompt('chief', '/synthetic/run', input), /当前未连接电脑/);
  assert.match(taskPrompt('a', '/synthetic/run', input, [], true), /当前已连接电脑/);
});
