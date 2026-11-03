import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Attachments } from './attachments.js';
import { GroupTools } from './group-tools.js';
import { type GroupRunner, Groups } from './groups.js';
import { groupTurns } from './groups-schema.js';
import { WorkspaceFiles } from './workspace.js';

const input = { id: 'mock-group', name: '合成协作群', members: ['mock-alpha', 'mock-beta'] };
const legacyFiles = {
  // The first shipped layout: no copy origin, turn inputs, message runs or later receipt tables.
  initial: `CREATE TABLE group_defs(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE group_turns(grp TEXT NOT NULL,id TEXT NOT NULL,prompt TEXT NOT NULL,recipients TEXT NOT NULL,signature TEXT NOT NULL,seq INTEGER,created TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(grp,id));
    CREATE TABLE group_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,grp TEXT NOT NULL,source TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL,author TEXT,name TEXT,phase TEXT,model TEXT,files TEXT,UNIQUE(grp,id));
    CREATE INDEX group_messages_page ON group_messages(grp,seq);
    CREATE TABLE group_deliveries(id TEXT PRIMARY KEY,grp TEXT NOT NULL,source TEXT NOT NULL,bot TEXT NOT NULL,position INTEGER NOT NULL,state TEXT NOT NULL,run TEXT,context TEXT,name TEXT,error TEXT);
    CREATE INDEX group_deliveries_queue ON group_deliveries(grp,source,position);
    CREATE TABLE group_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);`,
  // The last pre-ORM layout, after every additive column upgrade the old bootstrap applied.
  upgraded: `CREATE TABLE group_defs(id TEXT PRIMARY KEY,value TEXT NOT NULL,copy_origin TEXT);
    CREATE TABLE group_actions(id TEXT PRIMARY KEY,grp TEXT NOT NULL,value TEXT NOT NULL);
    CREATE INDEX group_actions_owner ON group_actions(grp);
    CREATE TABLE group_turns(grp TEXT NOT NULL,id TEXT NOT NULL,prompt TEXT NOT NULL,recipients TEXT NOT NULL,signature TEXT NOT NULL,seq INTEGER,created TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(grp,id));
    ALTER TABLE group_turns ADD COLUMN inputs TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE group_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,grp TEXT NOT NULL,source TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL,author TEXT,name TEXT,phase TEXT,model TEXT,files TEXT,UNIQUE(grp,id));
    ALTER TABLE group_messages ADD COLUMN run TEXT;
    CREATE INDEX group_messages_page ON group_messages(grp,seq);
    CREATE TABLE group_deliveries(id TEXT PRIMARY KEY,grp TEXT NOT NULL,source TEXT NOT NULL,bot TEXT NOT NULL,position INTEGER NOT NULL,state TEXT NOT NULL,run TEXT,context TEXT,name TEXT,error TEXT);
    CREATE INDEX group_deliveries_queue ON group_deliveries(grp,source,position);
    CREATE TABLE group_handoffs(source TEXT PRIMARY KEY,signature TEXT NOT NULL,target TEXT NOT NULL);
    CREATE TABLE group_collaborations(source TEXT PRIMARY KEY,grp TEXT NOT NULL,turn TEXT NOT NULL,signature TEXT NOT NULL);
    CREATE TABLE group_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);`,
};
test.each(Object.entries(legacyFiles))(
  'a pre-ORM %s group file keeps its history and accepts new turns after the schema baseline',
  async (_name, ddl) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mock-groups-legacy-'));
    const file = path.join(dir, 'groups.sqlite');
    const created = '2026-01-01T00:00:00.000Z';
    const group = { ...input, revision: 1, createdAt: created, updatedAt: created };
    const old = new DatabaseSync(file);
    old.exec(ddl);
    old.exec('INSERT INTO group_meta VALUES(1,5)');
    old
      .prepare('INSERT INTO group_defs(id,value) VALUES(?,?)')
      .run(input.id, JSON.stringify(group));
    old
      .prepare(
        "INSERT INTO group_turns(grp,id,prompt,recipients,signature,seq,created,state) VALUES(?,?,?,?,?,1,?,'completed')",
      )
      .run(
        input.id,
        'mock-old-turn',
        'SYNTHETIC OLD PROMPT',
        '["mock-alpha"]',
        'mock-sig',
        created,
      );
    old
      .prepare(
        "INSERT INTO group_messages(id,grp,source,role,text,created) VALUES(?,?,?,'user',?,?)",
      )
      .run('mock-old-turn', input.id, 'mock-old-turn', 'SYNTHETIC OLD PROMPT', created);
    old
      .prepare(
        "INSERT INTO group_messages(id,grp,source,role,text,created,author,name,phase) VALUES(?,?,?,'bot',?,?,?,?,'completed')",
      )
      .run(
        'reply-mock-old',
        input.id,
        'mock-old-turn',
        'SYNTHETIC OLD ANSWER',
        created,
        'mock-alpha',
        '合成 mock-alpha',
      );
    old
      .prepare(
        "INSERT INTO group_deliveries(id,grp,source,bot,position,state,run) VALUES(?,?,?,?,0,'completed',?)",
      )
      .run('mock-old', input.id, 'mock-old-turn', 'mock-alpha', 'run-old');
    old.close();
    const fake = runner();
    let groups = new Groups(file, fake.value);
    try {
      await groups.ready;
      const status = await groups.status();
      expect(status).toStrictEqual({ available: true, revision: 5, items: [group] });
      const page = await groups.read(input.id);
      expect(
        page.messages.map((message) => [message.sequence, message.role, message.text]),
      ).toStrictEqual([
        [1, 'user', 'SYNTHETIC OLD PROMPT'],
        [2, 'bot', 'SYNTHETIC OLD ANSWER'],
      ]);
      expect(
        page.deliveries.map((delivery) => [delivery.id, delivery.state, delivery.runId]),
      ).toStrictEqual([['mock-old', 'completed', 'run-old']]);
      const sent = await groups.send({
        id: 'mock-new-turn',
        group: input.id,
        prompt: 'SYNTHETIC NEW PROMPT',
        recipients: ['mock-alpha'],
      });
      expect(sent.accepted?.sequence).toBe(3);
      expect(sent.revision).toBe(6);
      await groups.tick();
      expect(fake.calls.map((call) => call.prompt)).toStrictEqual(['SYNTHETIC NEW PROMPT']);
      expect.assert(fake.calls[0].context.includes('SYNTHETIC OLD ANSWER'));
      fake.complete(0, 'SYNTHETIC NEW ANSWER');
      await groups.tick();
      await groups.close();
      groups = new Groups(file, fake.value);
      const reopened = await groups.read(input.id);
      expect(reopened.messages.at(-1)).toMatchObject({
        role: 'bot',
        text: 'SYNTHETIC NEW ANSWER',
        runId: 'run-1',
      });
      expect(await groups.notices()).toStrictEqual([
        { kind: 'group', id: 'mock-old-turn', group: input.id, phase: 'completed' },
        { kind: 'group', id: 'mock-new-turn', group: input.id, phase: 'completed' },
      ]);
    } finally {
      await groups.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test('group outcome notices use the whole canonical turn, not the last observed member job', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-group-notices-'));
  const fake = runner(),
    groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  try {
    await groups.register(input);
    await groups.send({
      id: 'mock-notice-turn',
      group: input.id,
      prompt: 'SYNTHETIC PRIVATE GROUP CONTENT',
      recipients: input.members,
    });
    expect(await groups.notices()).toStrictEqual([]);
    await groups.tick();
    fake.complete(0, 'SYNTHETIC MEMBER RESULT');
    await groups.tick();
    expect(await groups.notices()).toStrictEqual([]);
    fake.complete(1, 'SYNTHETIC MEMBER RESULT');
    await groups.tick();
    const result = await groups.notices();
    expect(result).toStrictEqual([
      { kind: 'group', id: 'mock-notice-turn', group: input.id, phase: 'completed' },
    ]);
    expect.assert(!JSON.stringify(result).includes('SYNTHETIC PRIVATE'));
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('a recovery reservation after a group claim retains unissued collaboration for a later explicit release', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-group-recovery-'));
  const fake = runner();
  const groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-recovery-turn',
      group: input.id,
      prompt: '合成排队任务',
      recipients: input.members,
    });
    const start = fake.value.start;
    fake.value.start = async () => {
      throw Object.assign(new Error('RUNTIME_RECOVERY_PENDING'), {
        code: 'RUNTIME_RECOVERY_PENDING',
      });
    };
    await groups.tick();
    const held = await groups.read(input.id);
    expect.assert(held.deliveries.every((row) => row.state === 'pending'));
    expect(fake.calls.length).toBe(0);
    fake.value.start = start;
    await groups.tick();
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].bot).toBe('mock-alpha');
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});
function runner() {
  const active = new Set<string>();
  const receipts = new Map<
    string,
    {
      runId: string;
      phase: string;
      conversationId?: string;
      result?: string;
      model?: 'deepseek-flash';
      files: [];
    }
  >();
  const calls: { bot: string; id: string; prompt: string; context: string }[] = [];
  const value: GroupRunner = {
    member: async (bot) =>
      input.members.includes(bot) ? { id: bot, name: `合成 ${bot}` } : undefined,
    running: (bot) => active.has(bot),
    groupRunning: (group) =>
      Array.from(receipts.entries()).some(
        ([key, receipt]) =>
          active.has(key.split('/')[0]) &&
          receipt.conversationId === group &&
          receipt.phase === 'running',
      ),
    findRequest: (bot, id) => receipts.get(`${bot}/${id}`),
    start: async (bot, task, scope) => {
      if (active.has(bot))
        throw Object.assign(new Error('MODEL_ALREADY_RUNNING'), { code: 'MODEL_ALREADY_RUNNING' });
      calls.push({ bot, id: task.requestId, prompt: task.prompt, context: scope.context });
      active.add(bot);
      receipts.set(`${bot}/${task.requestId}`, {
        runId: `run-${calls.length}`,
        phase: 'running',
        conversationId: scope.id,
        model: 'deepseek-flash',
        files: [],
      });
    },
    stopRequest: async (bot, id, group) => {
      const receipt = receipts.get(`${bot}/${id}`);
      if (receipt?.conversationId === group && receipt.phase === 'running') {
        receipt.phase = 'stopped';
        active.delete(bot);
      }
    },
  };
  return {
    value,
    active,
    receipts,
    calls,
    complete(index: number, text: string) {
      const call = calls[index];
      const receipt = receipts.get(`${call.bot}/${call.id}`)!;
      receipt.phase = 'completed';
      receipt.result = text;
      active.delete(call.bot);
    },
  };
}

