import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { HistoryTools } from './history.js';
import { TaskJournal, type TaskRecord } from './tasks.js';
import { projectTranscript, Transcripts } from './transcripts.js';
import { WorkspaceFiles } from './workspace.js';

interface Search {
  untrusted: boolean;
  unreadable: number;
  matches: {
    runId: string;
    incomplete: boolean;
    kind: string;
    preview: { field: string; offset: number; content: string; truncated: boolean };
    fileCount: number;
  }[];
  nextBefore?: string;
}
interface Read {
  untrusted: boolean;
  incomplete: boolean;
  content: string;
  offset: number;
  total: number;
  nextOffset?: number;
  files?: { path: string; name: string }[];
  inputNames?: string[];
}
function value<T>(result: ToolResult): T {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const item = result.content[0];
  assert.equal(item.type, 'text');
  return JSON.parse(item.type === 'text' ? item.text : '') as T;
}
const record = (i: number): TaskRecord => ({
  bot: 'a',
  runId: `mock-history-${String(i).padStart(4, '0')}`,
  requestId: `mock-request-${i}`,
  kind: 'chat',
  prompt: `合成请求 ${i}`,
  result: `合成回答 ${i}`,
  phase: 'completed',
  running: false,
  error: '',
  trace: [],
  createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60000).toISOString(),
});

