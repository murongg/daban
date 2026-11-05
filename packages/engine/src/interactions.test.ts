import { type FileHandle, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import * as durability from './durability.js';
import { Interactions } from './interactions.js';
import { privateMetadata, secureDirectory } from './private-files.js';

test('health keeps corrupt interaction records private and retained', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-interaction-health-'));
  try {
    await writeFile(path.join(dir, 'mock-corrupt.json'), 'SYNTHETIC-INVALID-INTERACTION');
    const store = new Interactions(dir);
    expect(await store.status()).toStrictEqual({ available: true, corrupt: 1 });
    expect(await readFile(path.join(dir, 'mock-corrupt.json'), 'utf8')).toBe(
      'SYNTHETIC-INVALID-INTERACTION',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('historical MCP consent stays readable after restart but cannot approve a new call', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-historical-consent-'));
  const input = {
    id: 'mock-historical',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'mcp_call',
    connection: 'mock-connection',
    configRevision: 1,
    catalogDigest: 'a'.repeat(64),
    name: 'Synthetic connection',
    origin: 'https://example.test',
    operation: 'synthetic_write',
    arguments: '{"value":"SYNTHETIC"}',
    inputHash: 'b'.repeat(64),
  };
  const historical = {
    ...input,
    bot: 'mock-bot',
    runId: 'mock-old-run',
    status: 'resolved',
    reply: { kind: 'decision', allow: true, confirmPurpose: true },
    purposeScope: { taskId: 'mock-task', turnId: 'mock-turn' },
    policyDecision: { effect: 'allow', source: 'rule', requestHash: 'c'.repeat(64) },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  try {
    const file = path.join(directory, `${input.id}.json`);
    const bytes = JSON.stringify({ version: 1, request: historical });
    await writeFile(file, bytes);
    const store = new Interactions(directory);
    expect(await store.status()).toEqual({ available: true, corrupt: 0 });
    expect(await store.list()).toEqual([
      expect.objectContaining({
        id: input.id,
        status: 'resolved',
        reply: { kind: 'decision', allow: true },
      }),
    ]);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    await writeFile(
      path.join(directory, 'mock-invalid.json'),
      JSON.stringify({
        version: 1,
        request: { ...historical, id: 'mock-invalid', decisionSource: 'policy' },
      }),
    );
    const reopened = new Interactions(directory);
    expect(await reopened.status()).toEqual({ available: true, corrupt: 1 });
    expect(await reopened.list()).toHaveLength(1);
    const fresh = await store.open('mock-bot', 'mock-new-run', { ...input, id: 'mock-new-call' });
    expect(fresh.status).toBe('pending');
    await expect(
      store.reply('mock-other', 'mock-new-run', fresh.id, { kind: 'decision', allow: true }),
    ).rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' });
    await store.endRun('mock-bot', 'mock-new-run');
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test('full-access policy commits scoped automatic approvals but never answers questions or rewrites prior decisions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-policy-approval-'));
  const store = new Interactions(
    directory,
    undefined,
    (bot: string, runId: string) => bot === 'mock-bot' && runId === 'mock-full-run',
  );
  const approval = {
    id: 'mock-policy-web',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'web_fetch',
    url: 'https://example.test/mock',
  };
  try {
    const result = await store.open('mock-bot', 'mock-full-run', approval);
    expect(result).toMatchObject({
      status: 'resolved',
      reply: { kind: 'decision', allow: true },
      decisionSource: 'policy',
    });
    expect((await store.open('mock-bot', 'mock-full-run', question)).status).toBe('pending');
    const other = await store.open('mock-other', 'mock-full-run', {
      ...approval,
      id: 'mock-other-web',
    });
    expect(other.status).toBe('pending');
    await store.reply('mock-other', 'mock-full-run', other.id, { kind: 'decision', allow: false });
    expect(
      (await store.open('mock-other', 'mock-full-run', { ...approval, id: other.id })).reply,
    ).toEqual({ kind: 'decision', allow: false });
    const restored = new Interactions(directory);
    expect((await restored.list()).find((item) => item.id === approval.id)).toMatchObject({
      status: 'resolved',
      decisionSource: 'policy',
    });
    await store.endRun('mock-bot', 'mock-full-run');
    await expect(
      store.open('mock-bot', 'mock-full-run', { ...approval, id: 'mock-late' }),
    ).rejects.toMatchObject({ code: 'INTERACTION_CLOSED' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
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
    expect(opened.status).toBe('pending');
    await expect(
      store.open('mock-bot', 'mock-run', { ...input, arguments: '{"value":48}' }, 'mock-group'),
    ).rejects.toMatchObject({ code: 'INTERACTION_CONFLICT' });
    await expect(
      store.reply('mock-other', 'mock-run', input.id, { kind: 'decision', allow: true }),
    ).rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' });
    const allowed = await store.reply('mock-bot', 'mock-run', input.id, {
      kind: 'decision',
      allow: true,
    });
    expect(allowed.reply?.kind).toBe('decision');
    const restored = new Interactions(directory);
    expect((await restored.list())[0].conversationId).toBe('mock-group');
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
    expect(cancelled).toBe(true);
    expect((await store.list())[0].status).toBe('pending');
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
    expect.assert('conversationId' in item);
    expect(item.conversationId).toBe('mock-group');
    await expect(store.open('mock-bot', 'mock-run', question, 'other-group')).rejects.toMatchObject(
      {
        code: 'INTERACTION_CONFLICT',
      },
    );
    await store.reply('mock-bot', 'mock-run', question.id, answer);
    const recovered = new Interactions(directory);
    await recovered.ready;
    expect.assert('conversationId' in (await recovered.list())[0]);
    expect((await recovered.list())[0].status).toBe('resolved');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('questions persist before waiting, accept one exact answer and reject conflicting or foreign replies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-interactions-'));
  const directory = await secureDirectory(path.join(root, 'private'));
  try {
    const store = new Interactions(directory);
    await store.ready;
    const opened = await store.open('mock-bot', 'mock-run', question);
    expect(opened.status).toBe('pending');
    const file = path.join(directory, 'mock-question.json');
    expect(await privateMetadata(file, await lstat(file), 0o600)).toBe(true);
    expect(await store.open('mock-bot', 'mock-run', question)).toStrictEqual(opened);
    await expect(
      store.open('mock-bot', 'mock-run', {
        ...question,
        questions: [{ id: 'other', question: '另一项合成问题？' }],
      }),
    ).rejects.toMatchObject({ code: 'INTERACTION_CONFLICT' });
    const waiting = store.wait('mock-bot', 'mock-run', question.id);
    await expect(store.reply('other-bot', 'mock-run', question.id, answer)).rejects.toMatchObject({
      code: 'INTERACTION_NOT_FOUND',
    });
    await expect(store.reply('mock-bot', 'other-run', question.id, answer)).rejects.toMatchObject({
      code: 'INTERACTION_NOT_FOUND',
    });
    await expect(
      store.reply('mock-bot', 'mock-run', question.id, {
        kind: 'answer',
        answers: [{ id: 'format', selected: ['invented'] }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INTERACTION_REPLY' });
    const saved = await store.reply('mock-bot', 'mock-run', question.id, answer);
    expect(saved.status).toBe('resolved');
    expect((await waiting).reply).toStrictEqual(answer);
    expect(await store.reply('mock-bot', 'mock-run', question.id, answer)).toStrictEqual(saved);
    await expect(
      store.reply('mock-bot', 'mock-run', question.id, {
        kind: 'answer',
        answers: [{ id: 'format', selected: ['纯文本'] }],
      }),
    ).rejects.toMatchObject({ code: 'INTERACTION_CONFLICT' });
    expect((await new Interactions(directory).list())[0].reply).toStrictEqual(answer);
    await store.endRun('mock-bot', 'mock-run');
    await expect(store.open('mock-bot', 'mock-run', question)).rejects.toMatchObject({
      code: 'INTERACTION_CLOSED',
    });
    await expect(
      new Interactions(directory).open('mock-bot', 'mock-run', question),
    ).rejects.toMatchObject({
      code: 'INTERACTION_CLOSED',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
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
    expect((await restarted.list())[0].status).toBe('interrupted');
    await expect(
      restarted.reply('mock-bot', 'mock-run', request.id, { kind: 'decision', allow: true }),
    ).rejects.toMatchObject({ code: 'INTERACTION_CLOSED' });
    const another = { ...request, id: 'mock-reject' };
    await restarted.open('mock-bot', 'next-run', another);
    expect(
      (
        await restarted.reply('mock-bot', 'next-run', another.id, {
          kind: 'decision',
          allow: false,
        })
      ).reply?.kind,
    ).toBe('decision');
    const pending = { ...request, id: 'mock-stop' };
    await restarted.open('mock-bot', 'cancelled-run', pending);
    const waiting = restarted.wait('mock-bot', 'cancelled-run', pending.id);
    await restarted.endRun('mock-bot', 'cancelled-run');
    expect((await waiting).status).toBe('cancelled');
    await expect(
      restarted.open('mock-bot', 'cancelled-run', { ...pending, id: 'mock-late' }),
    ).rejects.toMatchObject({ code: 'INTERACTION_CLOSED' });
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
      await expect(store.open('mock-bot', 'mock-run', input)).rejects.toMatchObject({
        code: 'INVALID_INTERACTION',
      });
    await store.open('mock-bot', 'mock-run', question);
    for (const reply of [
      { kind: 'decision', allow: true },
      { ...answer, credentials: 'mock-secret' },
      { kind: 'answer', answers: [] },
      { kind: 'answer', answers: [{ id: 'format', selected: ['Markdown', '纯文本'] }] },
    ])
      await expect(store.reply('mock-bot', 'mock-run', question.id, reply)).rejects.toMatchObject({
        code: 'INVALID_INTERACTION_REPLY',
      });
    await writeFile(path.join(directory, 'mock-corrupt.json'), '{broken');
    const reloaded = new Interactions(directory);
    await expect(
      reloaded.open('mock-bot', 'mock-next', { ...question, id: 'mock-corrupt' }),
    ).rejects.toMatchObject({ code: 'INTERACTION_CORRUPT' });
    expect(await readFile(path.join(directory, 'mock-corrupt.json'), 'utf8')).toBe('{broken');
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
    await expect(reply).rejects.toMatchObject({ code: 'INTERACTION_CLOSED' });
    await stop;
    expect((await store.list())[0].status).toBe('cancelled');
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
    await expect(reply).rejects.toMatchObject({ code: 'INTERACTION_CLOSED' });
    await stopping;
    expect((await store.list())[0].status).toBe('cancelled');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an approval flushes its file and awaits the platform directory barrier before publishing or releasing a waiter', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-approval-sync-order-'));
  const events: string[] = [];
  const store = new Interactions(directory, (item) => {
    if (item.status === 'resolved') events.push('published');
  });
  const input = {
    id: 'mock-sync-order',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'web_fetch',
    url: 'https://example.test/synthetic',
  };
  let restore = () => undefined;
  try {
    await store.open('mock-bot', 'mock-run', input);
    const probe = await open(path.join(directory, 'mock-probe'), 'w');
    const prototype: FileHandle = Object.getPrototypeOf(probe);
    const sync = prototype.sync;
    await probe.close();
    const mocked = vi.spyOn(prototype, 'sync').mockImplementation(async function (
      this: FileHandle,
    ) {
      if ((await this.stat()).isDirectory()) return sync.call(this);
      const saved = JSON.parse(await readFile(path.join(directory, `${input.id}.json`), 'utf8'));
      expect(saved.request.status).toBe('pending');
      expect(store.pending('mock-bot', 'mock-run')).toBe(true);
      await sync.call(this);
      events.push('file-synced');
    });
    const syncParent = durability.syncDirectory;
    const parent = vi.spyOn(durability, 'syncDirectory').mockImplementation(async (handle) => {
      const saved = JSON.parse(await readFile(path.join(directory, `${input.id}.json`), 'utf8'));
      expect(saved.request.status).toBe('resolved');
      expect(store.pending('mock-bot', 'mock-run')).toBe(true);
      await syncParent(handle);
      events.push('directory-barrier');
    });
    restore = () => {
      mocked.mockRestore();
      parent.mockRestore();
      return undefined;
    };
    const waiting = store.wait('mock-bot', 'mock-run', input.id).then((item) => {
      events.push('waiter');
      return item;
    });
    await store.reply('mock-bot', 'mock-run', input.id, { kind: 'decision', allow: true });
    expect((await waiting).status).toBe('resolved');
    expect(events).toStrictEqual(['file-synced', 'directory-barrier', 'published', 'waiter']);
  } finally {
    restore();
    await store.endRun('mock-bot', 'mock-run');
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failedKind of ['file', 'directory']) {
  test(`a ${failedKind} sync failure cannot publish or release an approval grant`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), `mock-${failedKind}-sync-failure-`));
    const published: string[] = [];
    const store = new Interactions(directory, (item) => {
      published.push(item.status);
    });
    const input = {
      id: 'mock-sync-failure',
      sessionId: 'mock-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/synthetic',
    };
    const abort = new AbortController();
    let restore = () => undefined;
    let waiting: Promise<unknown> | undefined;
    try {
      await store.open('mock-bot', 'mock-run', input);
      published.length = 0;
      const probe = await open(path.join(directory, 'mock-probe'), 'w');
      const prototype: FileHandle = Object.getPrototypeOf(probe);
      const sync = prototype.sync;
      await probe.close();
      const mocked = vi.spyOn(prototype, 'sync').mockImplementation(async function (
        this: FileHandle,
      ) {
        const kind = (await this.stat()).isDirectory() ? 'directory' : 'file';
        if (kind === 'file' && failedKind === 'file') throw new Error('MOCK_APPROVAL_SYNC_FAILED');
        return sync.call(this);
      });
      const syncParent = durability.syncDirectory;
      const parent = vi.spyOn(durability, 'syncDirectory').mockImplementation(async (handle) => {
        if (failedKind === 'directory') throw new Error('MOCK_APPROVAL_SYNC_FAILED');
        return syncParent(handle);
      });
      restore = () => {
        mocked.mockRestore();
        parent.mockRestore();
        return undefined;
      };
      let released = false;
      waiting = store
        .wait('mock-bot', 'mock-run', input.id, abort.signal)
        .then(() => {
          released = true;
        })
        .catch(() => undefined);
      await expect(
        store.reply('mock-bot', 'mock-run', input.id, { kind: 'decision', allow: true }),
      ).rejects.toThrowError(/MOCK_APPROVAL_SYNC_FAILED/);
      expect(released).toBe(false);
      expect(published).toStrictEqual([]);
      expect((await store.list())[0].status).toBe('pending');
    } finally {
      restore();
      abort.abort();
      await waiting;
      await store.endRun('mock-bot', 'mock-run');
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test.each([false, true])(
  'stopping during the final directory sync withdraws manual or automatic authority (%s)',
  {
    timeout: 2000,
  },
  async (automatic) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mock-stop-directory-sync-'));
    const store = new Interactions(directory, undefined, () => automatic);
    const input = {
      id: 'mock-stop-directory-sync',
      sessionId: 'mock-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/synthetic',
    };
    let entered: () => unknown = () => undefined;
    let release: () => unknown = () => undefined;
    const started = new Promise((resolve) => {
      entered = () => resolve(undefined);
    });
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    let restore = () => undefined;
    try {
      await store.ready;
      if (!automatic) await store.open('mock-bot', 'mock-run', input);
      const syncParent = durability.syncDirectory;
      let intercepted = false;
      const mocked = vi.spyOn(durability, 'syncDirectory').mockImplementation(async (handle) => {
        if (!intercepted) {
          intercepted = true;
          entered();
          await held;
        }
        return syncParent(handle);
      });
      restore = () => {
        mocked.mockRestore();
        return undefined;
      };
      const waiting = automatic ? undefined : store.wait('mock-bot', 'mock-run', input.id);
      const responding = expect(
        automatic
          ? store.open('mock-bot', 'mock-run', input)
          : store.reply('mock-bot', 'mock-run', input.id, { kind: 'decision', allow: true }),
      ).rejects.toMatchObject({ code: 'INTERACTION_CLOSED' });
      await started;
      const stopped = store.endRun('mock-bot', 'mock-run');
      release();
      await responding;
      await stopped;
      if (waiting) expect((await waiting).status).toBe('cancelled');
      const cancelled = (await store.list())[0];
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.decisionSource).toBeUndefined();
    } finally {
      release();
      restore();
      await store.endRun('mock-bot', 'mock-run');
      await rm(directory, { recursive: true, force: true });
    }
  },
);
