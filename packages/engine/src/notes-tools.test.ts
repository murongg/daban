import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NoteItem } from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { CatalogTools } from './catalog.js';
import type { ToolResult } from './computer-tools.js';
import { Fault } from './control.js';
import { Notes } from './notes.js';
import { NotesTools, notesToolList } from './notes-tools.js';
import { redact, redactStream } from './redaction.js';
import { Work } from './work.js';
import { WorkspaceFiles } from './workspace.js';

function value<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBe(undefined);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.type === 'text' ? block.text : '') as T;
}
const item = (result: ToolResult) => value<{ untrusted: boolean; item: NoteItem }>(result).item;
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-note-tools-')),
    workdir = path.join(root, 'workspace');
  await mkdir(workdir);
  const store = new Notes(path.join(root, 'notes.sqlite')),
    work = new Work(path.join(root, 'work.sqlite'));
  const tools = new AgentTools(undefined, new WorkspaceFiles(workdir));
  tools.notes = new NotesTools(store, (bot) => {
    if (!['mock-alpha', 'mock-beta'].includes(bot)) throw new Fault('BOT_PROFILE_NOT_FOUND');
  });
  tools.catalog = new CatalogTools({
    work,
    notes: () => tools.notes,
    schedules: () => undefined,
    offered: (run) => tools.list(run.bot, run.model, run.conversationId, run),
  });
  t.onTestFinished(async () => {
    await store.close();
    await work.close();
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
  return { root, workdir, store, work, tools, run };
}

test('notes tools expose only the current Bot records and never accept a caller scope override', async (t) => {
  const { tools, run } = await fixture(t),
    a = run(),
    b = run('mock-beta');
  expect.assert(
    notesToolList.every((entry) => tools.list(a.bot).some((tool) => tool.name === entry.name)),
  );
  expect(tools.list(a.bot).some((entry) => entry.name === 'screenshot')).toBe(false);
  const first = item(
    await tools.invoke(a, 'bot_notes_add', { title: ' 合成私有事项 ', body: 'MOCK ALPHA PRIVATE' }),
  );
  expect(first.bot).toBe(a.bot);
  expect(first.title).toBe('合成私有事项');
  expect(first.createdBy).toStrictEqual({ kind: 'bot', bot: a.bot });
  expect(value<{ items: unknown[] }>(await tools.invoke(b, 'bot_notes_list')).items).toStrictEqual(
    [],
  );
  expect(JSON.stringify(await tools.invoke(b, 'bot_notes_read', { id: first.id }))).toMatch(
    /NOTE_NOT_FOUND/,
  );
  expect(JSON.stringify(await tools.invoke(b, 'bot_notes_list', { bot: a.bot }))).toMatch(
    /INVALID_TOOL_ARGS/,
  );
  expect(
    JSON.stringify(await tools.invoke(b, 'bot_notes_add', { title: 'MOCK', bot: a.bot })),
  ).toMatch(/INVALID_TOOL_ARGS/);
  const second = item(
    await tools.invoke(b, 'bot_notes_add', { title: '合成私有事项', body: 'MOCK BETA PRIVATE' }),
  );
  expect(first.id).not.toBe(second.id);
  const catalog = value<{ notes: { page: { items: { id: string }[] } } }>(
    await tools.invoke(b, 'task_catalog'),
  );
  expect(catalog.notes.page.items.map((row) => row.id)).toStrictEqual([second.id]);
  expect(JSON.stringify(catalog).includes('MOCK ALPHA PRIVATE')).toBe(false);
});

test('full reads fence edits, no-ops and CAS while preserving unedited fields and recoverable state', async (t) => {
  const { store, tools, run } = await fixture(t),
    a = run();
  const first = item(
    await tools.invoke(a, 'bot_notes_add', { title: '合成处理事项', body: 'MOCK KEEP BODY' }),
  );
  await tools.invoke(a, 'bot_notes_list');
  await tools.invoke(a, 'task_catalog');
  expect(
    JSON.stringify(
      await tools.invoke(a, 'bot_notes_update', {
        id: first.id,
        revision: 1,
        patch: { status: 'parked' },
      }),
    ),
  ).toMatch(/NOTE_READ_REQUIRED/);
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  const noop = item(
    await tools.invoke(a, 'bot_notes_update', {
      id: first.id,
      revision: 1,
      patch: { body: first.body },
    }),
  );
  expect(noop.revision).toBe(1);
  expect(
    JSON.stringify(
      await tools.invoke(a, 'bot_notes_update', {
        id: first.id,
        revision: 1,
        patch: { status: 'parked' },
      }),
    ),
  ).toMatch(/NOTE_READ_REQUIRED/);
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  await store.write(
    a.bot,
    {
      id: 'mock-human-edit',
      note: first.id,
      action: 'update',
      revision: 1,
      value: { title: '合成人工新标题' },
    },
    { kind: 'human' },
  );
  expect(
    JSON.stringify(
      await tools.invoke(a, 'bot_notes_update', {
        id: first.id,
        revision: 1,
        patch: { status: 'parked' },
      }),
    ),
  ).toMatch(/NOTE_CONFLICT/);
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  const parked = item(
    await tools.invoke(a, 'bot_notes_update', {
      id: first.id,
      revision: 2,
      patch: { status: 'parked' },
    }),
  );
  expect(parked.title).toBe('合成人工新标题');
  expect(parked.body).toBe(first.body);
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  const done = item(
    await tools.invoke(a, 'bot_notes_update', {
      id: first.id,
      revision: 3,
      patch: { status: 'done' },
    }),
  );
  expect.assert(done.completedAt);
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  expect(
    item(await tools.invoke(a, 'bot_notes_trash', { id: first.id, revision: 4 })).deleted,
  ).toBe(true);
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  const restored = item(await tools.invoke(a, 'bot_notes_restore', { id: first.id, revision: 5 }));
  expect(restored.completedAt).toBe(done.completedAt);
  expect(restored.body).toBe(first.body);
});

test('stable intent recovers creation and edit receipts after continuation and reopening without overwriting Human changes', async (t) => {
  const { root, store, tools, run } = await fixture(t),
    a = run();
  const args = { title: '合成稳定便笺', body: 'MOCK BODY', status: 'open' };
  const first = item(await tools.invoke(a, 'bot_notes_add', args));
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
  const patch = { id: first.id, revision: 1, patch: { status: 'parked' } };
  item(await tools.invoke(a, 'bot_notes_update', patch));
  const later = await store.write(
    a.bot,
    {
      id: 'mock-human-later',
      note: first.id,
      action: 'update',
      revision: 2,
      value: { body: 'MOCK HUMAN LATER', status: 'done' },
    },
    { kind: 'human' },
  );
  await store.close();
  const reopened = new Notes(path.join(root, 'notes.sqlite'));
  try {
    tools.notes = new NotesTools(reopened);
    const retry = { ...run(), id: 'mock-new-process-run', intentId: a.id };
    expect(
      item(
        await tools.invoke(retry, 'bot_notes_add', {
          status: 'open',
          body: args.body,
          title: args.title,
        }),
      ),
    ).toStrictEqual(later.item);
    expect(item(await tools.invoke(retry, 'bot_notes_update', patch))).toStrictEqual(later.item);
    expect(
      JSON.stringify(
        await tools.invoke(retry, 'bot_notes_update', {
          id: first.id,
          revision: 3,
          patch: { status: 'open' },
        }),
      ),
    ).toMatch(/NOTE_READ_REQUIRED/);
    expect(
      item(await tools.invoke(run(a.bot, 'mock-distinct-user-request'), 'bot_notes_add', args)).id,
    ).not.toBe(first.id);
  } finally {
    await reopened.close();
  }
});

test('a late save acknowledgment consumes only its own full-read observation', async (t) => {
  const { store, tools, run } = await fixture(t),
    a = run();
  const first = item(await tools.invoke(a, 'bot_notes_add', { title: '合成迟到回执' }));
  await tools.invoke(a, 'bot_notes_read', { id: first.id });
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
  const pending = tools.invoke(a, 'bot_notes_update', {
    id: first.id,
    revision: 1,
    patch: { status: 'parked' },
  });
  try {
    await committed;
    await tools.invoke(a, 'bot_notes_read', { id: first.id });
    release();
    item(await pending);
    expect(
      item(
        await tools.invoke(a, 'bot_notes_update', {
          id: first.id,
          revision: 2,
          patch: { status: 'done' },
        }),
      ).revision,
    ).toBe(3);
  } finally {
    release();
    await pending;
  }
});

test('failed or changed-context reads cannot grant editing authority', async (t) => {
  const { store, tools, run } = await fixture(t),
    a = run();
  const first = item(
    await tools.invoke(a, 'bot_notes_add', { title: '合成读取失败', body: 'MOCK THROW' }),
  );
  a.redact = () => {
    throw new Fault('MOCK_REDACT_FAILURE');
  };
  expect(JSON.stringify(await tools.invoke(a, 'bot_notes_read', { id: first.id }))).toMatch(
    /MOCK_REDACT_FAILURE/,
  );
  a.redact = (value) => value;
  expect(
    JSON.stringify(
      await tools.invoke(a, 'bot_notes_update', {
        id: first.id,
        revision: 1,
        patch: { status: 'parked' },
      }),
    ),
  ).toMatch(/NOTE_READ_REQUIRED/);
  const get = store.get.bind(store);
  let release!: () => unknown;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.spyOn(store, 'get').mockImplementation(async (...args: Parameters<typeof get>) => {
    const saved = await get(...args);
    await gate;
    return saved;
  });
  const pending = tools.invoke(a, 'bot_notes_read', { id: first.id });
  a.bot = 'mock-beta';
  release();
  expect(JSON.stringify(await pending)).toMatch(/NOTE_CONTEXT_CHANGED/);
  a.bot = 'mock-alpha';
  expect(
    JSON.stringify(
      await tools.invoke(a, 'bot_notes_update', {
        id: first.id,
        revision: 1,
        patch: { status: 'done' },
      }),
    ),
  ).toMatch(/NOTE_READ_REQUIRED/);
});

test('closed input shapes, budgets, cancellation and registration never create phantom notes', async (t) => {
  const { store, tools, run } = await fixture(t),
    a = run();
  for (const [name, args] of [
    ['bot_notes_add', { title: 'MOCK', id: 'mock-selected-id' }],
    ['bot_notes_add', { title: 'MOCK', createdAt: '2026-01-01T00:00:00Z' }],
    ['bot_notes_list', { limit: 21 }],
    ['bot_notes_list', { filter: ['active'] }],
    ['bot_notes_read', { id: '../mock-private' }],
    ['bot_notes_update', { id: 'mock-note', revision: 1, patch: {} }],
  ] as const) {
    expect((await tools.invoke(a, name, args)).isError).toBe(true);
  }
  expect(JSON.stringify(await tools.invoke(run('mock-unknown'), 'bot_notes_list'))).toMatch(
    /BOT_PROFILE_NOT_FOUND/,
  );
  const limited = { ...run(), limit: 0 };
  expect(
    JSON.stringify(await tools.invoke(limited, 'bot_notes_add', { title: 'MOCK LIMIT' })),
  ).toMatch(/TOOL_LIMIT/);
  const stopped = run();
  stopped.abort.abort();
  expect(
    JSON.stringify(await tools.invoke(stopped, 'bot_notes_add', { title: 'MOCK STOP' })),
  ).toMatch(/MODEL_CANCELLED/);
  expect((await store.list(a.bot, { filter: 'all' })).items.length).toBe(0);
  expect.assert(a.trace.every((row) => row.phase !== 'running'));
});

test('decoded and truncated credential data is withheld from tools, catalog and traces without changing stored text', async (t) => {
  const { store, tools, run } = await fixture(t);
  const secret = `mock-"provider\\secret\n${'z'.repeat(50)}`;
  const full = await store.write(
    'mock-alpha',
    {
      id: 'mock-secret-create',
      note: 'mock-secret-note',
      action: 'create',
      revision: 0,
      value: { title: '合成脱敏', body: secret, status: 'open' },
    },
    { kind: 'human' },
  );
  const a = {
    ...run(),
    redact: (text: string) => redact(text, [secret]),
    redactResponse: (text: string) => redactStream(text, [secret]),
  };
  expect(item(await tools.invoke(a, 'bot_notes_read', { id: full.item.id })).body).toBe(
    '[credential redacted]',
  );
  const prefixSecret = 'mock-provider-key-with-a-long-private-suffix';
  await store.write(
    'mock-alpha',
    {
      id: 'mock-prefix-create',
      note: 'mock-prefix-note',
      action: 'create',
      revision: 0,
      value: {
        title: '合成截断',
        body: 'x'.repeat(190) + prefixSecret + ' continued',
        status: 'open',
      },
    },
    { kind: 'human' },
  );
  a.redact = (text) => redact(text, [secret, prefixSecret]);
  a.redactResponse = (text) => redactStream(text, [secret, prefixSecret]);
  const page = value<{ items: { id: string; body: string; bodyTruncated: boolean }[] }>(
    await tools.invoke(a, 'bot_notes_list'),
  );
  expect(page.items[0].body).toBe('x'.repeat(190));
  expect(page.items[0].bodyTruncated).toBe(true);
  const catalog = value<{ notes: { page: { items: { body: string }[] } } }>(
    await tools.invoke(a, 'task_catalog'),
  );
  expect(catalog.notes.page.items[0].body).toBe('x'.repeat(190));
  expect(JSON.stringify([page, catalog, a.trace]).includes(secret)).toBe(false);
  expect((await store.get(a.bot, full.item.id)).body).toBe(secret);
});

test('a catalog cannot return private observations after its run changes identity', async (t) => {
  const { tools, work, run } = await fixture(t),
    a = run();
  item(
    await tools.invoke(a, 'bot_notes_add', { title: '合成私有目录', body: 'MOCK PRIVATE CATALOG' }),
  );
  let release!: () => unknown;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const list = work.list.bind(work);
  vi.spyOn(work, 'list').mockImplementation(async (...args: Parameters<typeof list>) => {
    const page = await list(...args);
    await gate;
    return page;
  });
  const pending = tools.invoke(a, 'task_catalog');
  a.bot = 'mock-beta';
  release();
  expect(JSON.stringify(await pending)).toMatch(/CATALOG_CONTEXT_CHANGED/);
});