test('tool-output read-back is discoverable, Unicode-paged and redacted before slicing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-tool-history-'));
  const journal = new TaskJournal(path.join(root, 'journal'));
  const transcripts = new Transcripts(path.join(root, 'transcripts.sqlite'));
  try {
    await journal.load();
    await transcripts.ready;
    const task = record(1);
    await journal.put(task);
    const scope = { bot: 'a', runId: task.runId, chatRevision: 0 };
    transcripts.begin(scope);
    const secret = 'synthetic-private-key';
    const body =
      '前缀😀'.repeat(297) +
      secret +
      ' needle[7].* ' +
      '\u0001'.repeat(3000) +
      ' SYNTHETIC EXACT END';
    for (let i = 1; i <= 2; i++)
      transcripts.append(scope, {
        source: `mock-result-${i}`,
        kind: 'result',
        callId: `mock-call-${i}`,
        at: '2026-01-01T00:00:00Z',
        text: body,
      });
    transcripts.append(scope, {
      source: 'mock-assistant',
      kind: 'assistant',
      at: '2026-01-01T00:00:00Z',
      text: 'SYNTHETIC PRIVATE NON-RESULT',
    });
    transcripts.finish(scope);
    const history = new HistoryTools(journal, transcripts),
      run = {
        bot: 'a',
        id: 'mock-current',
        abort: new AbortController(),
        redact: (value: string) => value.replaceAll(secret, '[redacted]'),
      };
    const first = (await history.invoke(run, 'bot_tool_result_read', {
      runId: task.runId,
      limit: 1,
    })) as { results: { seq: number }[]; nextAfter: number };
    assert.deepEqual(
      first.results.map((item) => item.seq),
      [1],
    );
    assert.equal(first.nextAfter, 1);
    const second = (await history.invoke(run, 'bot_tool_result_read', {
      runId: task.runId,
      after: first.nextAfter,
    })) as { results: { seq: number }[] };
    assert.deepEqual(
      second.results.map((item) => item.seq),
      [2],
    );
    let offset = 0,
      joined = '';
    for (let count = 0; count < 30; count++) {
      const page = (await history.invoke(run, 'bot_tool_result_read', {
        runId: task.runId,
        seq: 1,
        offset,
        limit: 2000,
      })) as { content: string; nextOffset?: number };
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 6000);
      joined += page.content;
      if (page.nextOffset === undefined) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(joined, body.replaceAll(secret, '[redacted]'));
    const found = (await history.invoke(run, 'bot_tool_result_read', {
      runId: task.runId,
      seq: 1,
      query: 'needle[7].*',
      limit: 200,
    })) as { found: boolean; content: string };
    assert.equal(found.found, true);
    assert.match(found.content, /needle\[7\]\.\*/);
    await assert.rejects(
      history.invoke({ ...run, conversationId: 'mock-group' }, 'bot_tool_result_read', {
        runId: task.runId,
      }),
      { code: 'HISTORY_NOT_FOUND' },
    );
    await assert.rejects(
      history.invoke(run, 'bot_tool_result_read', { runId: task.runId, seq: 3 }),
      { code: 'HISTORY_NOT_FOUND' },
    );
    const projected = projectTranscript(
      {
        method: 'session.event',
        params: {
          sessionId: 'mock-session',
          event: {
            type: 'tool/result',
            seq: 30,
            time: 1800000000000,
            surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
            data: {
              message: {
                toolCallId: 'mock-call',
                content: [{ type: 'text', text: 'SYNTHETIC PRUNED VIEW' }],
              },
            },
          },
        },
      },
      'mock-session',
      (value) => value,
      true,
    );
    assert.equal(projected, undefined);
  } finally {
    await transcripts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('tool-output cursors can reach the end of an already supported multi-megabyte result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-large-result-'));
  const journal = new TaskJournal(path.join(root, 'journal'));
  const transcripts = new Transcripts(path.join(root, 'transcripts.sqlite'));
  try {
    await journal.load();
    await transcripts.ready;
    const task = record(1);
    await journal.put(task);
    const scope = { bot: 'a', runId: task.runId, chatRevision: 0 };
    transcripts.begin(scope);
    transcripts.append(scope, {
      source: 'mock-large',
      kind: 'result',
      callId: 'mock-large',
      at: '2026-01-01T00:00:00Z',
      text: 'X'.repeat(2100000) + 'SYNTHETIC EXACT LARGE END',
    });
    transcripts.finish(scope);
    const history = new HistoryTools(journal, transcripts);
    const page = (await history.invoke(
      { bot: 'a', id: 'mock-current', abort: new AbortController() },
      'bot_tool_result_read',
      { runId: task.runId, seq: 1, offset: 2100000, limit: 100 },
    )) as { content: string };
    assert.equal(page.content, 'SYNTHETIC EXACT LARGE END');
  } finally {
    await transcripts.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('history search and exact reads stay inside the executing conversation, including after journal reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-history-conversation-'));
  try {
    const journal = new TaskJournal(root);
    await journal.load();
    await journal.put({ ...record(1), result: 'PRIVATE-DM-47' });
    await journal.put({ ...record(2), conversationId: 'mock-group-a', result: 'GROUP-A-53' });
    await journal.put({ ...record(3), conversationId: 'mock-group-b', result: 'GROUP-B-59' });
    const recovered = new TaskJournal(root);
    await recovered.load();
    const history = new HistoryTools(recovered);
    const run = {
      bot: 'a',
      id: 'current',
      conversationId: 'mock-group-a',
      abort: new AbortController(),
    };
    const found = await history.invoke(run, 'bot_history_search', {});
    assert.deepEqual(
      (found as Search).matches.map((item) => item.runId),
      [record(2).runId],
    );
    await assert.rejects(history.invoke(run, 'bot_history_read', { runId: record(1).runId }), {
      code: 'HISTORY_NOT_FOUND',
    });
    await assert.rejects(history.invoke(run, 'bot_history_read', { runId: record(3).runId }), {
      code: 'HISTORY_NOT_FOUND',
    });
    const direct = await history.invoke(
      { bot: 'a', id: 'private-current', abort: new AbortController() },
      'bot_history_search',
      {},
    );
    assert.deepEqual(
      (direct as Search).matches.map((item) => item.runId),
      [record(1).runId],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('history tools retrieve older committed records with scoped cursors, time filters and safe projections', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-history-tools-'));
  try {
    const journal = new TaskJournal(path.join(root, 'journal'));
    await journal.load();
    for (let i = 0; i < 135; i++) await journal.put(record(i));
    await journal.put({
      ...record(0),
      result: `${'📄'.repeat(1500)} 针对NEEDLE的合成结论 47 synthetic-private-key`,
      sessionId: 'private-session',
      fingerprint: 'private-fingerprint',
      outputDirectory: '/private/secret-store',
      trace: [{ reasoning: 'private-reasoning' }],
      inputs: ['mock-input.csv'],
      files: [
        {
          path: 'old/mock-result.txt',
          name: 'mock-result.txt',
          size: 17,
          modified: '2026-01-01T00:00:00Z',
          content: 'not-for-listing',
        },
      ],
    });
    await journal.put({
      ...record(200),
      runId: 'mock-active',
      phase: 'running',
      running: true,
      result: 'NEEDLE 未完成',
    });
    await journal.put({
      ...record(201),
      runId: 'mock-current',
      result: 'NEEDLE 本轮请求不得自匹配',
    });
    await journal.put({
      ...record(202),
      runId: 'mock-beta',
      bot: 'b',
      result: 'NEEDLE 另一位的记录',
    });
    await journal.put({
      ...record(203),
      runId: 'mock-stopped',
      phase: 'stopped',
      response: { revision: 1, text: '中断的 PARTIAL 合成前缀', state: 'settled' },
      result: '',
    });
    await journal.put({ ...record(204), runId: 'mock-corrupt', prompt: 42 as unknown as string });
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const tools = new AgentTools(undefined, new WorkspaceFiles(workspace));
    tools.history = new HistoryTools(journal);
    const run: AgentToolRun = {
      id: 'mock-current',
      bot: 'a',
      abort: new AbortController(),
      toolCount: 0,
      limit: 50,
      seen: {},
      trace: [],
      workdir: workspace,
      canonicalRoot: workspace,
      redact: (text) => text.replaceAll('synthetic-private-key', '[redacted]'),
    };
    const found = value<Search>(await tools.invoke(run, 'bot_history_search', { query: 'needle' }));
    assert.equal(found.untrusted, true);
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].runId, 'mock-history-0000');
    assert.equal(found.matches[0].preview.field, 'result');
    assert.equal(found.matches[0].preview.truncated, true);
    assert.equal(found.matches[0].fileCount, 1);
    assert.ok(found.unreadable > 0);
    const body = value<Read>(
      await tools.invoke(run, 'bot_history_read', {
        runId: found.matches[0].runId,
        field: 'result',
        offset: found.matches[0].preview.offset,
        limit: 200,
      }),
    );
    assert.match(body.content, /NEEDLE/);
    assert.equal(body.content.includes('synthetic-private-key'), false);
    const serialized = JSON.stringify(found) + JSON.stringify(body);
    for (const privateValue of [
      'private-session',
      'private-fingerprint',
      '/private/secret-store',
      'private-reasoning',
    ])
      assert.equal(serialized.includes(privateValue), false);
    assert.equal(
      value<Search>(await tools.invoke(run, 'bot_history_search', { query: 'private-reasoning' }))
        .matches.length,
      0,
    );
    assert.equal(
      value<Search>(await tools.invoke(run, 'bot_history_search', { query: '[.*]' })).matches
        .length,
      0,
      'query text is literal, not an executable regular expression',
    );
    const files = value<Read>(
      await tools.invoke(run, 'bot_history_read', { runId: 'mock-history-0000', field: 'files' }),
    );
    assert.deepEqual(
      files.files?.map((file) => file.path),
      ['old/mock-result.txt'],
    );
    assert.deepEqual(files.inputNames, ['mock-input.csv']);
    assert.equal(JSON.stringify(files).includes('not-for-listing'), false);
    await journal.put({
      ...record(205),
      runId: 'mock-files-page',
      result: '合成文件页',
      files: Array.from({ length: 25 }, (_, i) => ({
        path: `old/file-${i}.md`,
        name: `file-${i}.md`,
        size: i,
        modified: '2026-01-01T00:00:00Z',
      })),
    });
    const boundedFiles = value<Read>(
      await tools.invoke(run, 'bot_history_read', {
        runId: 'mock-files-page',
        field: 'files',
        limit: 2000,
      }),
    );
    assert.equal(boundedFiles.files!.length, 20);
    assert.equal(boundedFiles.nextOffset, 20);
    const remainingFiles = value<Read>(
      await tools.invoke(run, 'bot_history_read', {
        runId: 'mock-files-page',
        field: 'files',
        offset: boundedFiles.nextOffset,
        limit: 2000,
      }),
    );
    assert.equal(remainingFiles.files!.length, 5);
    assert.equal(remainingFiles.nextOffset, undefined);
    assert.match(
      JSON.stringify(
        await tools.invoke({ ...run, bot: 'b' }, 'bot_history_read', {
          runId: 'mock-history-0000',
        }),
      ),
      /HISTORY_NOT_FOUND/,
    );
    assert.match(
      JSON.stringify(await tools.invoke(run, 'bot_history_read', { runId: 'mock-current' })),
      /HISTORY_NOT_FOUND/,
    );
    assert.match(
      JSON.stringify(await tools.invoke(run, 'bot_history_search', { query: 'NEEDLE', bot: 'b' })),
      /INVALID_TOOL_ARGS/,
    );
    const first = value<Search>(
      await tools.invoke(run, 'bot_history_search', { query: '合成回答', limit: 2 }),
    );
    assert.ok(first.nextBefore);
    const second = value<Search>(
      await tools.invoke(run, 'bot_history_search', {
        query: '合成回答',
        limit: 2,
        before: first.nextBefore,
      }),
    );
    assert.equal(
      first.matches.some((item) => second.matches.some((other) => other.runId === item.runId)),
      false,
    );
    const ranged = value<Search>(
      await tools.invoke(run, 'bot_history_search', {
        from: '2026-01-01T00:01:00Z',
        to: '2026-01-01T00:02:00Z',
      }),
    );
    assert.deepEqual(
      ranged.matches.map((item) => item.runId),
      ['mock-history-0002', 'mock-history-0001'],
    );
    for (const from of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z'])
      assert.equal((await tools.invoke(run, 'bot_history_search', { from })).isError, true);
    const partial = value<Search>(
      await tools.invoke(run, 'bot_history_search', { query: 'PARTIAL' }),
    );
    assert.equal(partial.matches[0].incomplete, true);
    assert.equal(partial.matches[0].preview.field, 'partial');
    assert.equal(
      value<Read>(
        await tools.invoke(run, 'bot_history_read', { runId: 'mock-stopped', field: 'partial' }),
      ).incomplete,
      true,
    );
    for (const args of [
      { runId: 'mock-history-0000', field: 'trace' },
      { runId: '../secret' },
      { runId: 'mock-history-0000', offset: -1 },
    ])
      assert.equal((await tools.invoke(run, 'bot_history_read', args)).isError, true);
    assert.equal(
      (await tools.invoke(run, 'bot_history_search', { query: '[.*]', limit: 0 })).isError,
      true,
    );
    assert.ok(run.trace.every((item) => item.surface === 'history'));
    assert.equal(JSON.stringify(run.trace).includes('NEEDLE'), false);
    const restored = new TaskJournal(journal.dir);
    await restored.load();
    tools.history = new HistoryTools(restored);
    assert.equal(
      value<Search>(await tools.invoke(run, 'bot_history_search', { query: 'NEEDLE' })).matches[0]
        .runId,
      'mock-active',
      'a restarted running task is retained as interrupted evidence',
    );
    await tools.drain(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('history pages preserve Unicode and redact before chunking, with complete JSON and shared tool limits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-history-pages-'));
  try {
    const journal = new TaskJournal(path.join(root, 'journal'));
    await journal.load();
    await journal.put({ ...record(1), result: `${'甲📄'.repeat(2000)}synthetic-private-key` });
    const tools = new AgentTools(undefined, new WorkspaceFiles(root));
    tools.history = new HistoryTools(journal);
    const run: AgentToolRun = {
      id: 'mock-current',
      bot: 'a',
      abort: new AbortController(),
      toolCount: 0,
      limit: 20,
      seen: {},
      trace: [],
      workdir: root,
      canonicalRoot: root,
      redact: (text) => text.replaceAll('synthetic-private-key', '[redacted]'),
    };
    let offset = 0,
      result = '';
    while (true) {
      const chunk = value<Read>(
        await tools.invoke(run, 'bot_history_read', {
          runId: 'mock-history-0001',
          offset,
          limit: 700,
        }),
      );
      assert.equal(chunk.offset, offset);
      assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 11000);
      result += chunk.content;
      if (chunk.nextOffset === undefined) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
    assert.equal(result, `${'甲📄'.repeat(2000)}[redacted]`);
    await journal.put({ ...record(2), result: '\u0001'.repeat(3000) });
    assert.match(
      JSON.stringify(
        await tools.invoke(run, 'bot_history_read', { runId: 'mock-history-0002', limit: 2000 }),
      ),
      /HISTORY_RESPONSE_TOO_LARGE/,
    );
    assert.equal(
      value<Read>(
        await tools.invoke(run, 'bot_history_read', { runId: 'mock-history-0002', limit: 500 }),
      ).content.length,
      500,
    );
    const limited = { ...run, toolCount: 0, limit: 1 };
    await tools.invoke(limited, 'bot_history_search');
    assert.match(
      JSON.stringify(
        await tools.invoke(limited, 'bot_history_read', { runId: 'mock-history-0001' }),
      ),
      /TOOL_LIMIT/,
    );
    const aborted = { ...run, abort: new AbortController() };
    aborted.abort.abort();
    assert.match(
      JSON.stringify(await tools.invoke(aborted, 'bot_history_search')),
      /MODEL_CANCELLED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
