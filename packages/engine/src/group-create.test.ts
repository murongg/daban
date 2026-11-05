import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Group, isGroupPage, type TaskRequest } from '@daban/protocol';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { GroupTools } from './group-tools.js';
import { type GroupRunner, Groups } from './groups.js';
import { WorkspaceFiles } from './workspace.js';

const request = {
  name: '合成任务协作',
  members: ['mock-beta'],
  message: 'SYNTHETIC SHARED GOAL: mock-beta checks figures; mock-alpha summarizes.',
};

function value<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.type === 'text' ? block.text : '') as T;
}
type Created = { group: Group; sourceId: string; reused: boolean };

async function fixture(project?: { projectId: string; revision: number }) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-create-'));
  const file = path.join(root, 'groups.sqlite');
  const members = ['mock-alpha', 'mock-beta', 'mock-gamma', 'mock-archived'].map((id) => ({
    id,
    name: `合成 ${id}`,
    instructions: `SYNTHETIC ROLE ${id}`,
    memory: 'SYNTHETIC PRIVATE MEMORY',
  }));
  const blocked = new Set(['mock-archived']);
  let activeRun = 'mock-run';
  let intentId = 'mock-intent';
  let reading: (() => unknown) | undefined;
  const calls: { bot: string; task: TaskRequest; context: string }[] = [];
  const runtime = {
    member: async (id: string) => members.find((member) => member.id === id),
    directory: async () => {
      reading?.();
      return members;
    },
    source: (bot: string, runId: string) =>
      bot === 'mock-alpha' && runId === activeRun
        ? { intentId, ...(project ? { project } : {}) }
        : undefined,
    running: () => false,
    groupRunning: () => false,
    admit: (bot: string) => !blocked.has(bot),
    findRequest: () => undefined,
    start: async (bot: string, task: TaskRequest, scope: { context: string }) => {
      calls.push({ bot, task, context: scope.context });
    },
    stopRequest: async () => {},
  } satisfies GroupRunner & {
    directory: () => Promise<typeof members>;
    source: (bot: string, runId: string) => { intentId: string } | undefined;
  };
  let groups = new Groups(file, runtime);
  const tools = new AgentTools(undefined, new WorkspaceFiles(root));
  tools.groups = new GroupTools(groups);
  const run: AgentToolRun = {
    id: activeRun,
    bot: 'mock-alpha',
    intentId: 'mock-untrusted-tool-intent',
    task: {
      requestId: 'mock-request',
      prompt: 'SYNTHETIC PRIVATE DM WITH UNRELATED BACKGROUND',
      memory: 'SYNTHETIC PRIVATE TASK MEMORY',
      files: [{ name: 'private.txt', content: 'SYNTHETIC PRIVATE INPUT' }],
    },
    abort: new AbortController(),
    toolCount: 0,
    limit: 60,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: root,
  };
  return {
    file,
    run,
    tools,
    runtime,
    blocked,
    calls,
    get groups() {
      return groups;
    },
    duringRead(callback: () => unknown) {
      reading = callback;
    },
    changeSource(id: string, intent = intentId) {
      activeRun = id;
      intentId = intent;
      run.id = id;
    },
    async reopen() {
      await groups.close();
      groups = new Groups(file, runtime);
      await groups.ready;
      tools.groups = new GroupTools(groups);
    },
    async close() {
      await groups.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('offers collaboration only to a current private task and exposes a bounded role directory without private context', async () => {
  const f = await fixture();
  try {
    const offered = (run = f.run) =>
      f.tools.list(run.bot, undefined, run.conversationId, run).map((tool) => tool.name);
    expect(offered()).toContain('group_create');
    expect(offered()).toContain('group_directory');
    expect(offered({ ...f.run, task: undefined })).not.toContain('group_create');
    expect(offered({ ...f.run, conversationId: 'mock-existing' })).not.toContain('group_create');
    const page = value<{ items: { id: string; name: string; role: string }[]; nextOffset: number }>(
      await f.tools.invoke(f.run, 'group_directory', { limit: 1 }),
    );
    expect(page.items).toStrictEqual([
      { id: 'mock-beta', name: '合成 mock-beta', role: 'SYNTHETIC ROLE mock-beta' },
    ]);
    expect(page.nextOffset).toBe(1);
    const rest = value<{ items: { id: string }[] }>(
      await f.tools.invoke(f.run, 'group_directory', { offset: page.nextOffset }),
    );
    expect(rest.items.map((item) => item.id)).toStrictEqual(['mock-gamma']);
    expect(JSON.stringify([page, rest])).not.toMatch(/PRIVATE|memory|prompt|files/);
  } finally {
    await f.close();
  }
});

test('atomically creates and queues one scoped group, attributes the summary to its Bot and reuses it across retry and restart', async () => {
  const f = await fixture();
  try {
    const created = value<Created>(await f.tools.invoke(f.run, 'group_create', request));
    expect(created.reused).toBe(false);
    expect(created.group.members).toStrictEqual(['mock-alpha', 'mock-beta']);
    const page = await f.groups.read(created.group.id);
    expect(isGroupPage(page)).toBe(true);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      role: 'bot',
      author: 'mock-alpha',
      sourceId: created.sourceId,
    });
    expect(page.messages[0].text).toContain(request.message);
    expect(page.deliveries.map((delivery) => delivery.bot)).toStrictEqual([
      'mock-beta',
      'mock-alpha',
    ]);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE|private\.txt/);
    f.run.intentId = 'mock-another-untrusted-intent';
    const replays = await Promise.all([
      f.tools.invoke(f.run, 'group_create', request),
      f.tools.invoke(f.run, 'group_create', request),
    ]);
    for (const replay of replays)
      expect(value<Created>(replay)).toMatchObject({ group: created.group, reused: true });
    f.changeSource('mock-retry-run');
    await f.reopen();
    expect(value<Created>(await f.tools.invoke(f.run, 'group_create', request))).toMatchObject({
      group: created.group,
      sourceId: created.sourceId,
      reused: true,
    });
    expect((await f.groups.status()).items).toHaveLength(1);
    expect((await f.groups.read(created.group.id)).deliveries).toHaveLength(2);
    await f.groups.tick();
    expect(f.calls[0].bot).toBe('mock-beta');
    expect(f.calls[0].task.prompt).toContain(request.message);
    expect(f.calls[0].task.files).toStrictEqual([]);
    expect(JSON.stringify(f.calls)).not.toMatch(/PRIVATE|private\.txt/);
  } finally {
    await f.close();
  }
});

