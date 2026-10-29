import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Interactions } from './interactions.js';

test('health keeps corrupt interaction records private and retained', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-interaction-health-'));
  try {
    await writeFile(path.join(dir, 'mock-corrupt.json'), 'SYNTHETIC-INVALID-INTERACTION');
    const store = new Interactions(dir);
    assert.deepEqual(await store.status(), { available: true, corrupt: 1 });
    assert.equal(
      await readFile(path.join(dir, 'mock-corrupt.json'), 'utf8'),
      'SYNTHETIC-INVALID-INTERACTION',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const question = {
  id: 'mock-question',
  sessionId: 'mock-session',
  kind: 'question' as const,
  questions: [
    {
      id: 'format',
      question: '合成输出格式？',
      options: [{ label: 'Markdown' }, { label: '纯文本' }],
    },
  ],
};
const answer = { kind: 'answer' as const, answers: [{ id: 'format', selected: ['Markdown'] }] };
test('external MCP approval keeps exact Bot/run/session/connection/tool/argument provenance and never authorizes a different request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-mcp-approval-'));
  const store = new Interactions(directory);
  const input = {
    id: 'mock-mcp-approval',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'mcp_call',
    connection: 'mock-connection',
    configRevision: 2,
    catalogDigest: 'a'.repeat(64),
    name: '合成连接',
    origin: 'https://mcp.example.test',
    operation: 'synthetic_echo',
    arguments: '{"value":47}',
    inputHash: 'b'.repeat(64),
  };
  try {
    const opened = await store.open('mock-bot', 'mock-run', input, 'mock-group');
    assert.equal(opened.status, 'pending');
    await assert.rejects(
      store.open('mock-bot', 'mock-run', { ...input, arguments: '{"value":48}' }, 'mock-group'),
      { code: 'INTERACTION_CONFLICT' },
    );
    await assert.rejects(
      store.reply('mock-other', 'mock-run', input.id, { kind: 'decision', allow: true }),
      { code: 'INTERACTION_NOT_FOUND' },
    );
    const allowed = await store.reply('mock-bot', 'mock-run', input.id, {
      kind: 'decision',
      allow: true,
    });
    assert.equal(allowed.reply?.kind, 'decision');
    const restored = new Interactions(directory);
    assert.equal((await restored.list())[0].conversationId, 'mock-group');
  } finally {
    await store.endRun('mock-bot', 'mock-run');
    await rm(directory, { recursive: true, force: true });
  }
});

