import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TranscriptScope } from '@daban/protocol';
import { redact } from './redaction.js';
import { projectInteraction, projectTranscript, Transcripts } from './transcripts.js';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const note = (seq: number, type: string, data: unknown, session = 'mock-session') => ({
  method: 'session.event',
  params: { sessionId: session, event: { seq, type, time: 1800000000000 + seq, data } },
});
const call = (seq = 1, text = '{"path":"/workspace/synthetic.txt"}') =>
  note(seq, 'tool/call', {
    callId: `mock-call-${seq}`,
    name: 'computer__read_file',
    arguments: text,
  });

test('VM command approvals retain their exact guest context in redacted transcripts', () => {
  const event = projectInteraction(
    {
      id: 'mock-command',
      bot: 'mock-bot',
      runId: 'mock-run',
      sessionId: 'mock-session',
      kind: 'approval',
      tool: 'vm_command',
      command: 'echo mock-secret',
      cwd: '/mock-guest/task',
      purpose: 'Synthetic command',
      target: 'linux-vm',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    (text) => text.replaceAll('mock-secret', '[redacted]'),
  );
  const body = JSON.parse(event.text);
  assert.equal(body.command, 'echo [redacted]');
  assert.equal(body.cwd, '/mock-guest/task');
  assert.equal(body.target, 'linux-vm');
});

test('transcript projection admits only owned visible events and excludes private streams and binary bodies', () => {
  const safe = (value: string) => redact(value, ['mock-provider-key', 'mock-capability']);
  assert.equal(projectTranscript(call(), 'foreign-session', safe), undefined);
  for (const type of ['system/message', 'developer/message', 'request/header', 'assistant/attempt'])
    assert.equal(
      projectTranscript(note(1, type, { text: 'SYNTHETIC PRIVATE' }), 'mock-session', safe),
      undefined,
    );
  const entry = projectTranscript(
    call(1, '{"command":"mock-provider-key mock-capability"}'),
    'mock-session',
    safe,
  )!;
  assert.equal(entry.kind, 'call');
  assert.equal(entry.name, 'computer__read_file');
  assert.equal(entry.text.includes('mock-provider-key'), false);
  assert.equal(entry.text.includes('mock-capability'), false);
  const result = projectTranscript(
    note(2, 'tool/result', {
      message: {
        toolCallId: 'mock-call-1',
        isError: true,
        content: [
          { type: 'text', text: '合成结果 mock-provider-key' },
          { type: 'image', mimeType: 'image/png', data: 'SYNTHETIC-BASE64' },
        ],
      },
      error: { code: 'MOCK_DENIED', reason: 'SYNTHETIC INTERNAL' },
      meta: { capability: 'SYNTHETIC PRIVATE META' },
    }),
    'mock-session',
    safe,
  )!;
  assert.equal(result.kind, 'result');
  assert.equal(result.isError, true);
  assert.equal(result.code, 'MOCK_DENIED');
  assert.ok(result.text.includes('合成结果'));
  assert.ok(result.text.includes('image/png'));
  assert.equal(result.text.includes('SYNTHETIC'), false);
  const assistant = projectTranscript(
    note(3, 'assistant/message', {
      message: {
        content: [
          { type: 'reasoning', text: 'SYNTHETIC REASONING' },
          { type: 'text', text: '合成进度' },
        ],
      },
      stream: ['SYNTHETIC RAW STREAM'],
    }),
    'mock-session',
    safe,
  )!;
  assert.equal(assistant.text, '合成进度');
  assert.equal(
    projectTranscript(
      note(4, 'assistant/message', {
        message: { content: [{ type: 'reasoning', text: 'PRIVATE' }] },
      }),
      'mock-session',
      safe,
    ),
    undefined,
  );
  const plan = projectTranscript(
    note(5, 'todo/write', { todos: [{ content: '合成步骤', status: 'in_progress' }] }),
    'mock-session',
    safe,
  )!;
  assert.equal(plan.kind, 'plan');
  assert.ok(plan.text.includes('合成步骤'));
  const secretId = projectTranscript(
    note(6, 'tool/result', {
      message: { toolCallId: 'mock-capability', content: [{ type: 'text', text: '合成' }] },
    }),
    'mock-session',
    safe,
  )!;
  assert.equal(JSON.stringify(secretId).includes('mock-capability'), false);
  assert.throws(
    () =>
      projectTranscript(
        {
          method: 'session.event',
          params: {
            sessionId: 'mock-session',
            event: {
              type: 'tool/call',
              data: { callId: 'mock-call', name: 'web_search', arguments: '{}' },
            },
          },
        },
        'mock-session',
        safe,
      ),
    { code: 'INVALID_TRANSCRIPT_EVENT' },
  );
});

test('JSON-escaped credentials are removed from tool arguments, results and durable human cards', () => {
  const secret = 'mock"quoted\\secret';
  const safe = (value: string) => redact(value, [secret]);
  const args = JSON.stringify({ nested: { credential: secret } });
  const invocation = projectTranscript(call(1, args), 'mock-session', safe)!;
  assert.equal(JSON.parse(invocation.text).nested.credential, '[credential redacted]');
  const result = projectTranscript(
    note(2, 'tool/result', {
      message: { toolCallId: 'mock-call-1', content: [{ type: 'text', text: args }] },
    }),
    'mock-session',
    safe,
  )!;
  assert.equal(JSON.parse(result.text).nested.credential, '[credential redacted]');
  const human = projectInteraction(
    {
      ...scope,
      id: 'mock-approval',
      sessionId: 'mock-private-session',
      kind: 'approval',
      tool: 'mcp_call',
      connection: 'mock-connection',
      configRevision: 1,
      catalogDigest: 'a'.repeat(64),
      name: 'mock-tool',
      origin: 'https://example.test',
      operation: '合成操作',
      arguments: args,
      inputHash: 'b'.repeat(64),
      status: 'resolved',
      reply: { kind: 'decision', allow: false },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:01Z',
    },
    safe,
  );
  assert.equal(
    JSON.parse(JSON.parse(human.text).arguments).nested.credential,
    '[credential redacted]',
  );
  assert.equal(
    /sessionId|configRevision|catalogDigest|inputHash|mock-connection/.test(human.text),
    false,
  );
});

test('durable transcript pages retain every event beyond the status window and page full long content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-transcripts-'));
  const file = path.join(root, 'transcripts.sqlite');
  let log = new Transcripts(file);
  try {
    await log.ready;
    log.begin(scope);
    const text = '合成输出🧪\n'.repeat(20000);
    for (let seq = 1; seq <= 110; seq++)
      log.append(
        scope,
        projectTranscript(
          call(seq, seq === 1 ? text : `合成 ${seq}`),
          'mock-session',
          (value) => value,
        )!,
      );
    const duplicate = projectTranscript(call(110, '合成 110'), 'mock-session', (value) => value)!;
    log.append(scope, duplicate);
    log.finish(scope);
    await log.close();
    log = new Transcripts(file);
    await log.ready;
    const entries = [];
    let after = 0;
    for (;;) {
      const page = log.page(scope, after);
      assert.equal(page.state, 'complete');
      assert.ok(page.items.length <= 20);
      entries.push(...page.items);
      if (!page.nextAfter) break;
      after = page.nextAfter;
    }
    assert.equal(entries.length, 110);
    assert.equal(entries[0].seq, 1);
    assert.equal(entries[0].characters, text.length);
    assert.equal(entries.at(-1)!.seq, 110);
    assert.equal(JSON.stringify(entries).includes(text.slice(0, 100)), false);
    let offset = 0,
      joined = '';
    for (;;) {
      const part = log.content(scope, 1, offset);
      assert.equal(part.total, text.length);
      assert.ok(part.text.length <= 32000);
      joined += part.text;
      if (part.nextOffset === undefined) break;
      offset = part.nextOffset;
    }
    assert.equal(joined, text);
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transcript scope, append identity and close boundaries cannot be rebound or silently replayed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-transcript-scope-'));
  const log = new Transcripts(path.join(root, 'transcripts.sqlite'));
  try {
    await log.ready;
    log.begin(scope);
    const entry = projectTranscript(call(), 'mock-session', (value) => value)!;
    log.append(scope, entry);
    const foreign = [
      { ...scope, bot: 'mock-other' },
      { ...scope, chatRevision: 1 },
      { bot: scope.bot, runId: scope.runId, conversationId: 'mock-group' },
    ];
    for (const other of foreign) {
      assert.throws(() => log.page(other), { code: 'TRANSCRIPT_NOT_FOUND' });
      assert.throws(() => log.content(other, 1), { code: 'TRANSCRIPT_NOT_FOUND' });
      assert.throws(() => log.begin(other), { code: 'TRANSCRIPT_SCOPE_CONFLICT' });
    }
    assert.throws(() => log.append(scope, { ...entry, text: '合成篡改' }), {
      code: 'TRANSCRIPT_EVENT_CONFLICT',
    });
    assert.throws(
      () => log.page({ ...scope, conversationId: 'mock-group' } as unknown as TranscriptScope),
      { code: 'INVALID_TRANSCRIPT_SCOPE' },
    );
    assert.throws(() => log.page(scope, -1), { code: 'INVALID_TRANSCRIPT_QUERY' });
    assert.throws(() => log.content(scope, 1, 999999), { code: 'INVALID_TRANSCRIPT_QUERY' });
    log.finish(scope);
    assert.throws(
      () => log.append(scope, projectTranscript(call(2), 'mock-session', (value) => value)!),
      { code: 'TRANSCRIPT_CLOSED' },
    );
    assert.equal(log.page(scope).items.length, 1);
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy missing transcripts and crash prefixes stay distinguishable from a complete empty run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-transcript-crash-'));
  const file = path.join(root, 'transcripts.sqlite');
  let log = new Transcripts(file);
  try {
    await log.ready;
    assert.equal(log.page(scope).state, 'unavailable');
    log.begin(scope);
    assert.equal(log.page(scope).state, 'recording');
    log.append(scope, projectTranscript(call(), 'mock-session', (value) => value)!);
    await log.close();
    log = new Transcripts(file);
    await log.ready;
    assert.equal(log.page(scope).state, 'interrupted');
    assert.equal(log.page(scope).items.length, 1);
    assert.throws(() => log.begin(scope), { code: 'TRANSCRIPT_CLOSED' });
    const empty = { ...scope, runId: 'mock-empty' };
    log.begin(empty);
    log.finish(empty);
    assert.equal(log.page(empty).state, 'complete');
    assert.deepEqual(log.page(empty).items, []);
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('transcript storage refuses a symlink without modifying its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-transcript-link-'));
  const original = path.join(root, 'original.sqlite');
  const first = new Transcripts(original);
  await first.ready;
  await first.close();
  const before = await readFile(original);
  await symlink(original, path.join(root, 'linked.sqlite'));
  const linked = new Transcripts(path.join(root, 'linked.sqlite'));
  try {
    await assert.rejects(linked.ready);
    assert.deepEqual(await readFile(original), before);
  } finally {
    await linked.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('software confirmation transcripts retain exact packages and never imply successful installation', () => {
  const event = projectInteraction(
    {
      id: 'mock-install',
      sessionId: 'mock-session',
      bot: 'mock-a',
      runId: 'mock-run',
      kind: 'approval',
      tool: 'software_install',
      purpose: '合成用途',
      plan: {
        id: 'mock-plan',
        requested: ['mock-calculator'],
        targets: [{ name: 'mock-calculator', version: '1.0-1' }],
        packages: [{ name: 'mock-calculator', version: '1.0-1' }],
        source: 'debian',
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:20:00Z',
        digest: 'a'.repeat(64),
      },
      status: 'resolved',
      reply: { kind: 'decision', allow: true },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:01Z',
    },
    (x) => x,
  );
  assert.match(event.text || '', /mock-calculator/);
  assert.match(event.text || '', /1.0-1/);
  assert.doesNotMatch(event.text || '', /installed/);
});
