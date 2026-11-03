import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkItem } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { CatalogTools } from './catalog.js';
import type { ToolResult } from './computer-tools.js';
import { redact, redactStream } from './redaction.js';
import { Work } from './work.js';
import { WorkTools, workToolList } from './work-tools.js';
import { WorkspaceFiles } from './workspace.js';

function value<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBe(undefined);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.type === 'text' ? block.text : '') as T;
}
const item = (result: ToolResult) => value<{ untrusted: boolean; item: WorkItem }>(result).item;
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-work-tools-'));
  const workdir = path.join(root, 'workspace');
  await mkdir(workdir);
  const store = new Work(path.join(root, 'work.sqlite'));
  const tools = new AgentTools(undefined, new WorkspaceFiles(workdir));
  tools.work = new WorkTools(store);
  t.onTestFinished(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
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
  return { root, store, tools, run };
}

test('shared Work tools use one store across Bots, require full reads and preserve unrelated fields', async (t) => {
  const { store, tools, run } = await fixture(t);
  const a = run(),
    b = run('mock-beta', 'mock-second-intent');
  expect.assert(
    workToolList.every((tool) => tools.list(a.bot).some((entry) => entry.name === tool.name)),
  );
  expect(tools.list(a.bot).some((tool) => tool.name === 'screenshot')).toBe(false);
  const created = item(
    await tools.invoke(a, 'work_create', {
      title: ' 合成共享任务 ',
      description: 'MOCK KEEP DETAIL',
    }),
  );
  expect(created.title).toBe('合成共享任务');
  expect(created.createdBy).toStrictEqual({ kind: 'bot', bot: a.bot });
  const list = value<{ untrusted: boolean; items: { id: string }[] }>(
    await tools.invoke(b, 'work_list'),
  );
  expect(list.untrusted).toBe(true);
  expect(list.items[0].id).toBe(created.id);
  expect(
    JSON.stringify(
      await tools.invoke(b, 'work_update', {
        id: created.id,
        revision: 1,
        patch: { status: 'doing' },
      }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  await tools.invoke(b, 'work_read', { id: created.id });
  const changed = item(
    await tools.invoke(b, 'work_update', {
      id: created.id,
      revision: 1,
      patch: { status: 'doing', progress: 'MOCK CHECKED STEP' },
    }),
  );
  expect(changed.description).toBe(created.description);
  expect(changed.updatedBy).toStrictEqual({ kind: 'bot', bot: b.bot });
  expect(changed.createdBy).toStrictEqual(created.createdBy);
  await tools.invoke(a, 'work_read', { id: created.id });
  await store.write(
    {
      id: 'mock-human-newer',
      item: created.id,
      action: 'update',
      revision: 2,
      value: { title: '合成人工修改' },
    },
    { kind: 'human' },
  );
  expect(
    JSON.stringify(
      await tools.invoke(a, 'work_update', {
        id: created.id,
        revision: 2,
        patch: { status: 'done' },
      }),
    ),
  ).toMatch(/WORK_CONFLICT/);
  expect((await store.get(created.id)).title).toBe('合成人工修改');
  await tools.invoke(a, 'work_read', { id: created.id });
  const done = item(
    await tools.invoke(a, 'work_update', {
      id: created.id,
      revision: 3,
      patch: { status: 'done' },
    }),
  );
  expect.assert(done.completedAt);
  await tools.invoke(b, 'work_read', { id: created.id });
  const trash = item(await tools.invoke(b, 'work_trash', { id: created.id, revision: 4 }));
  expect(trash.deleted).toBe(true);
  expect((await store.list()).items.length).toBe(0);
  await tools.invoke(a, 'work_read', { id: created.id });
  const restored = item(await tools.invoke(a, 'work_restore', { id: created.id, revision: 5 }));
  expect(restored.deleted).toBe(false);
  expect(restored.completedAt).toBe(done.completedAt);
  expect(JSON.stringify(a.trace).includes('MOCK KEEP DETAIL')).toBe(false);
  expect.assert(
    [...a.trace, ...b.trace].every(
      (entry) => entry.surface === 'work' && entry.phase !== 'running',
    ),
  );
});

test('create identity survives argument order, continuation and store reconstruction without reverting later human edits', async (t) => {
  const { root, store, tools, run } = await fixture(t);
  const a = run();
  const args = {
    title: '合成稳定创建',
    description: 'MOCK DESCRIPTION',
    progress: '',
    status: 'todo',
  };
  const first = item(await tools.invoke(a, 'work_create', args));
  expect(first.id).toBe('work-f959efa272cada714edcdb987e7ba1ccbeb50b3f654812a71cd74187b9cbf7e5');
  const human = await store.write(
    {
      id: 'mock-human-progress',
      item: first.id,
      revision: 1,
      action: 'update',
      value: { progress: 'MOCK HUMAN NEWER' },
    },
    { kind: 'human' },
  );
  const repeated = item(
    await tools.invoke(a, 'work_create', {
      status: 'todo',
      progress: '',
      description: args.description,
      title: args.title,
    }),
  );
  expect(repeated).toStrictEqual(human.item);
  await store.close();
  const reopened = new Work(path.join(root, 'work.sqlite'));
  try {
    tools.work = new WorkTools(reopened);
    const continuation = { ...run(), id: 'mock-continuation', intentId: a.id };
    expect(item(await tools.invoke(continuation, 'work_create', args))).toStrictEqual(human.item);
    expect((await reopened.list()).items.length).toBe(1);
    const other = item(
      await tools.invoke(run('mock-alpha', 'mock-distinct-human-request'), 'work_create', args),
    );
    expect(other.id).not.toBe(first.id);
    expect((await reopened.list()).items.length).toBe(2);
  } finally {
    await reopened.close();
  }
});

test('exact edit replay is receipt-only after continuation and cannot overwrite newer state or edit an unobserved revision', async (t) => {
  const { store, tools, run } = await fixture(t);
  const a = run();
  const first = item(await tools.invoke(a, 'work_create', { title: '合成编辑重试' }));
  await tools.invoke(a, 'work_read', { id: first.id });
  const args = { id: first.id, revision: 1, patch: { progress: 'MOCK VERIFIED', status: 'doing' } };
  const edited = item(await tools.invoke(a, 'work_update', args));
  expect(edited.revision).toBe(2);
  const human = await store.write(
    {
      id: 'mock-new-human-status',
      item: first.id,
      revision: 2,
      action: 'update',
      value: { status: 'done' },
    },
    { kind: 'human' },
  );
  const resumed = { ...run(), id: 'mock-retry', intentId: a.id };
  expect(item(await tools.invoke(resumed, 'work_update', args))).toStrictEqual(human.item);
  expect(
    JSON.stringify(
      await tools.invoke(resumed, 'work_update', {
        ...args,
        revision: 3,
        patch: { status: 'todo' },
      }),
    ),
  ).toMatch(/WORK_READ_REQUIRED/);
  expect((await store.get(first.id)).status).toBe('done');
});

test('a delayed effect acknowledgement cannot consume a newer full-read observation', async (t) => {
  const { store, tools, run } = await fixture(t);
  const a = run();
  const first = item(await tools.invoke(a, 'work_create', { title: '合成迟到回执' }));
  await tools.invoke(a, 'work_read', { id: first.id });
  let entered!: () => unknown, release!: () => unknown;
  const committed = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const write = store.write.bind(store);
  let hold = true;
  vi.spyOn(store, 'write').mockImplementation(async (...args: Parameters<typeof write>) => {
    const saved = await write(...args);
    if (hold) {
      hold = false;
      entered();
      await gate;
    }
    return saved;
  });
  const pending = tools.invoke(a, 'work_update', {
    id: first.id,
    revision: 1,
    patch: { progress: 'MOCK FIRST STEP' },
  });
  try {
    await committed;
    expect(item(await tools.invoke(a, 'work_read', { id: first.id })).revision).toBe(2);
    release();
    item(await pending);
    expect(
      item(
        await tools.invoke(a, 'work_update', {
          id: first.id,
          revision: 2,
          patch: { status: 'doing' },
        }),
      ).revision,
    ).toBe(3);
  } finally {
    release();
    await pending;
  }
});

test('closed tool arguments cannot forge actor, identity, timestamps or empty patches', async (t) => {
  const { store, tools, run } = await fixture(t);
  const a = run();
  for (const [name, args] of [
    ['work_create', { title: '合成伪造来源', bot: 'mock-beta' }],
    ['work_create', { title: '合成伪造身份', id: 'mock-selected-id' }],
    ['work_create', { title: '合成伪造时间', completedAt: '2026-01-01T00:00:00Z' }],
    ['work_create', { title: '合成非法字段', description: null }],
    ['work_list', { limit: 21 }],
    ['work_list', { filter: ['all'] }],
    ['work_read', { id: '../mock-private' }],
    ['work_update', { id: 'mock-work', revision: 1, patch: {} }],
    ['work_restore', { id: 'mock-work', revision: 0 }],
  ] as const)
    expect((await tools.invoke(a, name, args)).isError).toBe(true);
  expect((await store.list()).items.length).toBe(0);
});

test('work tools share the existing budget and cancellation drain without leaking secret-bearing data in results or traces', async (t) => {
  const { store, tools, run } = await fixture(t);
  const limited = { ...run(), limit: 1 };
  await tools.invoke(limited, 'work_list');
  expect(
    JSON.stringify(await tools.invoke(limited, 'work_create', { title: '合成不得创建' })),
  ).toMatch(/TOOL_LIMIT/);
  expect((await store.list()).items.length).toBe(0);
  const stopped = run();
  const receipt = store.receipt.bind(store);
  vi.spyOn(store, 'receipt').mockImplementation(async (...args: Parameters<typeof receipt>) => {
    const value = await receipt(...args);
    stopped.abort.abort();
    return value;
  });
  expect(
    JSON.stringify(await tools.invoke(stopped, 'work_create', { title: '合成取消创建' })),
  ).toMatch(/MODEL_CANCELLED/);
  expect((await store.list()).items.length).toBe(0);
  vi.restoreAllMocks();
  const secret = 'mock-"provider\\secret\n47';
  await store.write(
    {
      id: 'mock-human-secret',
      item: 'mock-secret-item',
      action: 'create',
      revision: 0,
      value: { title: '合成脱敏', description: secret, progress: '', status: 'todo' },
    },
    { kind: 'human' },
  );
  const a = {
    ...run(),
    redact: (text: string) => text.replaceAll(secret, '[credential redacted]'),
  };
  const response = await tools.invoke(a, 'work_read', { id: 'mock-secret-item' });
  expect(value<{ item: WorkItem }>(response).item.description).toBe('[credential redacted]');
  expect(JSON.stringify(response).includes(secret)).toBe(false);
  expect(JSON.stringify(a.trace).includes(secret)).toBe(false);
  expect((await store.get('mock-secret-item')).description).toBe(secret);
  await tools.drain(a);
});

test('model list and catalog previews cannot publish a credential prefix cut by the core summary limit', async (t) => {
  const { store, tools, run } = await fixture(t);
  const secret = 'mock-provider-key-with-a-long-private-suffix';
  await store.write(
    {
      id: 'mock-preview-op',
      item: 'mock-preview-item',
      action: 'create',
      revision: 0,
      value: {
        title: '合成预览边界',
        description: '',
        progress: `${'x'.repeat(190)}${secret} continued`,
        status: 'todo',
      },
    },
    { kind: 'human' },
  );
  tools.catalog = new CatalogTools({
    work: store,
    schedules: () => undefined,
    offered: (job) => tools.list(job.bot),
  });
  const a = {
    ...run(),
    redact: (text: string) => redact(text, [secret]),
    redactResponse: (text: string) => redactStream(text, [secret]),
  };
  const list = value<{ items: { progress: string; progressTruncated: boolean }[] }>(
    await tools.invoke(a, 'work_list'),
  );
  expect(list.items[0].progress).toBe('x'.repeat(190));
  expect(list.items[0].progressTruncated).toBe(true);
  const catalog = value<{ work: { page: { items: { progress: string }[] } } }>(
    await tools.invoke(a, 'task_catalog'),
  );
  expect(catalog.work.page.items[0].progress).toBe('x'.repeat(190));
});
