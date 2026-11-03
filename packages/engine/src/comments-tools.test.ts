import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkComment, WorkCommentPage, WorkItem } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { redact } from './redaction.js';
import { Work } from './work.js';
import { WorkTools } from './work-tools.js';
import { WorkspaceFiles } from './workspace.js';

function value<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBe(undefined);
  const content = result.content[0];
  expect(content.type).toBe('text');
  return JSON.parse(content.type === 'text' ? content.text : '') as T;
}
type Posted = {
  untrusted: boolean;
  item: WorkItem;
  comment: WorkComment;
  acceptedRevision: number;
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-comments-tools-'));
  const workdir = path.join(root, 'workspace');
  await mkdir(workdir);
  const store = new Work(path.join(root, 'work.sqlite'));
  const tools = new AgentTools(undefined, new WorkspaceFiles(workdir));
  tools.work = new WorkTools(store);
  const created = await store.write(
    {
      id: 'mock-create',
      item: 'mock-task',
      action: 'create',
      revision: 0,
      value: {
        title: '合成讨论任务',
        description: 'MOCK PRESERVED DETAIL',
        progress: 'MOCK VERIFIED PROGRESS',
        status: 'done',
      },
    },
    { kind: 'human' },
  );
  t.onTestFinished(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  expect.assert(tools.list('mock-alpha').some((tool) => tool.name === 'work_comment'));
  const run = (bot = 'mock-alpha', id = 'mock-user-intent'): AgentToolRun => ({
    id,
    bot,
    abort: new AbortController(),
    toolCount: 0,
    limit: 60,
    seen: {},
    trace: [],
    workdir,
    canonicalRoot: workdir,
  });
  return { root, store, tools, run, item: created.item };
}
function latch() {
  let release!: () => unknown;
  const promise = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  return { promise, release };
}

test('discussion tools require full card reads, share provenance and preserve completion without a screen', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  const a = run(),
    b = run('mock-beta', 'mock-second-request');
  for (const name of ['work_comments', 'work_comment'])
    expect.assert(
      tools.list(a.bot).some((tool) => tool.name === name),
      name,
    );
  expect(tools.list(a.bot).some((tool) => tool.name === 'screenshot')).toBe(false);
  const before = value<WorkCommentPage>(await tools.invoke(a, 'work_comments', { id: item.id }));
  expect(before.comments).toStrictEqual([]);
  expect(
    JSON.stringify(
      await tools.invoke(a, 'work_comment', { id: item.id, revision: 1, body: '合成讨论甲' }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  await tools.invoke(a, 'work_read', { id: item.id });
  const posted = value<Posted>(
    await tools.invoke(a, 'work_comment', {
      id: item.id,
      revision: 1,
      body: ' 合成讨论甲\n保留原文 ',
    }),
  );
  expect(posted.untrusted).toBe(true);
  expect(posted.comment.body).toBe(' 合成讨论甲\n保留原文 ');
  expect(posted.comment.createdBy).toStrictEqual({ kind: 'bot', bot: a.bot });
  expect(posted.item.revision).toBe(2);
  for (const field of ['title', 'description', 'progress', 'status', 'completedAt'] as const)
    expect(posted.item[field], field).toBe(item[field]);
  const seen = value<WorkCommentPage>(await tools.invoke(b, 'work_comments', { id: item.id }));
  expect(seen.comments[0].id).toBe(posted.comment.id);
  expect(
    JSON.stringify(
      await tools.invoke(b, 'work_comment', { id: item.id, revision: 2, body: '合成讨论乙' }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  await tools.invoke(b, 'work_read', { id: item.id });
  value<Posted>(
    await tools.invoke(b, 'work_comment', { id: item.id, revision: 2, body: '合成讨论乙' }),
  );
  expect(
    JSON.stringify(
      await tools.invoke(b, 'work_update', {
        id: item.id,
        revision: 3,
        patch: { progress: 'MOCK UNREAD EDIT' },
      }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  expect((await store.comments({ item: item.id })).comments.length).toBe(2);
  expect.assert([...a.trace, ...b.trace].every((row) => row.surface === 'work'));
});

test('comment identity survives key order and continuation/reconstruction without repeating onto newer trash', async (t) => {
  const { root, store, tools, run, item } = await fixture(t);
  const a = run();
  await tools.invoke(a, 'work_read', { id: item.id });
  const args = { id: item.id, revision: 1, body: '合成同一次评论' };
  const first = value<Posted>(await tools.invoke(a, 'work_comment', args));
  await store.write(
    {
      id: 'mock-human-edit',
      item: item.id,
      action: 'update',
      revision: 2,
      value: { description: 'MOCK NEWER HUMAN DETAIL' },
    },
    { kind: 'human' },
  );
  await store.write(
    { id: 'mock-human-trash', item: item.id, action: 'trash', revision: 3 },
    { kind: 'human' },
  );
  await store.close();
  const reopened = new Work(path.join(root, 'work.sqlite'));
  t.onTestFinished(async () => {
    await reopened.close();
  });
  tools.work = new WorkTools(reopened);
  const continuation = { ...run(a.bot, 'mock-next-run'), intentId: a.id };
  const retry = value<Posted>(
    await tools.invoke(continuation, 'work_comment', {
      body: args.body,
      revision: args.revision,
      id: args.id,
    }),
  );
  expect(retry.comment).toStrictEqual(first.comment);
  expect(retry.acceptedRevision).toBe(2);
  expect(retry.item.revision).toBe(4);
  expect(retry.item.deleted).toBe(true);
  expect(retry.item.description).toBe('MOCK NEWER HUMAN DETAIL');
  expect((await reopened.comments({ item: item.id })).comments.length).toBe(1);
  await reopened.write(
    { id: 'mock-human-restore', item: item.id, action: 'restore', revision: 4 },
    { kind: 'human' },
  );
  const fresh = run(a.bot, 'mock-distinct-user-request');
  await tools.invoke(fresh, 'work_read', { id: item.id });
  const second = value<Posted>(await tools.invoke(fresh, 'work_comment', { ...args, revision: 5 }));
  expect(second.comment.id).not.toBe(first.comment.id);
  expect((await reopened.comments({ item: item.id })).comments.length).toBe(2);
});

test('discussion pages retain stable cursors and literal bodies without granting edit observations', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  for (let i = 1; i <= 3; i++)
    await store.comment(
      { id: `mock-comment-${i}`, item: item.id, revision: i, body: `合成讨论 ${i}` },
      { kind: 'human' },
    );
  const a = run();
  const page = value<WorkCommentPage>(
    await tools.invoke(a, 'work_comments', { id: item.id, limit: 1 }),
  );
  expect(page.comments[0].body).toBe('合成讨论 3');
  expect.assert(page.nextBefore);
  await store.comment(
    { id: 'mock-later', item: item.id, revision: 4, body: '合成后来新增' },
    { kind: 'human' },
  );
  const next = value<WorkCommentPage>(
    await tools.invoke(a, 'work_comments', { id: item.id, before: page.nextBefore, limit: 1 }),
  );
  expect(next.comments[0].body).toBe('合成讨论 2');
  expect(
    JSON.stringify(
      await tools.invoke(a, 'work_comment', { id: item.id, revision: 5, body: '合成未授权写入' }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  expect((await store.get(item.id)).revision).toBe(5);
});

test('a delayed comment acknowledgement cannot consume a newer full-card observation', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  const a = run(),
    entered = latch(),
    gate = latch();
  await tools.invoke(a, 'work_read', { id: item.id });
  const comment = store.comment.bind(store);
  let hold = true;
  vi.spyOn(store, 'comment').mockImplementation(async (...args: Parameters<typeof comment>) => {
    const saved = await comment(...args);
    if (hold) {
      hold = false;
      entered.release();
      await gate.promise;
    }
    return saved;
  });
  const pending = tools.invoke(a, 'work_comment', {
    id: item.id,
    revision: 1,
    body: '合成迟到回执',
  });
  try {
    await entered.promise;
    value(await tools.invoke(a, 'work_read', { id: item.id }));
    gate.release();
    value(await pending);
    const next = value<Posted>(
      await tools.invoke(a, 'work_comment', { id: item.id, revision: 2, body: '合成较新读取' }),
    );
    expect(next.item.revision).toBe(3);
  } finally {
    gate.release();
    await pending;
  }
});

test('failed sanitized reads cannot authorize comments and observations stay bound to Bot/run/intent', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  const a = { ...run(), redact: (_text: string) => 'x'.repeat(140000) };
  expect(JSON.stringify(await tools.invoke(a, 'work_read', { id: item.id }))).toMatch(
    /WORK_RESPONSE_TOO_LARGE/,
  );
  a.redact = (text) => text;
  expect(
    JSON.stringify(
      await tools.invoke(a, 'work_comment', { id: item.id, revision: 1, body: '合成未读评论' }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  for (const field of ['bot', 'id', 'intentId'] as const) {
    const b = run();
    await tools.invoke(b, 'work_read', { id: item.id });
    b[field] = `mock-changed-${field}`;
    expect(
      JSON.stringify(
        await tools.invoke(b, 'work_comment', {
          id: item.id,
          revision: 1,
          body: '合成跨上下文拒绝',
        }),
      ),
    ).toMatch(/WORK_READ_REQUIRED/);
  }
  expect((await store.comments({ item: item.id })).comments.length).toBe(0);
});

test('comment intent is captured before receipt awaits and context changes cannot retarget an effect', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  const a = run(),
    entered = latch(),
    gate = latch();
  await tools.invoke(a, 'work_read', { id: item.id });
  const receipt = store.commentReceipt.bind(store);
  vi.spyOn(store, 'commentReceipt').mockImplementation(
    async (...args: Parameters<typeof receipt>) => {
      const result = await receipt(...args);
      entered.release();
      await gate.promise;
      return result;
    },
  );
  const args = { id: item.id, revision: 1, body: '合成最初请求' };
  const pending = tools.invoke(a, 'work_comment', args);
  try {
    await entered.promise;
    args.body = 'MOCK LATE MUTATION';
    gate.release();
    expect(value<Posted>(await pending).comment.body).toBe('合成最初请求');
  } finally {
    gate.release();
    await pending;
  }
  vi.restoreAllMocks();
  const b = run('mock-beta'),
    entered2 = latch(),
    gate2 = latch();
  await tools.invoke(b, 'work_read', { id: item.id });
  vi.spyOn(store, 'commentReceipt').mockImplementation(
    async (...params: Parameters<typeof receipt>) => {
      const result = await receipt(...params);
      entered2.release();
      await gate2.promise;
      return result;
    },
  );
  const changed = tools.invoke(b, 'work_comment', {
    id: item.id,
    revision: 2,
    body: '合成拒绝改派',
  });
  try {
    await entered2.promise;
    b.intentId = 'mock-rebound-intent';
    gate2.release();
    expect(JSON.stringify(await changed)).toMatch(/WORK_CONTEXT_CHANGED/);
  } finally {
    gate2.release();
    await changed;
  }
  expect((await store.comments({ item: item.id })).comments.length).toBe(1);
});

test('closed discussion arguments, shared budget and cancellation reject effects without bypasses', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  for (const [name, args] of [
    ['work_comments', { id: item.id, limit: 21 }],
    ['work_comments', { id: item.id, before: 0 }],
    ['work_comments', { id: item.id, bot: 'mock-other' }],
    ['work_comment', { id: item.id, revision: 1, body: '  ' }],
    ['work_comment', { id: item.id, revision: 1, body: '合成', actor: { kind: 'human' } }],
    ['work_comment', { id: item.id, revision: 1, body: '合成', operation: 'mock-forged' }],
    [
      'work_comment',
      Object.assign(Object.create({ actor: 'mock-inherited' }), {
        id: item.id,
        revision: 1,
        body: '合成',
      }),
    ],
  ] as const) {
    const a = run();
    await tools.invoke(a, 'work_read', { id: item.id });
    expect((await tools.invoke(a, name, args)).isError).toBe(true);
  }
  const limited = { ...run(), limit: 1 };
  value(await tools.invoke(limited, 'work_comments', { id: item.id }));
  expect(
    JSON.stringify(
      await tools.invoke(limited, 'work_comment', { id: item.id, revision: 1, body: '合成超额' }),
    ),
  ).toMatch(/TOOL_LIMIT/);
  const stopped = run();
  await tools.invoke(stopped, 'work_read', { id: item.id });
  const receipt = store.commentReceipt.bind(store);
  vi.spyOn(store, 'commentReceipt').mockImplementation(
    async (...args: Parameters<typeof receipt>) => {
      const result = await receipt(...args);
      stopped.abort.abort();
      return result;
    },
  );
  expect(
    JSON.stringify(
      await tools.invoke(stopped, 'work_comment', { id: item.id, revision: 1, body: '合成取消' }),
    ),
  ).toMatch(/MODEL_CANCELLED/);
  await tools.drain(stopped);
  expect((await store.comments({ item: item.id })).comments.length).toBe(0);
});

test('discussion results redact decoded credentials while stored text and authors remain literal', async (t) => {
  const { store, tools, run, item } = await fixture(t);
  const secret = 'mock-"provider\\secret\n49';
  await store.comment(
    { id: 'mock-human-secret', item: item.id, revision: 1, body: `合成参考 ${secret}` },
    { kind: 'human' },
  );
  const a = { ...run(), redact: (text: string) => redact(text, [secret]) };
  const page = value<WorkCommentPage>(await tools.invoke(a, 'work_comments', { id: item.id }));
  expect(page.comments[0].body.includes(secret)).toBe(false);
  await tools.invoke(a, 'work_read', { id: item.id });
  const posted = value<Posted>(
    await tools.invoke(a, 'work_comment', { id: item.id, revision: 2, body: `合成回复 ${secret}` }),
  );
  expect(posted.comment.body.includes(secret)).toBe(false);
  expect(JSON.stringify(a.trace).includes(secret)).toBe(false);
  expect((await store.comments({ item: item.id })).comments[0].body).toBe(`合成回复 ${secret}`);
});
