import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Attachments } from './attachments.js';
import { GroupTools } from './group-tools.js';
import { type GroupRunner, Groups } from './groups.js';
import { WorkspaceFiles } from './workspace.js';

const input = { id: 'mock-group', name: '合成协作群', members: ['mock-alpha', 'mock-beta'] };
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
    assert.deepEqual(await groups.notices(), []);
    await groups.tick();
    fake.complete(0, 'SYNTHETIC MEMBER RESULT');
    await groups.tick();
    assert.deepEqual(await groups.notices(), []);
    fake.complete(1, 'SYNTHETIC MEMBER RESULT');
    await groups.tick();
    const result = await groups.notices();
    assert.deepEqual(result, [
      { kind: 'group', id: 'mock-notice-turn', group: input.id, phase: 'completed' },
    ]);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC PRIVATE'));
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
    assert.ok(held.deliveries.every((row) => row.state === 'pending'));
    assert.equal(fake.calls.length, 0);
    fake.value.start = start;
    await groups.tick();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].bot, 'mock-alpha');
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
    await assert.rejects(
      groups.action({ id: 'mock-archive', group: input.id, action: 'archive', revision: 1 }),
      { code: 'GROUP_BUSY' },
    );
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
    assert.equal(archived.group.archived, true);
    assert.equal(archived.group.revision, 2);
    assert.deepEqual((await groups.read(input.id)).messages, before.messages);
    await assert.rejects(
      groups.send({
        id: 'mock-denied',
        group: input.id,
        prompt: 'SYNTHETIC DENIED',
        recipients: input.members,
      }),
      { code: 'GROUP_ARCHIVED' },
    );
    await assert.rejects(
      groups.update(input.id, 2, { name: 'SYNTHETIC DENIED EDIT', members: input.members }),
      { code: 'GROUP_ARCHIVED' },
    );
    assert.deepEqual(
      (
        await groups.send({
          id: 'mock-turn',
          group: input.id,
          prompt: 'SYNTHETIC RETAINED HISTORY',
          recipients: ['mock-alpha'],
        })
      ).accepted,
      before.messages.find((item) => item.id === 'mock-turn'),
    );
    await groups.close();
    groups = new Groups(file, fake.value);
    assert.equal((await groups.actionReceipt(input.id, request.id)).group.archived, true);
    const restored = await groups.action({
      id: 'mock-restore',
      group: input.id,
      action: 'restore',
      revision: 2,
    });
    assert.equal(!!restored.group.archived, false);
    assert.deepEqual(restored.group.members, input.members);
    assert.equal(fake.calls.length, 1);
    const edited = await groups.update(input.id, 3, {
      name: '合成后续群名',
      members: input.members,
    });
    const replay = await groups.action(request);
    assert.equal(replay.group.name, edited.name);
    assert.equal(!!replay.group.archived, false);
    assert.equal(replay.receipt.revision, 2);
    await assert.rejects(groups.action({ ...request, action: 'restore', revision: 4 }), {
      code: 'GROUP_ACTION_ID_REUSED',
    });
    await assert.rejects(
      groups.action({ id: 'mock-stale', group: input.id, action: 'archive', revision: 1 }),
      { code: 'GROUP_CONFLICT' },
    );
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
    await assert.rejects(
      groups.action({ id: 'mock-busy-archive', group: input.id, action: 'archive', revision: 1 }),
      { code: 'GROUP_BUSY' },
    );
    release();
    await cancel;
    fake.active.add('mock-alpha');
    const archived = await groups.action({
      id: 'mock-private-archive',
      group: input.id,
      action: 'archive',
      revision: 1,
    });
    assert.equal(archived.group.archived, true);
    assert.equal(fake.active.has('mock-alpha'), true);
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
    await assert.rejects(groups.send(send), { code: 'GROUP_REVISION_REQUIRED' });
    await assert.rejects(groups.send({ ...send, revision: 1 }), { code: 'GROUP_CONFLICT' });
    const current = { ...send, id: 'mock-current', revision: 3 };
    const accepted = await groups.send(current);
    await groups.cancel(input.id, current.id);
    await groups.action({ id: 'mock-a2', group: input.id, action: 'archive', revision: 3 });
    assert.deepEqual((await groups.send(current)).accepted, accepted.accepted);
    await assert.rejects(groups.send({ ...current, revision: 4 }), {
      code: 'GROUP_REQUEST_ID_REUSED',
    });
    assert.equal(fake.calls.length, 0);
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
    assert.equal(await groups.hasPendingBot('mock-alpha'), true);
    blocked.add('mock-alpha');
    await groups.tick();
    assert.equal(fake.calls.length, 0);
    await assert.rejects(
      groups.send({
        id: 'mock-blocked-turn',
        group: input.id,
        prompt: '合成不得派发',
        recipients: ['mock-alpha'],
      }),
      { code: 'BOT_UNAVAILABLE' },
    );
    await assert.rejects(groups.register({ ...input, id: 'mock-alpha' }), {
      code: 'GROUP_ID_CONFLICT',
    });
    await assert.rejects(groups.register({ ...input, id: 'mock-new-with-archived' }), {
      code: 'BOT_UNAVAILABLE',
    });
    const cancelled = await groups.cancel(input.id, 'mock-queued-archive');
    assert.ok(JSON.stringify(cancelled).includes('合成待取消协作'));
    assert.equal(await groups.hasPendingBot('mock-alpha'), false);
    await groups.update(input.id, 1, { name: '合成保留成员的群', members: input.members });
    await groups.send({
      id: 'mock-independent-turn',
      group: input.id,
      prompt: '合成其他成员任务',
      recipients: ['mock-beta'],
    });
    await groups.tick();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].bot, 'mock-beta');
    await assert.rejects(
      groups.handoff(
        { bot: 'mock-beta', runId: 'run-1', group: input.id },
        { bot: 'mock-alpha', message: '合成不得转交' },
      ),
      { code: 'BOT_UNAVAILABLE' },
    );
    fake.complete(0, 'SYNTHETIC-OTHER-RESULT');
    await groups.tick();
    blocked.clear();
    await groups.tick();
    assert.equal(fake.calls.length, 1);
    assert.equal(await groups.hasPendingBot('mock-beta'), false);
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
    assert.equal(fake.calls.length, 0);
    assert.equal(await groups.hasPendingBot('mock-alpha'), true);
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
    assert.equal(groups.inputBusy(input.id, receipt.id), true);
    assert.equal(groups.inputBusy('another-group', receipt.id), false);
    assert.deepEqual(await groups.inputSource(input.id, 'mock-file-turn', 'source.pdf'), files[1]);
    await groups.close();
    groups = new Groups(path.join(dir, 'groups.sqlite'), fake.value, uploads);
    await groups.ready;
    assert.deepEqual(await groups.inputSource(input.id, 'mock-file-turn', 'input.csv'), files[0]);
    await groups.tick();
    assert.equal(groups.inputBusy(input.id, receipt.id), true);
    fake.complete(0, '完成合成');
    await groups.tick();
    assert.equal(groups.inputBusy(input.id, receipt.id), false);
    await assert.rejects(
      groups.send({
        id: 'mock-other-input',
        group: input.id,
        prompt: '不应接受',
        recipients: ['mock-alpha'],
        files: [{ name: 'other.pdf', attachmentId: 'a'.repeat(64) }],
      }),
      { code: 'ATTACHMENT_NOT_FOUND' },
    );
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
    assert.equal(
      tools.list('mock-alpha').some((tool) => tool.name === 'group_handoff'),
      false,
    );
    assert.equal(
      tools.list('mock-alpha', undefined, input.id).some((tool) => tool.name === 'group_handoff'),
      true,
    );
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
    assert.equal(denied.isError, true);
    assert.ok(JSON.stringify(denied).includes('GROUP_SOURCE_CLOSED'));
    const history = await tools.invoke(run, 'group_history', {});
    assert.equal(history.isError, undefined);
    const handoff = await tools.invoke(run, 'group_handoff', {
      bot: 'mock-beta',
      message: '合成继续',
    });
    assert.equal(handoff.isError, undefined);
    assert.equal(run.toolCount, 2);
    const limit = await tools.invoke(run, 'group_history', {});
    assert.equal(limit.isError, true);
    assert.ok(JSON.stringify(limit).includes('TOOL_LIMIT'));
    run.abort.abort();
    const cancelled = await tools.invoke(run, 'group_history', {});
    assert.ok(JSON.stringify(cancelled).includes('MODEL_CANCELLED'));
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
    assert.equal(group.revision, 1);
    assert.deepEqual(await groups.register({ ...input, name: '过时缓存' }), group);
    const send = {
      id: 'mock-human',
      group: group.id,
      prompt: '合成问题 HUMAN-47',
      recipients: input.members,
    };
    const first = await groups.send(send);
    assert.equal(first.messages.length, 1);
    assert.deepEqual(await groups.send(send), first);
    await assert.rejects(groups.send({ ...send, prompt: '另一份内容' }), {
      code: 'GROUP_REQUEST_ID_REUSED',
    });
    await groups.tick();
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].bot, 'mock-alpha');
    assert.equal(run.calls[0].prompt, send.prompt);
    await assert.rejects(groups.update(group.id, 1, { name: '忙时修改', members: input.members }), {
      code: 'GROUP_BUSY',
    });
    run.complete(0, 'ALPHA-53');
    await groups.tick();
    assert.equal(run.calls.length, 2);
    assert.equal(run.calls[1].bot, 'mock-beta');
    assert.ok(run.calls[1].context.includes('ALPHA-53'));
    run.complete(1, 'BETA-59');
    await groups.tick();
    const page = await groups.read(group.id);
    assert.deepEqual(
      page.messages.map((message) => message.role),
      ['user', 'bot', 'bot'],
    );
    assert.equal(page.messages[1].author, 'mock-alpha');
    assert.equal(page.messages[2].author, 'mock-beta');
    assert.ok(page.deliveries.every((item) => item.state === 'completed'));
    const updated = await groups.update(group.id, 1, {
      name: '合成新群名',
      members: input.members,
    });
    assert.equal(updated.revision, 2);
    await assert.rejects(groups.update(group.id, 1, { name: '过时', members: input.members }), {
      code: 'GROUP_CONFLICT',
    });
    await groups.close();
    groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
    await groups.ready;
    assert.deepEqual((await groups.read(group.id)).messages, page.messages);
    await assert.rejects(
      groups.update(group.id, 2, {
        id: 'mock-overridden-id',
        name: '合成损坏输入',
        members: input.members,
      }),
      { code: 'INVALID_GROUP' },
    );
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
    assert.equal(run.calls.length, 1);
    await groups.close();
    run.receipts.clear();
    run.active.clear();
    groups = new Groups(path.join(dir, 'groups.sqlite'), run.value);
    await groups.ready;
    await groups.tick();
    assert.equal(run.calls.length, 1);
    assert.ok((await groups.read(input.id)).deliveries.some((d) => d.state === 'interrupted'));
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
    assert.equal(run.active.has(current.bot), true);
    await groups.tick();
    assert.equal(run.calls.length, 2);
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
    await assert.rejects(groups.handoff(source, { bot: 'not-a-member', message: '不能转交' }), {
      code: 'GROUP_MEMBER_REQUIRED',
    });
    const first = await groups.handoff(source, {
      bot: 'mock-beta',
      message: '请继续合成工作 HANDOFF-61',
    });
    assert.deepEqual(
      await groups.handoff(source, { bot: 'mock-beta', message: '请继续合成工作 HANDOFF-61' }),
      first,
    );
    await assert.rejects(groups.handoff(source, { bot: 'mock-beta', message: '不同指令' }), {
      code: 'GROUP_HANDOFF_CONFLICT',
    });
    run.complete(0, '第一位已完成');
    await groups.tick();
    assert.equal(run.calls.length, 2);
    assert.ok(run.calls[1].context.includes('HANDOFF-61'));
    await assert.rejects(groups.handoff(source, { bot: 'mock-beta', message: '迟到转交' }), {
      code: 'GROUP_SOURCE_CLOSED',
    });
    run.complete(1, '结束合成工作');
    await groups.tick();
    assert.equal(
      (await groups.read(input.id)).messages.filter((m) => m.text.includes('HANDOFF-61')).length,
      1,
    );
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
    assert.ok(!JSON.stringify(history).includes('FUTURE-SECRET-53'));
    const exact = await groups.history(source, {
      messageId: page.messages[0].id,
      offset: 0,
      limit: 7,
    });
    assert.ok('content' in exact);
    assert.equal(exact.content, '合成人类请求 ');
    await assert.rejects(groups.history(source, { messageId: 'mock-future-source' }), {
      code: 'GROUP_MESSAGE_NOT_FOUND',
    });
    await assert.rejects(groups.history({ ...source, runId: 'wrong-run' }, {}), {
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
    await assert.rejects(
      groups.handoff(
        { group: input.id, bot: last.bot, runId: 'run-8' },
        { bot: last.bot === 'mock-alpha' ? 'mock-beta' : 'mock-alpha', message: '不应再扩展' },
      ),
      { code: 'GROUP_HANDOFF_LIMIT' },
    );
    assert.equal(run.calls.length, 8);
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
    await assert.rejects(
      groups.send({
        id: 'bad-input',
        group: input.id,
        prompt: '合成',
        recipients: input.members,
        files: [{ name: 'mock.pdf', attachmentId: 'a'.repeat(40) }],
      }),
    );
    assert.equal(groups.inputBusy(input.id, 'a'.repeat(40)), false);
    await groups.send({
      id: 'old-input',
      group: input.id,
      prompt: '合成',
      recipients: input.members,
    });
    await groups.cancel(input.id, 'old-input');
    const db = new DatabaseSync(dbfile);
    db.prepare("UPDATE group_turns SET signature=printf('%.*c',?,'x')").run(50 * 1024 * 1024);
    db.close();
    await assert.rejects(
      groups.send({
        id: 'over-quota',
        group: input.id,
        prompt: '合成',
        recipients: input.members,
        files: [{ name: 'mock.pdf', attachmentId: file.id }],
      }),
      { code: 'GROUP_STORAGE_LIMIT' },
    );
    assert.equal(groups.inputBusy(input.id, file.id), false);
    assert.equal(
      (await groups.read(input.id)).messages.filter((message) => message.id === 'over-quota')
        .length,
      0,
    );
  } finally {
    await groups.close();
    await rm(dir, { recursive: true, force: true });
  }
});
