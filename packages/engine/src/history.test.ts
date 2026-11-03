import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { HistoryTools } from './history.js';
import { recordLimit, TaskJournal, type TaskRecord } from './tasks.js';
import { projectTranscript, Transcripts } from './transcripts.js';
import { WorkspaceFiles } from './workspace.js';

interface Search {
  untrusted: boolean;
  unreadable: number;
  matches: {
    runId: string;
    incomplete: boolean;
    kind: string;
    preview: {
      field: string;
      turn?: number;
      offset: number;
      content: string;
      truncated: boolean;
    };
    fileCount: number;
  }[];
  nextBefore?: string;
}
interface Read {
  untrusted: boolean;
  incomplete: boolean;
  turn?: number;
  turns?: number;
  content: string;
  offset: number;
  total: number;
  nextOffset?: number;
  files?: { path: string; name: string }[];
  inputNames?: string[];
}
function value<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBe(undefined);
  const item = result.content[0];
  expect(item.type).toBe('text');
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
    expect(first.results.map((item) => item.seq)).toStrictEqual([1]);
    expect(first.nextAfter).toBe(1);
    const second = (await history.invoke(run, 'bot_tool_result_read', {
      runId: task.runId,
      after: first.nextAfter,
    })) as { results: { seq: number }[] };
    expect(second.results.map((item) => item.seq)).toStrictEqual([2]);
    let offset = 0,
      joined = '';
    for (let count = 0; count < 30; count++) {
      const page = (await history.invoke(run, 'bot_tool_result_read', {
        runId: task.runId,
        seq: 1,
        offset,
        limit: 2000,
      })) as { content: string; nextOffset?: number };
      expect.assert(Buffer.byteLength(JSON.stringify(page)) <= 6000);
      joined += page.content;
      if (page.nextOffset === undefined) break;
      expect.assert(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    expect(joined).toBe(body.replaceAll(secret, '[redacted]'));
    const found = (await history.invoke(run, 'bot_tool_result_read', {
      runId: task.runId,
      seq: 1,
      query: 'needle[7].*',
      limit: 200,
    })) as { found: boolean; content: string };
    expect(found.found).toBe(true);
    expect(found.content).toMatch(/needle\[7\]\.\*/);
    await expect(
      history.invoke({ ...run, conversationId: 'mock-group' }, 'bot_tool_result_read', {
        runId: task.runId,
      }),
    ).rejects.toMatchObject({ code: 'HISTORY_NOT_FOUND' });
    await expect(
      history.invoke(run, 'bot_tool_result_read', { runId: task.runId, seq: 3 }),
    ).rejects.toMatchObject({ code: 'HISTORY_NOT_FOUND' });
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
    expect(projected).toBe(undefined);
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
    expect(page.content).toBe('SYNTHETIC EXACT LARGE END');
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
    expect((found as Search).matches.map((item) => item.runId)).toStrictEqual([record(2).runId]);
    await expect(
      history.invoke(run, 'bot_history_read', { runId: record(1).runId }),
    ).rejects.toMatchObject({
      code: 'HISTORY_NOT_FOUND',
    });
    await expect(
      history.invoke(run, 'bot_history_read', { runId: record(3).runId }),
    ).rejects.toMatchObject({
      code: 'HISTORY_NOT_FOUND',
    });
    const direct = await history.invoke(
      { bot: 'a', id: 'private-current', abort: new AbortController() },
      'bot_history_search',
      {},
    );
    expect((direct as Search).matches.map((item) => item.runId)).toStrictEqual([record(1).runId]);
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
    expect(found.untrusted).toBe(true);
    expect(found.matches.length).toBe(1);
    expect(found.matches[0].runId).toBe('mock-history-0000');
    expect(found.matches[0].preview.field).toBe('result');
    expect(found.matches[0].preview.truncated).toBe(true);
    expect(found.matches[0].fileCount).toBe(1);
    expect.assert(found.unreadable > 0);
    const body = value<Read>(
      await tools.invoke(run, 'bot_history_read', {
        runId: found.matches[0].runId,
        field: 'result',
        offset: found.matches[0].preview.offset,
        limit: 200,
      }),
    );
    expect(body.content).toMatch(/NEEDLE/);
    expect(body.content.includes('synthetic-private-key')).toBe(false);
    const serialized = JSON.stringify(found) + JSON.stringify(body);
    for (const privateValue of [
      'private-session',
      'private-fingerprint',
      '/private/secret-store',
      'private-reasoning',
    ])
      expect(serialized.includes(privateValue)).toBe(false);
    expect(
      value<Search>(await tools.invoke(run, 'bot_history_search', { query: 'private-reasoning' }))
        .matches.length,
    ).toBe(0);
    expect(
      value<Search>(await tools.invoke(run, 'bot_history_search', { query: '[.*]' })).matches
        .length,
      'query text is literal, not an executable regular expression',
    ).toBe(0);
    const files = value<Read>(
      await tools.invoke(run, 'bot_history_read', { runId: 'mock-history-0000', field: 'files' }),
    );
    expect(files.files?.map((file) => file.path)).toStrictEqual(['old/mock-result.txt']);
    expect(files.inputNames).toStrictEqual(['mock-input.csv']);
    expect(JSON.stringify(files).includes('not-for-listing')).toBe(false);
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
    expect(boundedFiles.files!.length).toBe(20);
    expect(boundedFiles.nextOffset).toBe(20);
    const remainingFiles = value<Read>(
      await tools.invoke(run, 'bot_history_read', {
        runId: 'mock-files-page',
        field: 'files',
        offset: boundedFiles.nextOffset,
        limit: 2000,
      }),
    );
    expect(remainingFiles.files!.length).toBe(5);
    expect(remainingFiles.nextOffset).toBe(undefined);
    expect(
      JSON.stringify(
        await tools.invoke({ ...run, bot: 'b' }, 'bot_history_read', {
          runId: 'mock-history-0000',
        }),
      ),
    ).toMatch(/HISTORY_NOT_FOUND/);
    expect(
      JSON.stringify(await tools.invoke(run, 'bot_history_read', { runId: 'mock-current' })),
    ).toMatch(/HISTORY_NOT_FOUND/);
    expect(
      JSON.stringify(await tools.invoke(run, 'bot_history_search', { query: 'NEEDLE', bot: 'b' })),
    ).toMatch(/INVALID_TOOL_ARGS/);
    const first = value<Search>(
      await tools.invoke(run, 'bot_history_search', { query: '合成回答', limit: 2 }),
    );
    expect.assert(first.nextBefore);
    const second = value<Search>(
      await tools.invoke(run, 'bot_history_search', {
        query: '合成回答',
        limit: 2,
        before: first.nextBefore,
      }),
    );
    expect(
      first.matches.some((item) => second.matches.some((other) => other.runId === item.runId)),
    ).toBe(false);
    const ranged = value<Search>(
      await tools.invoke(run, 'bot_history_search', {
        from: '2026-01-01T00:01:00Z',
        to: '2026-01-01T00:02:00Z',
      }),
    );
    expect(ranged.matches.map((item) => item.runId)).toStrictEqual([
      'mock-history-0002',
      'mock-history-0001',
    ]);
    for (const from of ['2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z'])
      expect((await tools.invoke(run, 'bot_history_search', { from })).isError).toBe(true);
    const partial = value<Search>(
      await tools.invoke(run, 'bot_history_search', { query: 'PARTIAL' }),
    );
    expect(partial.matches[0].incomplete).toBe(true);
    expect(partial.matches[0].preview.field).toBe('partial');
    expect(
      value<Read>(
        await tools.invoke(run, 'bot_history_read', { runId: 'mock-stopped', field: 'partial' }),
      ).incomplete,
    ).toBe(true);
    for (const args of [
      { runId: 'mock-history-0000', field: 'trace' },
      { runId: '../secret' },
      { runId: 'mock-history-0000', offset: -1 },
    ])
      expect((await tools.invoke(run, 'bot_history_read', args)).isError).toBe(true);
    expect(
      (await tools.invoke(run, 'bot_history_search', { query: '[.*]', limit: 0 })).isError,
    ).toBe(true);
    expect.assert(run.trace.every((item) => item.surface === 'history'));
    expect(JSON.stringify(run.trace).includes('NEEDLE')).toBe(false);
    const restored = new TaskJournal(journal.dir);
    await restored.load();
    tools.history = new HistoryTools(restored);
    expect(
      value<Search>(await tools.invoke(run, 'bot_history_search', { query: 'NEEDLE' })).matches[0]
        .runId,
      'a restarted running task is retained as interrupted evidence',
    ).toBe('mock-active');
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
      expect(chunk.offset).toBe(offset);
      expect.assert(Buffer.byteLength(JSON.stringify(chunk)) <= 11000);
      result += chunk.content;
      if (chunk.nextOffset === undefined) break;
      expect.assert(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
    expect(result).toBe(`${'甲📄'.repeat(2000)}[redacted]`);
    await journal.put({ ...record(2), result: '\u0001'.repeat(3000) });
    expect(
      JSON.stringify(
        await tools.invoke(run, 'bot_history_read', { runId: 'mock-history-0002', limit: 2000 }),
      ),
    ).toMatch(/HISTORY_RESPONSE_TOO_LARGE/);
    expect(
      value<Read>(
        await tools.invoke(run, 'bot_history_read', { runId: 'mock-history-0002', limit: 500 }),
      ).content.length,
    ).toBe(500);
    const limited = { ...run, toolCount: 0, limit: 1 };
    await tools.invoke(limited, 'bot_history_search');
    expect(
      JSON.stringify(
        await tools.invoke(limited, 'bot_history_read', { runId: 'mock-history-0001' }),
      ),
    ).toMatch(/TOOL_LIMIT/);
    const aborted = { ...run, abort: new AbortController() };
    aborted.abort.abort();
    expect(JSON.stringify(await tools.invoke(aborted, 'bot_history_search'))).toMatch(
      /MODEL_CANCELLED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('multi-turn records with long replies survive a journal reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-journal-turns-'));
  try {
    const reply = '合'.repeat(65000);
    expect(reply.length).toBe(65000);
    const turns = Array.from({ length: 6 }, (_, index) => ({
      id: `mock-long-turn-${index}`,
      prompt: `合成插话 ${index}`,
      result: reply,
    }));
    const journal = new TaskJournal(root);
    await journal.load();
    const saved: TaskRecord = { ...record(1), turns, result: reply };
    await journal.put(saved);
    // Written records stay readable: the load cap must match the write cap.
    expect.assert(
      Buffer.byteLength(JSON.stringify({ version: 1, task: saved })) > 1024 * 1024,
      'synthetic record must exceed the old one-megabyte limit',
    );
    const recovered = new TaskJournal(root);
    await recovered.load();
    const loaded = await recovered.read('a', record(1).runId);
    expect(loaded?.turns?.length).toBe(6);
    expect(loaded?.turns?.[5].result).toBe(reply);
    expect(loaded?.result).toBe(reply);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a record above the journal write cap is refused instead of saved unreadable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-journal-limit-'));
  try {
    const journal = new TaskJournal(root);
    await journal.load();
    await expect(
      journal.put({ ...record(1), result: 'x'.repeat(recordLimit) }),
    ).rejects.toMatchObject({
      code: 'TASK_RECORD_TOO_LARGE',
    });
    const recovered = new TaskJournal(root);
    await recovered.load();
    expect(recovered.records.size).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a legacy insert list is dropped alone so the saved task stays readable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-journal-legacy-'));
  try {
    await mkdir(root, { recursive: true });
    const legacy = {
      ...record(1),
      inserts: ['mock-legacy-insert'],
      turns: [{ id: 'mock-legacy-turn', prompt: '合成插话', result: '合成回答' }],
    };
    await writeFile(
      path.join(root, `${record(1).runId}.json`),
      JSON.stringify({ version: 1, task: legacy }),
    );
    const journal = new TaskJournal(root);
    await journal.load();
    const loaded = await journal.read('a', record(1).runId);
    expect(loaded?.result).toBe(record(1).result);
    expect(loaded?.inserts).toBe(undefined);
    expect(loaded?.turns?.length).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('history search and reads cover every turn of a multi-turn record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-history-turns-'));
  try {
    const journal = new TaskJournal(root);
    await journal.load();
    await journal.put({
      ...record(7),
      prompt: '合成原始请求',
      result: '合成最终回答',
      turns: [
        { id: 'mock-request-7', prompt: '合成原始请求', result: '合成原始回答' },
        { id: 'mock-insert-7', prompt: '合成插话内容', result: '合成最终回答' },
      ],
    });
    const history = new HistoryTools(journal);
    const run = { bot: 'a', id: 'current', abort: new AbortController() };
    const inserted = (await history.invoke(run, 'bot_history_search', {
      query: '插话内容',
    })) as Search;
    expect(inserted.matches.length).toBe(1);
    expect(inserted.matches[0].preview.field).toBe('prompt');
    expect(inserted.matches[0].preview.turn).toBe(1);
    // The original reply is stored on its own turn, not only as the final answer.
    const original = (await history.invoke(run, 'bot_history_search', {
      query: '原始回答',
    })) as Search;
    expect(original.matches.length).toBe(1);
    expect(original.matches[0].preview.field).toBe('result');
    expect(original.matches[0].preview.turn).toBe(0);
    const last = (await history.invoke(run, 'bot_history_read', {
      runId: record(7).runId,
    })) as Read;
    expect(last.content).toBe('合成最终回答');
    expect(last.turns).toBe(2);
    const first = (await history.invoke(run, 'bot_history_read', {
      runId: record(7).runId,
      field: 'result',
      turn: 0,
    })) as Read;
    expect(first.content).toBe('合成原始回答');
    expect(first.turn).toBe(0);
    const prompt = (await history.invoke(run, 'bot_history_read', {
      runId: record(7).runId,
      field: 'prompt',
      turn: 1,
    })) as Read;
    expect(prompt.content).toBe('合成插话内容');
    await expect(
      history.invoke(run, 'bot_history_read', { runId: record(7).runId, turn: 2 }),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY_QUERY' });
    await journal.put(record(8));
    await expect(
      history.invoke(run, 'bot_history_read', { runId: record(8).runId, turn: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY_QUERY' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