test('an aborted interaction waiter drains immediately without waiting for the long-poll timer or changing another decision', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-interaction-abort-'));
  const store = new Interactions(directory);
  try {
    await store.open('mock-bot', 'mock-run', question);
    const abort = new AbortController();
    let cancelled = false;
    const wait = Reflect.apply(store.wait, store, [
      'mock-bot',
      'mock-run',
      question.id,
      abort.signal,
    ]).catch(() => {
      cancelled = true;
    });
    abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.equal((await store.list())[0].status, 'pending');
    await store.endRun('mock-bot', 'mock-run');
    await wait;
  } finally {
    await store.endRun('mock-bot', 'mock-run');
    await rm(directory, { recursive: true, force: true });
  }
});
test('question records retain authoritative conversation provenance across restart and exact replies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-group-question-scope-'));
  try {
    const store = new Interactions(directory);
    await store.ready;
    const item = await store.open('mock-bot', 'mock-run', question, 'mock-group');
    assert.ok('conversationId' in item);
    assert.equal(item.conversationId, 'mock-group');
    await assert.rejects(store.open('mock-bot', 'mock-run', question, 'other-group'), {
      code: 'INTERACTION_CONFLICT',
    });
    await store.reply('mock-bot', 'mock-run', question.id, answer);
    const recovered = new Interactions(directory);
    await recovered.ready;
    assert.ok('conversationId' in (await recovered.list())[0]);
    assert.equal((await recovered.list())[0].status, 'resolved');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('questions persist before waiting, accept one exact answer and reject conflicting or foreign replies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-interactions-'));
  try {
    const store = new Interactions(directory);
    await store.ready;
    const opened = await store.open('mock-bot', 'mock-run', question);
    assert.equal(opened.status, 'pending');
    assert.equal((await lstat(path.join(directory, 'mock-question.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await store.open('mock-bot', 'mock-run', question), opened);
    await assert.rejects(
      store.open('mock-bot', 'mock-run', {
        ...question,
        questions: [{ id: 'other', question: '另一项合成问题？' }],
      }),
      { code: 'INTERACTION_CONFLICT' },
    );
    const waiting = store.wait('mock-bot', 'mock-run', question.id);
    await assert.rejects(store.reply('other-bot', 'mock-run', question.id, answer), {
      code: 'INTERACTION_NOT_FOUND',
    });
    await assert.rejects(store.reply('mock-bot', 'other-run', question.id, answer), {
      code: 'INTERACTION_NOT_FOUND',
    });
    await assert.rejects(
      store.reply('mock-bot', 'mock-run', question.id, {
        kind: 'answer',
        answers: [{ id: 'format', selected: ['invented'] }],
      }),
      { code: 'INVALID_INTERACTION_REPLY' },
    );
    const saved = await store.reply('mock-bot', 'mock-run', question.id, answer);
    assert.equal(saved.status, 'resolved');
    assert.deepEqual((await waiting).reply, answer);
    assert.deepEqual(await store.reply('mock-bot', 'mock-run', question.id, answer), saved);
    await assert.rejects(
      store.reply('mock-bot', 'mock-run', question.id, {
        kind: 'answer',
        answers: [{ id: 'format', selected: ['纯文本'] }],
      }),
      { code: 'INTERACTION_CONFLICT' },
    );
    assert.deepEqual((await new Interactions(directory).list())[0].reply, answer);
    await store.endRun('mock-bot', 'mock-run');
    await assert.rejects(store.open('mock-bot', 'mock-run', question), {
      code: 'INTERACTION_CLOSED',
    });
    await assert.rejects(new Interactions(directory).open('mock-bot', 'mock-run', question), {
      code: 'INTERACTION_CLOSED',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('one-shot approvals are interrupted on restart and cannot be granted by late replies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-approvals-'));
  try {
    const store = new Interactions(directory);
    const request = {
      id: 'mock-approval',
      sessionId: 'mock-session',
      kind: 'approval' as const,
      tool: 'web_fetch' as const,
      url: 'https://example.test/new-page',
    };
    await store.open('mock-bot', 'mock-run', request);
    const restarted = new Interactions(directory);
    await restarted.ready;
    assert.equal((await restarted.list())[0].status, 'interrupted');
    await assert.rejects(
      restarted.reply('mock-bot', 'mock-run', request.id, { kind: 'decision', allow: true }),
      { code: 'INTERACTION_CLOSED' },
    );
    const another = { ...request, id: 'mock-reject' };
    await restarted.open('mock-bot', 'next-run', another);
    assert.equal(
      (
        await restarted.reply('mock-bot', 'next-run', another.id, {
          kind: 'decision',
          allow: false,
        })
      ).reply?.kind,
      'decision',
    );
    const pending = { ...request, id: 'mock-stop' };
    await restarted.open('mock-bot', 'cancelled-run', pending);
    const waiting = restarted.wait('mock-bot', 'cancelled-run', pending.id);
    await restarted.endRun('mock-bot', 'cancelled-run');
    assert.equal((await waiting).status, 'cancelled');
    await assert.rejects(
      restarted.open('mock-bot', 'cancelled-run', { ...pending, id: 'mock-late' }),
      { code: 'INTERACTION_CLOSED' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('interaction boundaries reject unknown fields, corrupt records and bad answer shapes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-request-boundary-'));
  try {
    const store = new Interactions(directory);
    for (const input of [
      { ...question, credentials: 'mock-secret' },
      { ...question, id: '../escape' },
      { ...question, questions: [] },
      { ...question, questions: [question.questions[0], question.questions[0]] },
      { ...question, kind: 'approval', tool: 'shell', url: 'https://example.test/' },
    ])
      await assert.rejects(store.open('mock-bot', 'mock-run', input), {
        code: 'INVALID_INTERACTION',
      });
    await store.open('mock-bot', 'mock-run', question);
    for (const reply of [
      { kind: 'decision', allow: true },
      { ...answer, credentials: 'mock-secret' },
      { kind: 'answer', answers: [] },
      { kind: 'answer', answers: [{ id: 'format', selected: ['Markdown', '纯文本'] }] },
    ])
      await assert.rejects(store.reply('mock-bot', 'mock-run', question.id, reply), {
        code: 'INVALID_INTERACTION_REPLY',
      });
    await writeFile(path.join(directory, 'mock-corrupt.json'), '{broken');
    const reloaded = new Interactions(directory);
    await assert.rejects(
      reloaded.open('mock-bot', 'mock-next', { ...question, id: 'mock-corrupt' }),
      { code: 'INTERACTION_CORRUPT' },
    );
    assert.equal(await readFile(path.join(directory, 'mock-corrupt.json'), 'utf8'), '{broken');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a stop racing an uncommitted reply closes the pending request without granting it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-stop-reply-'));
  try {
    const store = new Interactions(directory);
    await store.open('mock-bot', 'mock-run', {
      id: 'mock-stop',
      sessionId: 'mock-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/',
    });
    const reply = store.reply('mock-bot', 'mock-run', 'mock-stop', {
      kind: 'decision',
      allow: true,
    });
    const stop = store.endRun('mock-bot', 'mock-run');
    await assert.rejects(reply, { code: 'INTERACTION_CLOSED' });
    await stop;
    assert.equal((await store.list())[0].status, 'cancelled');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a stop during asynchronous decision persistence never publishes the permission grant', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-stop-commit-'));
  try {
    const store = new Interactions(directory);
    await store.open('mock-bot', 'mock-run', {
      id: 'mock-stop-io',
      sessionId: 'mock-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/',
    });
    const reply = store.reply('mock-bot', 'mock-run', 'mock-stop-io', {
      kind: 'decision',
      allow: true,
    });
    // Enter the async commit without allowing filesystem callbacks to complete.
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    const stopping = store.endRun('mock-bot', 'mock-run');
    await assert.rejects(reply, { code: 'INTERACTION_CLOSED' });
    await stopping;
    assert.equal((await store.list())[0].status, 'cancelled');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