test('rejects extra authority, invalid members, stale tasks and nested group creation without effects', async () => {
  const f = await fixture();
  try {
    const denied = [
      { ...request, bot: 'mock-gamma' },
      { ...request, group: 'mock-picked-group' },
      { ...request, files: f.run.task!.files },
      { ...request, members: [] },
      { ...request, members: ['mock-alpha'] },
      { ...request, members: ['mock-beta', 'mock-beta'] },
      { ...request, members: ['mock-missing'] },
      { ...request, members: ['mock-archived'] },
      { ...request, members: Array.from({ length: 8 }, (_, i) => `mock-${i}`) },
      { ...request, message: ' ' },
      { ...request, message: 'x'.repeat(12001) },
    ];
    for (const args of denied)
      expect((await f.tools.invoke(f.run, 'group_create', args)).isError).toBe(true);
    for (const run of [
      { ...f.run, id: 'mock-stale-run' },
      { ...f.run, task: undefined },
      { ...f.run, conversationId: 'mock-parent-group' },
      { ...f.run, bot: 'mock-gamma' },
    ])
      for (const name of ['group_create', 'group_directory'])
        expect(
          (await f.tools.invoke(run, name, name === 'group_create' ? request : {})).isError,
        ).toBe(true);
    expect((await f.groups.status()).items).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('fences cancellation and lifecycle changes during directory reads and commits no partial group on queue failure', async () => {
  const f = await fixture();
  try {
    f.duringRead(() => f.changeSource('mock-replaced-run'));
    expect((await f.tools.invoke(f.run, 'group_directory', {})).isError).toBe(true);
    f.duringRead(() => {});
    const member = f.runtime.member;
    f.runtime.member = async (id) => {
      f.run.abort.abort();
      return member(id);
    };
    expect((await f.tools.invoke(f.run, 'group_create', request)).isError).toBe(true);
    expect((await f.groups.status()).items).toStrictEqual([]);
    f.run.abort = new AbortController();
    f.runtime.member = async (id) => {
      f.blocked.add('mock-beta');
      return member(id);
    };
    expect((await f.tools.invoke(f.run, 'group_create', request)).isError).toBe(true);
    expect((await f.groups.status()).items).toStrictEqual([]);
    f.runtime.member = member;
    f.blocked.clear();
    const db = new DatabaseSync(f.file);
    db.exec(
      "CREATE TRIGGER mock_queue_failure BEFORE INSERT ON group_turns BEGIN SELECT RAISE(ABORT, 'SYNTHETIC FAILURE'); END;",
    );
    expect((await f.tools.invoke(f.run, 'group_create', request)).isError).toBe(true);
    expect((await f.groups.status()).items).toStrictEqual([]);
    db.exec('DROP TRIGGER mock_queue_failure');
    db.close();
    const created = value<Created>(await f.tools.invoke(f.run, 'group_create', request));
    expect(created.reused).toBe(false);
    f.run.abort.abort();
    expect((await f.tools.invoke(f.run, 'group_create', request)).isError).toBe(true);
    expect((await f.groups.status()).items).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('one task cannot fork groups by changing arguments or revive archived collaboration; a new task gets a separate group', async () => {
  const f = await fixture();
  try {
    const created = value<Created>(await f.tools.invoke(f.run, 'group_create', request));
    expect(
      (await f.tools.invoke(f.run, 'group_create', { ...request, members: ['mock-gamma'] }))
        .isError,
    ).toBe(true);
    await f.groups.cancel(created.group.id, created.sourceId);
    await f.groups.action({
      id: 'mock-archive',
      group: created.group.id,
      revision: 1,
      action: 'archive',
    });
    const replay = value<Created>(await f.tools.invoke(f.run, 'group_create', request));
    expect(replay.group.archived).toBe(true);
    expect(replay.reused).toBe(true);
    expect(
      (await f.groups.read(created.group.id)).deliveries.every((row) => row.state === 'cancelled'),
    ).toBe(true);
    f.changeSource('mock-next-run', 'mock-next-intent');
    const next = value<Created>(await f.tools.invoke(f.run, 'group_create', request));
    expect(next.group.id).not.toBe(created.group.id);
    expect((await f.groups.status()).items).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('the maximum shared summary remains a valid executable task without truncation', async () => {
  const f = await fixture();
  try {
    const message = 'S'.repeat(12000);
    const created = value<Created>(
      await f.tools.invoke(f.run, 'group_create', { ...request, message }),
    );
    await f.groups.tick();
    expect(f.calls[0].task.prompt).toHaveLength(12000);
    expect(f.calls[0].task.prompt).toBe(message);
    expect(isGroupPage(await f.groups.read(created.group.id))).toBe(true);
  } finally {
    await f.close();
  }
});

test('a project collaboration checks every recipient before saving or delivering its summary', async () => {
  const project = { projectId: 'mock-project', revision: 1 };
  const f = await fixture(project);
  Object.assign(f.runtime, {
    projectScope: (bot: string) => {
      if (bot === 'mock-gamma')
        throw Object.assign(Error('PROJECT_ACCESS_DENIED'), { code: 'PROJECT_ACCESS_DENIED' });
    },
  });
  try {
    await expect(
      f.groups.collaborate(
        { bot: 'mock-alpha', runId: 'mock-run' },
        { ...request, members: ['mock-gamma'] },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_ACCESS_DENIED' });
    expect(f.calls).toStrictEqual([]);
    expect((await f.groups.status()).items).toStrictEqual([]);
    const allowed = await f.groups.collaborate({ bot: 'mock-alpha', runId: 'mock-run' }, request);
    expect(allowed.group.project).toStrictEqual(project);
    await f.groups.tick();
    expect(f.calls[0]?.task.project).toStrictEqual(project);
  } finally {
    await f.close();
  }
});
