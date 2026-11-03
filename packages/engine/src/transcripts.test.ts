import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TranscriptScope } from '@daban/protocol';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test } from 'vitest';
import { redact } from './redaction.js';
import { projectInteraction, projectTranscript, Transcripts } from './transcripts.js';
import { transcriptRuns } from './transcripts-schema.js';

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

test('a pre-ORM transcript file keeps its events, interrupts open runs and keeps numbering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-transcripts-legacy-'));
  const file = path.join(root, 'transcripts.sqlite');
  const legacy = { ...scope, runId: 'mock-legacy-run' };
  const text = 'SYNTHETIC LEGACY RESULT';
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE transcript_runs(run TEXT PRIMARY KEY,scope TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE transcript_events(run TEXT NOT NULL,seq INTEGER NOT NULL,source TEXT NOT NULL,meta TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(run,seq),UNIQUE(run,source));`);
  old
    .prepare('INSERT INTO transcript_runs VALUES(?,?,?)')
    .run(legacy.runId, JSON.stringify([scope.bot, legacy.runId, null, 0]), 'recording');
  old.prepare('INSERT INTO transcript_events VALUES(?,?,?,?,?)').run(
    legacy.runId,
    1,
    'mock-legacy-source',
    JSON.stringify({
      kind: 'result',
      at: '2026-01-01T00:00:00Z',
      callId: 'mock-legacy-call',
      characters: text.length,
    }),
    text,
  );
  old.close();
  const log = new Transcripts(file);
  try {
    await log.ready;
    const page = log.page(legacy);
    expect(page.state).toBe('interrupted');
    expect(page.items).toMatchObject([{ seq: 1, kind: 'result', callId: 'mock-legacy-call' }]);
    expect(log.results(legacy).results).toStrictEqual([
      { seq: 1, callId: 'mock-legacy-call', isError: false, characters: text.length },
    ]);
    expect(log.result(legacy, 1).text).toBe(text);
    log.begin(scope);
    for (const source of ['mock-first', 'mock-second'])
      log.append(scope, {
        source,
        kind: 'assistant',
        at: '2026-01-01T00:00:01Z',
        text: source,
      });
    expect(log.page(scope).items.map((item) => item.seq)).toStrictEqual([1, 2]);
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('visible JSON retains exact numeric spellings while escaped credentials are redacted', () => {
  const raw =
    '{"syntheticId":90000000000000000001,"amount":12.3400,"secret":"synthetic\\u002dprivate\\u002dkey"}';
  const event = projectTranscript(
    note(1, 'tool/result', {
      message: { toolCallId: 'mock-numeric', content: [{ type: 'text', text: raw }] },
    }),
    'mock-session',
    (value) => value.replaceAll('synthetic-private-key', '[redacted]'),
  );
  expect(event?.text).toBe(
    '{"syntheticId":90000000000000000001,"amount":12.3400,"secret":"[redacted]"}',
  );
});

test('a non-compaction tool-result correction stays visible in execution records', () => {
  const value = note(4, 'tool/result', {
    message: {
      toolCallId: 'mock-corrected',
      content: [{ type: 'text', text: 'SYNTHETIC CORRECTED OUTCOME' }],
    },
  });
  Object.assign(value.params.event, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [1],
  });
  expect(projectTranscript(value, 'mock-session', (text) => text)?.text).toBe(
    'SYNTHETIC CORRECTED OUTCOME',
  );
});

test('tool result recovery requires its persisted transcript owner even if orphaned events remain', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-result-owner-'));
  const file = path.join(root, 'transcripts.sqlite'),
    log = new Transcripts(file);
  try {
    await log.ready;
    log.begin(scope);
    log.append(scope, {
      source: 'mock-result',
      kind: 'result',
      callId: 'mock-result',
      at: '2026-01-01T00:00:00Z',
      text: 'SYNTHETIC OWNED RESULT',
    });
    const client = new DatabaseSync(file);
    try {
      drizzle({ client }).delete(transcriptRuns).where(eq(transcriptRuns.run, scope.runId)).run();
    } finally {
      client.close();
    }
    expect(() => log.result(scope, 1)).toThrowError(
      expect.objectContaining({ code: 'TRANSCRIPT_NOT_FOUND' }),
    );
  } finally {
    await log.close();
    await rm(root, { recursive: true, force: true });
  }
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
  expect(body.command).toBe('echo [redacted]');
  expect(body.cwd).toBe('/mock-guest/task');
  expect(body.target).toBe('linux-vm');
});

test('transcript projection admits only owned visible events and excludes private streams and binary bodies', () => {
  const safe = (value: string) => redact(value, ['mock-provider-key', 'mock-capability']);
  expect(projectTranscript(call(), 'foreign-session', safe)).toBe(undefined);
  for (const type of ['system/message', 'developer/message', 'request/header', 'assistant/attempt'])
    expect(
      projectTranscript(note(1, type, { text: 'SYNTHETIC PRIVATE' }), 'mock-session', safe),
    ).toBe(undefined);
  const entry = projectTranscript(
    call(1, '{"command":"mock-provider-key mock-capability"}'),
    'mock-session',
    safe,
  )!;
  expect(entry.kind).toBe('call');
  expect(entry.name).toBe('computer__read_file');
  expect(entry.text.includes('mock-provider-key')).toBe(false);
  expect(entry.text.includes('mock-capability')).toBe(false);
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
  expect(result.kind).toBe('result');
  expect(result.isError).toBe(true);
  expect(result.code).toBe('MOCK_DENIED');
  expect.assert(result.text.includes('合成结果'));
  expect.assert(result.text.includes('image/png'));
  expect(result.text.includes('SYNTHETIC')).toBe(false);
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
  expect(assistant.text).toBe('合成进度');
  expect(
    projectTranscript(
      note(4, 'assistant/message', {
        message: { content: [{ type: 'reasoning', text: 'PRIVATE' }] },
      }),
      'mock-session',
      safe,
    ),
  ).toBe(undefined);
  const plan = projectTranscript(
    note(5, 'todo/write', { todos: [{ content: '合成步骤', status: 'in_progress' }] }),
    'mock-session',
    safe,
  )!;
  expect(plan.kind).toBe('plan');
  expect.assert(plan.text.includes('合成步骤'));
  const secretId = projectTranscript(
    note(6, 'tool/result', {
      message: { toolCallId: 'mock-capability', content: [{ type: 'text', text: '合成' }] },
    }),
    'mock-session',
    safe,
  )!;
  expect(JSON.stringify(secretId).includes('mock-capability')).toBe(false);
  expect(() =>
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
  ).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSCRIPT_EVENT' }));
});

test('JSON-escaped credentials are removed from tool arguments, results and durable human cards', () => {
  const secret = 'mock"quoted\\secret';
  const safe = (value: string) => redact(value, [secret]);
  const args = JSON.stringify({ nested: { credential: secret } });
  const invocation = projectTranscript(call(1, args), 'mock-session', safe)!;
  expect(JSON.parse(invocation.text).nested.credential).toBe('[credential redacted]');
  const result = projectTranscript(
    note(2, 'tool/result', {
      message: { toolCallId: 'mock-call-1', content: [{ type: 'text', text: args }] },
    }),
    'mock-session',
    safe,
  )!;
  expect(JSON.parse(result.text).nested.credential).toBe('[credential redacted]');
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
  expect(JSON.parse(JSON.parse(human.text).arguments).nested.credential).toBe(
    '[credential redacted]',
  );
  expect(/sessionId|configRevision|catalogDigest|inputHash|mock-connection/.test(human.text)).toBe(
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
      expect(page.state).toBe('complete');
      expect.assert(page.items.length <= 20);
      entries.push(...page.items);
      if (!page.nextAfter) break;
      after = page.nextAfter;
    }
    expect(entries.length).toBe(110);
    expect(entries[0].seq).toBe(1);
    expect(entries[0].characters).toBe(text.length);
    expect(entries.at(-1)!.seq).toBe(110);
    expect(JSON.stringify(entries).includes(text.slice(0, 100))).toBe(false);
    let offset = 0,
      joined = '';
    for (;;) {
      const part = log.content(scope, 1, offset);
      expect(part.total).toBe(text.length);
      expect.assert(part.text.length <= 32000);
      joined += part.text;
      if (part.nextOffset === undefined) break;
      offset = part.nextOffset;
    }
    expect(joined).toBe(text);
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
      expect(() => log.page(other)).toThrowError(
        expect.objectContaining({ code: 'TRANSCRIPT_NOT_FOUND' }),
      );
      expect(() => log.content(other, 1)).toThrowError(
        expect.objectContaining({ code: 'TRANSCRIPT_NOT_FOUND' }),
      );
      expect(() => log.begin(other)).toThrowError(
        expect.objectContaining({ code: 'TRANSCRIPT_SCOPE_CONFLICT' }),
      );
    }
    expect(() => log.append(scope, { ...entry, text: '合成篡改' })).toThrowError(
      expect.objectContaining({
        code: 'TRANSCRIPT_EVENT_CONFLICT',
      }),
    );
    expect(() =>
      log.page({ ...scope, conversationId: 'mock-group' } as unknown as TranscriptScope),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSCRIPT_SCOPE' }));
    expect(() => log.page(scope, -1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSCRIPT_QUERY' }),
    );
    expect(() => log.content(scope, 1, 999999)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TRANSCRIPT_QUERY' }),
    );
    log.finish(scope);
    expect(() =>
      log.append(scope, projectTranscript(call(2), 'mock-session', (value) => value)!),
    ).toThrowError(expect.objectContaining({ code: 'TRANSCRIPT_CLOSED' }));
    expect(log.page(scope).items.length).toBe(1);
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
    expect(log.page(scope).state).toBe('unavailable');
    log.begin(scope);
    expect(log.page(scope).state).toBe('recording');
    log.append(scope, projectTranscript(call(), 'mock-session', (value) => value)!);
    await log.close();
    log = new Transcripts(file);
    await log.ready;
    expect(log.page(scope).state).toBe('interrupted');
    expect(log.page(scope).items.length).toBe(1);
    expect(() => log.begin(scope)).toThrowError(
      expect.objectContaining({ code: 'TRANSCRIPT_CLOSED' }),
    );
    const empty = { ...scope, runId: 'mock-empty' };
    log.begin(empty);
    log.finish(empty);
    expect(log.page(empty).state).toBe('complete');
    expect(log.page(empty).items).toStrictEqual([]);
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
    await expect(linked.ready).rejects.toThrowError();
    expect(await readFile(original)).toStrictEqual(before);
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
  expect(event.text || '').toMatch(/mock-calculator/);
  expect(event.text || '').toMatch(/1.0-1/);
  expect(event.text || '').not.toMatch(/installed/);
});