test('group archive is a retained, version-bound operation whose replay cannot overwrite later restore or edits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-group-archive-'));
  const fake = runner(),
    file = path.join(dir, 'groups.sqlite');
  let groups = new Groups(file, fake.value);
  try {
    await groups.register(input);
    await groups.send({
      id: 'mock-turn',
      group: input.id,
      prompt: 'SYNTHETIC RETAINED HISTORY',
      recipients: ['mock-alpha'],
    });
    await expect(
      groups.action({ id: 'mock-archive', group: input.id, action: 'archive', revision: 1 }),
    ).rejects.toMatchObject({ code: 'GROUP_BUSY' });
    await groups.tick();
    fake.complete(0, 'SYNTHETIC RETAINED ANSWER');
    await groups.tick();
    const before = await groups.read(input.id);
    const request = {
      id: 'mock-archive',
      group: input.id,
      action: 'archive' as const,
      revision: 1,
    };
    const archived = await groups.action(request);
    expect(archived.group.archived).toBe(true);
    expect(archived.group.revision).toBe(2);
    expect((await groups.read(input.id)).messages).toStrictEqual(before.messages);
    await expect(
      groups.send({
        id: 'mock-denied',
        group: input.id,
        prompt: 'SYNTHETIC DENIED',
        recipients: input.members,
      }),
    ).rejects.toMatchObject({ code: 'GROUP_ARCHIVED' });
    await expect(
      groups.update(input.id, 2, { name: 'SYNTHETIC DENIED EDIT', members: input.members }),
    ).rejects.toMatchObject({ code: 'GROUP_ARCHIVED' });
    expect(
      (
        await groups.send({
          id: 'mock-turn',
          group: input.id,
          prompt: 'SYNTHETIC RETAINED HISTORY',
          recipients: ['mock-alpha'],
        })
      ).accepted,
    ).toStrictEqual(before.messages.find((item) => item.id === 'mock-turn'));
    await groups.close();
    groups = new Groups(file, fake.value);
    expect((await groups.actionReceipt(input.id, request.id)).group.archived).toBe(true);
    const restored = await groups.action({
      id: 'mock-restore',
      group: input.id,
      action: 'restore',
      revision: 2,
    });
    expect(!!restored.group.archived).toBe(false);
    expect(restored.group.members).toStrictEqual(input.members);
    expect(fake.calls.length).toBe(1);
    const edited = await groups.update(input.id, 3, {
      name: '合成后续群名',
      members: input.members,
    });
    const replay = await groups.action(request);
    expect(replay.group.name).toBe(edited.name);
    expect(!!replay.group.archived).toBe(false);
    expect(replay.receipt.revision).toBe(2);
    await expect(
      groups.action({ ...request, action: 'restore', revision: 4 }),
    ).rejects.toMatchObject({
      code: 'GROUP_ACTION_ID_REUSED',
    });
    await expect(
      groups.action({ id: 'mock-stale', group: input.id, action: 'archive', revision: 1 }),
    ).rejects.toMatchObject({ code: 'GROUP_CONFLICT' });
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('archive distinguishes a live group job during cancellation from an unrelated private member job', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-group-archive-live-'));
  const fake = runner(),
    groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  let release = () => {},
    entered = () => {};
  const stopping = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  const original = fake.value.stopRequest;
  fake.value.stopRequest = async (...args) => {
    entered();
    await new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    });
    return original(...args);
  };
  try {
    await groups.register(input);
    await groups.send({
      id: 'mock-live',
      group: input.id,
      prompt: 'SYNTHETIC RUN',
      recipients: ['mock-alpha'],
    });
    await groups.tick();
    const cancel = groups.cancel(input.id, 'mock-live');
    await stopping;
    await expect(
      groups.action({ id: 'mock-busy-archive', group: input.id, action: 'archive', revision: 1 }),
    ).rejects.toMatchObject({ code: 'GROUP_BUSY' });
    release();
    await cancel;
    fake.active.add('mock-alpha');
    const archived = await groups.action({
      id: 'mock-private-archive',
      group: input.id,
      action: 'archive',
      revision: 1,
    });
    expect(archived.group.archived).toBe(true);
    expect(fake.active.has('mock-alpha')).toBe(true);
  } finally {
    release();
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('restore cannot admit a delayed pre-archive send, but exact accepted replay stays readable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-group-generation-'));
  const fake = runner(),
    groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  try {
    await groups.register(input);
    await groups.action({ id: 'mock-a', group: input.id, action: 'archive', revision: 1 });
    await groups.action({ id: 'mock-r', group: input.id, action: 'restore', revision: 2 });
    const send = {
      id: 'mock-delayed',
      group: input.id,
      prompt: 'SYNTHETIC DELAYED',
      recipients: ['mock-alpha'],
    };
    await expect(groups.send(send)).rejects.toMatchObject({ code: 'GROUP_REVISION_REQUIRED' });
    await expect(groups.send({ ...send, revision: 1 })).rejects.toMatchObject({
      code: 'GROUP_CONFLICT',
    });
    const current = { ...send, id: 'mock-current', revision: 3 };
    const accepted = await groups.send(current);
    await groups.cancel(input.id, current.id);
    await groups.action({ id: 'mock-a2', group: input.id, action: 'archive', revision: 3 });
    expect((await groups.send(current)).accepted).toStrictEqual(accepted.accepted);
    await expect(groups.send({ ...current, revision: 4 })).rejects.toMatchObject({
      code: 'GROUP_REQUEST_ID_REUSED',
    });
    expect(fake.calls.length).toBe(0);
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('lifecycle eligibility gates queued collaboration without erasing history or reusing an archived identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-lifecycle-'));
  const fake = runner();
  const blocked = new Set<string>();
  Object.assign(fake.value, { admit: (bot: string) => !blocked.has(bot) });
  const groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-queued-archive',
      group: input.id,
      prompt: '合成待取消协作',
      recipients: input.members,
    });
    expect(await groups.hasPendingBot('mock-alpha')).toBe(true);
    blocked.add('mock-alpha');
    await groups.tick();
    expect(fake.calls.length).toBe(0);
    await expect(
      groups.send({
        id: 'mock-blocked-turn',
        group: input.id,
        prompt: '合成不得派发',
        recipients: ['mock-alpha'],
      }),
    ).rejects.toMatchObject({ code: 'BOT_UNAVAILABLE' });
    await expect(groups.register({ ...input, id: 'mock-alpha' })).rejects.toMatchObject({
      code: 'GROUP_ID_CONFLICT',
    });
    await expect(groups.register({ ...input, id: 'mock-new-with-archived' })).rejects.toMatchObject(
      {
        code: 'BOT_UNAVAILABLE',
      },
    );
    const cancelled = await groups.cancel(input.id, 'mock-queued-archive');
    expect.assert(JSON.stringify(cancelled).includes('合成待取消协作'));
    expect(await groups.hasPendingBot('mock-alpha')).toBe(false);
    await groups.update(input.id, 1, { name: '合成保留成员的群', members: input.members });
    await groups.send({
      id: 'mock-independent-turn',
      group: input.id,
      prompt: '合成其他成员任务',
      recipients: ['mock-beta'],
    });
    await groups.tick();
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].bot).toBe('mock-beta');
    await expect(
      groups.handoff(
        { bot: 'mock-beta', runId: 'run-1', group: input.id },
        { bot: 'mock-alpha', message: '合成不得转交' },
      ),
    ).rejects.toMatchObject({ code: 'BOT_UNAVAILABLE' });
    fake.complete(0, 'SYNTHETIC-OTHER-RESULT');
    await groups.tick();
    blocked.clear();
    await groups.tick();
    expect(fake.calls.length).toBe(1);
    expect(await groups.hasPendingBot('mock-beta')).toBe(false);
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('group dispatch rechecks admission after asynchronously reading its member directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-admission-race-'));
  const fake = runner();
  const groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  let entered!: () => unknown;
  let release!: () => unknown;
  const enteredDirectory = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  let admitted = true;
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-race-turn',
      group: input.id,
      prompt: '合成目录并发',
      recipients: ['mock-alpha'],
    });
    const member = fake.value.member;
    Object.assign(fake.value, {
      admit: () => admitted,
      member: async (bot: string) => {
        if (bot === 'mock-beta') {
          entered();
          await gate;
        }
        return member(bot);
      },
    });
    const tick = groups.tick();
    await enteredDirectory;
    admitted = false;
    release();
    await tick;
    expect(fake.calls.length).toBe(0);
    expect(await groups.hasPendingBot('mock-alpha')).toBe(true);
  } finally {
    release();
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('group inputs remain owned, readable after reopening and pinned while queued or active', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-inputs-'));
  const fake = runner();
  const uploads = new Attachments(path.join(dir, 'uploads.sqlite'));
  let groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value, uploads);
  try {
    await groups.ready;
    await groups.register(input);
    const original = {
      name: 'source.pdf',
      data: Buffer.from('synthetic-group-bytes').toString('base64'),
    };
    const receipt = await uploads.upload(input.id, original, async () => 'GROUP-INPUT-47');
    const files = [
      { name: 'input.csv', content: 'item,count\nmock,47' },
      { name: 'source.pdf', attachmentId: receipt.id },
    ];
    await groups.send({
      id: 'mock-file-turn',
      group: input.id,
      prompt: '处理合成文件',
      recipients: ['mock-alpha'],
      files,
    });
    expect(groups.inputBusy(input.id, receipt.id)).toBe(true);
    expect(groups.inputBusy('another-group', receipt.id)).toBe(false);
    expect(await groups.inputSource(input.id, 'mock-file-turn', 'source.pdf')).toStrictEqual(
      files[1],
    );
    await groups.close();
    groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value, uploads);
    await groups.ready;
    expect(await groups.inputSource(input.id, 'mock-file-turn', 'input.csv')).toStrictEqual(
      files[0],
    );
    await groups.tick();
    expect(groups.inputBusy(input.id, receipt.id)).toBe(true);
    fake.complete(0, '完成合成');
    await groups.tick();
    expect(groups.inputBusy(input.id, receipt.id)).toBe(false);
    await expect(
      groups.send({
        id: 'mock-other-input',
        group: input.id,
        prompt: '不应接受',
        recipients: ['mock-alpha'],
        files: [{ name: 'other.pdf', attachmentId: 'a'.repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  } finally {
    await groups.close();
    await uploads.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('group MCP tools are hidden in DMs and retain the shared tool budget and cancellation boundary', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-tools-'));
  const fake = runner();
  const groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value);
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-tool-source',
      group: input.id,
      prompt: '合成协作',
      recipients: ['mock-alpha'],
    });
    await groups.tick();
    const tools = new AgentTools(undefined, new WorkspaceFiles(dir));
    tools.groups = new GroupTools(groups);
    expect(tools.list('mock-alpha').some((tool) => tool.name === 'group_handoff')).toBe(false);
    expect(
      tools.list('mock-alpha', undefined, input.id).some((tool) => tool.name === 'group_handoff'),
    ).toBe(true);
    const run: AgentToolRun = {
      id: 'run-1',
      bot: 'mock-alpha',
      conversationId: input.id,
      abort: new AbortController(),
      toolCount: 0,
      limit: 2,
      seen: {},
      trace: [],
      workdir: dir,
      canonicalRoot: await realpath(dir),
    };
    const denied = await tools.invoke({ ...run, conversationId: undefined }, 'group_history', {});
    expect(denied.isError).toBe(true);
    expect.assert(JSON.stringify(denied).includes('GROUP_SOURCE_CLOSED'));
    const history = await tools.invoke(run, 'group_history', {});
    expect(history.isError).toBe(undefined);
    const handoff = await tools.invoke(run, 'group_handoff', {
      bot: 'mock-beta',
      message: '合成继续',
    });
    expect(handoff.isError).toBe(undefined);
    expect(run.toolCount).toBe(2);
    const limit = await tools.invoke(run, 'group_history', {});
    expect(limit.isError).toBe(true);
    expect.assert(JSON.stringify(limit).includes('TOOL_LIMIT'));
    run.abort.abort();
    const cancelled = await tools.invoke(run, 'group_history', {});
    expect.assert(JSON.stringify(cancelled).includes('MODEL_CANCELLED'));
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('groups persist scoped membership and human messages, deduplicate exact sends and execute selected stages in order', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-groups-'));
  const run = runner();
  let groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
  try {
    await groups.ready;
    const group = await groups.register(input);
    expect(group.revision).toBe(1);
    expect(await groups.register({ ...input, name: '过时缓存' })).toStrictEqual(group);
    const send = {
      id: 'mock-human',
      group: group.id,
      prompt: '合成问题 HUMAN-47',
      recipients: input.members,
    };
    const first = await groups.send(send);
    expect(first.messages.length).toBe(1);
    expect(await groups.send(send)).toStrictEqual(first);
    await expect(groups.send({ ...send, prompt: '另一份内容' })).rejects.toMatchObject({
      code: 'GROUP_REQUEST_ID_REUSED',
    });
    await groups.tick();
    expect(run.calls.length).toBe(1);
    expect(run.calls[0].bot).toBe('mock-alpha');
    expect(run.calls[0].prompt).toBe(send.prompt);
    await expect(
      groups.update(group.id, 1, { name: '忙时修改', members: input.members }),
    ).rejects.toMatchObject({
      code: 'GROUP_BUSY',
    });
    run.complete(0, 'ALPHA-53');
    await groups.tick();
    expect(run.calls.length).toBe(2);
    expect(run.calls[1].bot).toBe('mock-beta');
    expect.assert(run.calls[1].context.includes('ALPHA-53'));
    run.complete(1, 'BETA-59');
    await groups.tick();
    const page = await groups.read(group.id);
    expect(page.messages.map((message) => message.role)).toStrictEqual(['user', 'bot', 'bot']);
    expect(page.messages[1].author).toBe('mock-alpha');
    expect(page.messages[2].author).toBe('mock-beta');
    expect.assert(page.deliveries.every((item) => item.state === 'completed'));
    const updated = await groups.update(group.id, 1, {
      name: '合成新群名',
      members: input.members,
    });
    expect(updated.revision).toBe(2);
    await expect(
      groups.update(group.id, 1, { name: '过时', members: input.members }),
    ).rejects.toMatchObject({
      code: 'GROUP_CONFLICT',
    });
    await groups.close();
    groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
    await groups.ready;
    expect((await groups.read(group.id)).messages).toStrictEqual(page.messages);
    await expect(
      groups.update(group.id, 2, {
        id: 'mock-overridden-id',
        name: '合成损坏输入',
        members: input.members,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_GROUP' });
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart never replays an ambiguous claimed stage and cancellation cannot stop unrelated work', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-recovery-'));
  const run = runner();
  let groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-ambiguous',
      group: input.id,
      prompt: '合成请求',
      recipients: input.members,
    });
    await groups.tick();
    expect(run.calls.length).toBe(1);
    await groups.close();
    run.receipts.clear();
    run.active.clear();
    groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
    await groups.ready;
    await groups.tick();
    expect(run.calls.length).toBe(1);
    expect.assert((await groups.read(input.id)).deliveries.some((d) => d.state === 'interrupted'));
    await groups.send({
      id: 'mock-cancel',
      group: input.id,
      prompt: '另一次合成请求',
      recipients: input.members,
    });
    await groups.tick();
    const current = run.calls.at(-1)!;
    run.receipts.get(`${current.bot}/${current.id}`)!.phase = 'completed';
    run.active.add(current.bot); // A different current task owns the busy Bot now.
    await groups.cancel(input.id, 'mock-cancel');
    expect(run.active.has(current.bot)).toBe(true);
    await groups.tick();
    expect(run.calls.length).toBe(2);
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('handoffs require an active source and actual target member, replay once and reject changed effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-handoff-'));
  const run = runner();
  const groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-round',
      group: input.id,
      prompt: '合成协作',
      recipients: ['mock-alpha'],
    });
    await groups.tick();
    const source = { bot: 'mock-alpha', runId: 'run-1', group: input.id };
    await expect(
      groups.handoff(source, { bot: 'not-a-member', message: '不能转交' }),
    ).rejects.toMatchObject({
      code: 'GROUP_MEMBER_REQUIRED',
    });
    const first = await groups.handoff(source, {
      bot: 'mock-beta',
      message: '请继续合成工作 HANDOFF-61',
    });
    expect(
      await groups.handoff(source, { bot: 'mock-beta', message: '请继续合成工作 HANDOFF-61' }),
    ).toStrictEqual(first);
    await expect(
      groups.handoff(source, { bot: 'mock-beta', message: '不同指令' }),
    ).rejects.toMatchObject({
      code: 'GROUP_HANDOFF_CONFLICT',
    });
    run.complete(0, '第一位已完成');
    await groups.tick();
    expect(run.calls.length).toBe(2);
    expect.assert(run.calls[1].context.includes('HANDOFF-61'));
    await expect(
      groups.handoff(source, { bot: 'mock-beta', message: '迟到转交' }),
    ).rejects.toMatchObject({
      code: 'GROUP_SOURCE_CLOSED',
    });
    run.complete(1, '结束合成工作');
    await groups.tick();
    expect(
      (await groups.read(input.id)).messages.filter((m) => m.text.includes('HANDOFF-61')).length,
    ).toBe(1);
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('model group history can read full current-prefix messages but cannot inspect a newer human turn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-context-'));
  const run = runner();
  const groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
  try {
    await groups.ready;
    await groups.register(input);
    const page = await groups.send({
      id: 'mock-history-source',
      group: input.id,
      prompt: '合成人类请求 HUMAN-47',
      recipients: ['mock-alpha'],
    });
    await groups.tick();
    await groups.send({
      id: 'mock-future-source',
      group: input.id,
      prompt: 'FUTURE-SECRET-53',
      recipients: ['mock-beta'],
    });
    const source = { group: input.id, bot: 'mock-alpha', runId: 'run-1' };
    const history = await groups.history(source, {});
    expect.assert(!JSON.stringify(history).includes('FUTURE-SECRET-53'));
    const exact = await groups.history(source, {
      messageId: page.messages[0].id,
      offset: 0,
      limit: 7,
    });
    expect.assert('content' in exact);
    expect(exact.content).toBe('合成人类请求 ');
    await expect(groups.history(source, { messageId: 'mock-future-source' })).rejects.toMatchObject(
      {
        code: 'GROUP_MESSAGE_NOT_FOUND',
      },
    );
    await expect(groups.history({ ...source, runId: 'wrong-run' }, {})).rejects.toMatchObject({
      code: 'GROUP_SOURCE_CLOSED',
    });
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('group handoffs are bounded even when members repeatedly hand control back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-hop-limit-'));
  const run = runner();
  const groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
  try {
    await groups.ready;
    await groups.register(input);
    await groups.send({
      id: 'mock-hops',
      group: input.id,
      prompt: '合成协作',
      recipients: ['mock-alpha'],
    });
    await groups.tick();
    for (let i = 0; i < 7; i++) {
      const current = run.calls[i],
        target = current.bot === 'mock-alpha' ? 'mock-beta' : 'mock-alpha';
      await groups.handoff(
        { group: input.id, bot: current.bot, runId: `run-${i + 1}` },
        { bot: target, message: '合成下一步' },
      );
      run.complete(i, '合成已处理');
      await groups.tick();
    }
    const last = run.calls[7];
    await expect(
      groups.handoff(
        { group: input.id, bot: last.bot, runId: 'run-8' },
        { bot: last.bot === 'mock-alpha' ? 'mock-beta' : 'mock-alpha', message: '不应再扩展' },
      ),
    ).rejects.toMatchObject({ code: 'GROUP_HANDOFF_LIMIT' });
    expect(run.calls.length).toBe(8);
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retained input payloads count against group storage and rejected uploads release reservations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-group-quota-'));
  const dbfile = path.join(dir, 'groups.sqlite');
  const fake = runner();
  const uploads = new Attachments(path.join(dir, 'uploads.sqlite'));
  const groups = new Groups(dbfile, fake.value, uploads);
  try {
    await groups.ready;
    await groups.register(input);
    const file = await uploads.upload(
      input.id,
      { name: 'mock.pdf', data: Buffer.from('synthetic').toString('base64') },
      async () => 'SYNTHETIC',
    );
    await expect(
      groups.send({
        id: 'bad-input',
        group: input.id,
        prompt: '合成',
        recipients: input.members,
        files: [{ name: 'mock.pdf', attachmentId: 'a'.repeat(40) }],
      }),
    ).rejects.toThrowError();
    expect(groups.inputBusy(input.id, 'a'.repeat(40))).toBe(false);
    await groups.send({
      id: 'old-input',
      group: input.id,
      prompt: '合成',
      recipients: input.members,
    });
    await groups.cancel(input.id, 'old-input');
    const db = new DatabaseSync(dbfile);
    drizzle({ client: db })
      .update(groupTurns)
      .set({ signature: 'x'.repeat(50 * 1024 * 1024) })
      .run();
    db.close();
    await expect(
      groups.send({
        id: 'over-quota',
        group: input.id,
        prompt: '合成',
        recipients: input.members,
        files: [{ name: 'mock.pdf', attachmentId: file.id }],
      }),
    ).rejects.toMatchObject({ code: 'GROUP_STORAGE_LIMIT' });
    expect(groups.inputBusy(input.id, file.id)).toBe(false);
    expect(
      (await groups.read(input.id)).messages.filter((message) => message.id === 'over-quota')
        .length,
    ).toBe(0);
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});
