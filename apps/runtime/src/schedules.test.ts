import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ScheduleRule } from '@daban/protocol';
import { nativeSchedules } from './schedule-domain.js';
import { type ScheduleDomain, Schedules } from './schedules.js';

test('installed native calendar preserves public Sunday numbering, wall time and recurrence after DST', {
  skip: !existsSync('/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js'),
}, async (t) => {
  const calendar = await nativeSchedules();
  const now = Date.parse('2026-10-29T12:00:00Z');
  const cases: { name: string; rule: ScheduleRule; times: string[] }[] = [
    {
      name: 'daily',
      rule: { kind: 'daily', time: '23:17', timeZone: 'Asia/Shanghai' },
      times: ['2026-10-29T15:17:00.000Z', '2026-10-30T15:17:00.000Z'],
    },
    {
      name: 'Sunday across DST',
      rule: {
        kind: 'weekly',
        weekdays: [0],
        time: '23:17',
        timeZone: 'America/New_York',
      },
      times: ['2026-11-02T04:17:00.000Z', '2026-11-09T04:17:00.000Z'],
    },
    {
      name: 'weekdays across DST',
      rule: {
        kind: 'weekly',
        weekdays: [1, 2, 3, 4, 5],
        time: '23:17',
        timeZone: 'America/New_York',
      },
      times: ['2026-10-30T03:17:00.000Z', '2026-10-31T03:17:00.000Z', '2026-11-03T04:17:00.000Z'],
    },
    {
      name: 'once',
      rule: { kind: 'once', date: '2026-11-15', time: '09:17', timeZone: 'Asia/Shanghai' },
      times: ['2026-11-15T01:17:00.000Z'],
    },
    {
      name: 'cron',
      rule: { kind: 'cron', expression: '17 23 * * 1,3', timeZone: 'Asia/Shanghai' },
      times: ['2026-11-02T15:17:00.000Z', '2026-11-04T15:17:00.000Z'],
    },
  ];
  for (const item of cases)
    await t.test(item.name, () => {
      const original = structuredClone(item.rule);
      let record = calendar.create(
        {
          id: 'mock-native-calendar',
          bot: 'mock-native-bot',
          title: '合成日程',
          prompt: '合成说明',
          rule: item.rule,
        },
        now,
      );
      for (let index = 0; index < item.times.length; index++) {
        assert.equal(record.scheduledAt, item.times[index]);
        record = calendar.decode(record);
        const due = calendar.due(record, Date.parse(record.scheduledAt));
        assert.equal(due.occurrenceAt, record.scheduledAt);
        if (index + 1 < item.times.length) {
          assert.equal(due.nextScheduledAt, item.times[index + 1]);
          record = { ...record, scheduledAt: due.nextScheduledAt! };
        } else if (item.rule.kind === 'once') assert.equal(due.nextScheduledAt, undefined);
      }
      assert.deepEqual(item.rule, original, 'native numbering must not mutate the public rule');
    });
});

const anchor = Date.parse('2026-01-01T00:00:00Z');
const input = {
  id: 'mock-schedule',
  bot: 'mock-alpha',
  title: '合成定时任务',
  prompt: '只处理合成记录',
  rule: { kind: 'every' as const, everySeconds: 60 },
};
// Time arithmetic belongs to DSH and is exercised against the installed package in Linux.
const domain: ScheduleDomain = {
  create(value, now) {
    return {
      id: value.id,
      title: value.title,
      prompt: value.prompt,
      kind: 'every',
      scheduledAt: new Date(now + 60000).toISOString(),
    };
  },
  due(_record, now) {
    return {
      occurrenceAt: new Date(now).toISOString(),
      nextScheduledAt: new Date(now + 60000).toISOString(),
    };
  },
  decode(value) {
    return value;
  },
};
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-schedules-'));
  let now = anchor;
  const busy = new Set<string>();
  const receipts = new Map<string, { runId: string; phase: string; error: string }>();
  const calls: { bot: string; task: { requestId: string; prompt: string } }[] = [];
  const runner = {
    running(bot: string) {
      return busy.has(bot);
    },
    findRequest(_bot: string, id: string) {
      return receipts.get(id);
    },
    async start(bot: string, task: { requestId: string; prompt: string }) {
      if (busy.has(bot))
        throw Object.assign(new Error('MODEL_ALREADY_RUNNING'), { code: 'MODEL_ALREADY_RUNNING' });
      calls.push({ bot, task });
      busy.add(bot);
      const receipt = { runId: `mock-run-${calls.length}`, phase: 'running', error: '' };
      receipts.set(task.requestId, receipt);
      return receipt;
    },
  };
  const options = {
    file: path.join(directory, 'schedules.sqlite'),
    runner,
    clock: () => now,
    domain: Promise.resolve(domain),
  };
  let store = new Schedules(options);
  await store.ready;
  return {
    directory,
    options,
    runner,
    calls,
    busy,
    receipts,
    get store() {
      return store;
    },
    setTime(value: number) {
      now = value;
    },
    async reopen() {
      await store.close();
      store = new Schedules(options);
      await store.ready;
    },
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Bot archive suspends owned schedules and unclaimed firings without erasing locks, history or another Bot', async () => {
  const f = await fixture();
  try {
    await f.store.create({ ...input, locked: true });
    await f.store.create({ ...input, id: 'mock-other-plan', bot: 'mock-beta' });
    f.busy.add(input.bot);
    f.setTime(anchor + 61000);
    await f.store.tick();
    assert.equal(f.calls.length, 1);
    const before = await f.store.get(input.id);
    const other = await f.store.get('mock-other-plan');
    Object.assign(f.runner, { admit: (bot: string) => bot !== input.bot });
    const result = await f.store.suspendBot(input.bot);
    assert.equal(result.disabled, 1);
    assert.equal(result.cancelled, 1);
    const paused = await f.store.get(input.id);
    assert.equal(paused.enabled, false);
    assert.equal(paused.locked, true);
    assert.equal(paused.revision, before.revision + 1);
    assert.equal(paused.history[0].state, 'cancelled');
    assert.equal(paused.history[0].error, 'BOT_ARCHIVED');
    assert.deepEqual(await f.store.get('mock-other-plan'), other);
    assert.deepEqual(await f.store.suspendBot(input.bot), { disabled: 0, cancelled: 0 });
    await assert.rejects(f.store.create({ ...input, id: 'mock-blocked-new-plan' }), {
      code: 'BOT_UNAVAILABLE',
    });
    await assert.rejects(f.store.update(input.id, paused.revision, { enabled: true }), {
      code: 'BOT_UNAVAILABLE',
    });
    await assert.rejects(f.store.run(input.id, 'mock-blocked-manual'), { code: 'BOT_UNAVAILABLE' });
    Object.assign(f.runner, { admit: () => true });
    await f.reopen();
    assert.equal((await f.store.get(input.id)).enabled, false);
    assert.equal((await f.store.get(input.id)).history[0].state, 'cancelled');
    assert.equal((await f.store.get('mock-other-plan')).enabled, true);
    assert.equal(f.calls.filter((call) => call.bot === input.bot).length, 0);
  } finally {
    await f.close();
  }
});

test('schedule admission is checked before enqueue and dispatch while lifecycle intent is pending', async () => {
  const f = await fixture();
  try {
    await f.store.create(input);
    Object.assign(f.runner, { admit: () => false });
    f.setTime(anchor + 61000);
    await f.store.tick();
    assert.equal((await f.store.get(input.id)).history.length, 0);
    assert.equal(f.calls.length, 0);
    Object.assign(f.runner, { admit: () => true });
    f.busy.add(input.bot);
    await f.store.run(input.id, 'mock-existing-firing');
    f.busy.clear();
    Object.assign(f.runner, { admit: () => false });
    await f.store.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.store.get(input.id)).history[0].state, 'pending');
  } finally {
    await f.close();
  }
});

for (const code of ['BOT_CHANGING', 'RUNTIME_RECOVERY_PENDING', 'CHAT_CONFLICT']) {
  test(`a ${code} reservation racing a schedule claim keeps the unissued firing pending`, async () => {
    const f = await fixture();
    try {
      await f.store.create(input);
      const start = f.runner.start;
      Object.assign(f.runner, {
        start: async () => {
          throw Object.assign(new Error(code), { code });
        },
      });
      f.setTime(anchor + 61000);
      await f.store.tick();
      assert.equal((await f.store.get(input.id)).history[0].state, 'pending');
      assert.equal(f.calls.length, 0);
      Object.assign(f.runner, { start });
      await f.store.tick();
      assert.equal(f.calls.length, 1);
    } finally {
      await f.close();
    }
  });
}
test('Bot schedule ownership and human locks are enforced inside the shared durable service', async () => {
  const f = await fixture();
  const actor = { bot: input.bot, signal: new AbortController().signal };
  try {
    const created = await f.store.create(input, actor);
    await f.store.create({ ...input, id: 'mock-other-schedule', bot: 'mock-beta' });
    assert.equal((await f.store.list(actor)).length, 1);
    await assert.rejects(f.store.get('mock-other-schedule', actor), { code: 'SCHEDULE_NOT_FOUND' });
    await assert.rejects(f.store.update('mock-other-schedule', 1, { enabled: false }, actor), {
      code: 'SCHEDULE_NOT_FOUND',
    });
    await assert.rejects(f.store.remove('mock-other-schedule', 1, actor), {
      code: 'SCHEDULE_NOT_FOUND',
    });
    await assert.rejects(
      f.store.create({ ...input, id: 'mock-forged-owner', bot: 'mock-beta' }, actor),
      { code: 'SCHEDULE_NOT_FOUND' },
    );
    await f.store.run(input.id, 'mock-queued-before-lock');
    const locked = await f.store.update(input.id, created.revision, { locked: true });
    assert.equal(locked.locked, true);
    assert.equal(
      locked.history[0].state,
      'pending',
      'locking is edit protection, not cancellation',
    );
    assert.equal((await f.store.get(input.id, actor)).locked, true);
    await assert.rejects(f.store.update(input.id, locked.revision, { title: 'Bot 改动' }, actor), {
      code: 'SCHEDULE_LOCKED',
    });
    await assert.rejects(f.store.update(input.id, locked.revision, { locked: false }, actor), {
      code: 'SCHEDULE_LOCKED',
    });
    await assert.rejects(f.store.remove(input.id, locked.revision, actor), {
      code: 'SCHEDULE_LOCKED',
    });
    const unlocked = await f.store.update(input.id, locked.revision, { locked: false });
    assert.equal(
      (await f.store.update(input.id, unlocked.revision, { title: '合成已允许改动' }, actor)).title,
      '合成已允许改动',
    );
    await f.reopen();
    assert.equal((await f.store.get(input.id)).locked, false);
    const abort = new AbortController();
    const queued = f.store.create(
      { ...input, id: 'mock-stopped-create' },
      { bot: input.bot, signal: abort.signal },
    );
    abort.abort();
    await assert.rejects(queued);
    await assert.rejects(f.store.get('mock-stopped-create'), { code: 'SCHEDULE_NOT_FOUND' });
  } finally {
    await f.close();
  }
});

test('older schedule records without a lock flag remain readable and idempotent after upgrade', async () => {
  const f = await fixture();
  try {
    await f.store.create(input);
    await f.store.close();
    const db = new DatabaseSync(f.options.file);
    const raw = JSON.parse(
      String(db.prepare('SELECT input FROM schedules WHERE id=?').get(input.id)!.input),
    );
    delete raw.locked;
    db.prepare('UPDATE schedules SET input=? WHERE id=?').run(JSON.stringify(raw), input.id);
    db.close();
    await f.reopen();
    const current = await f.store.get(input.id);
    assert.equal(current.locked, false);
    assert.deepEqual(await f.store.create(input), current);
  } finally {
    await f.close();
  }
});

test('durable schedules create idempotently, execute once per occurrence and preserve task provenance', async () => {
  const f = await fixture();
  try {
    const created = await f.store.create(input);
    assert.equal(created.nextRunAt, '2026-01-01T00:01:00.000Z');
    assert.deepEqual(await f.store.create(input), created);
    f.setTime(anchor + 30000);
    const edited = await f.store.update(input.id, 1, { title: '  合成新名称  ', rule: input.rule });
    assert.equal(edited.title, '合成新名称');
    assert.equal(edited.nextRunAt, created.nextRunAt);
    await assert.rejects(f.store.create({ ...input, prompt: '另一份合成任务' }), {
      code: 'SCHEDULE_ID_REUSED',
    });
    f.setTime(anchor + 60000);
    await Promise.all([f.store.tick(), f.store.tick()]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].bot, input.bot);
    assert.match(f.calls[0].task.prompt, /合成新名称/);
    assert.match(f.calls[0].task.prompt, /2026-01-01T00:01:00/);
    assert.match(f.calls[0].task.prompt, /只处理合成记录/);
    f.receipts.get(f.calls[0].task.requestId)!.phase = 'completed';
    f.busy.clear();
    await f.store.tick();
    assert.equal((await f.store.list())[0].history[0].state, 'completed');
    await f.reopen();
    await f.store.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await stat(f.options.file)).mode & 0o777, 0o600);
    await f.store.close();
    await f.store.close();
  } finally {
    await f.close();
  }
});

test('busy Bots queue a firing, repeated manual requests deduplicate and due triggers coalesce', async () => {
  const f = await fixture();
  try {
    await f.store.create(input);
    f.busy.add(input.bot);
    const manual = await f.store.run(input.id, 'mock-manual');
    assert.deepEqual(await f.store.run(input.id, 'mock-manual'), manual);
    f.setTime(anchor + 60000);
    await f.store.tick();
    assert.equal(f.calls.length, 0);
    assert.equal(
      (await f.store.list())[0].history.filter((item) => item.state === 'pending').length,
      1,
    );
    assert.equal(
      (await f.store.list())[0].history.filter((item) => item.state === 'coalesced').length,
      1,
    );
    await f.store.create({ ...input, id: 'mock-beta-schedule', bot: 'mock-beta' });
    await f.store.run('mock-beta-schedule', 'mock-beta-manual');
    await f.store.tick();
    assert.equal(f.calls[0].bot, 'mock-beta');
    f.busy.delete(input.bot);
    await f.store.tick();
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('pause and edits cancel queued work; resume recalculates forward; revisions protect against stale saves', async () => {
  const f = await fixture();
  try {
    await f.store.create(input);
    await f.store.run(input.id, 'mock-pending');
    const paused = await f.store.update(input.id, 1, { enabled: false });
    assert.equal(paused.history[0].state, 'cancelled');
    f.setTime(anchor + 3600000);
    await f.store.tick();
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.store.update(input.id, 1, { enabled: true }), {
      code: 'SCHEDULE_CONFLICT',
    });
    const resumed = await f.store.update(input.id, paused.revision, { enabled: true });
    assert.equal(resumed.nextRunAt, '2026-01-01T01:01:00.000Z');
    await f.store.run(input.id, 'mock-second-pending');
    await f.store.remove(input.id, resumed.revision);
    await f.store.tick();
    assert.equal(f.calls.length, 0);
    assert.equal((await f.store.list()).length, 0);
  } finally {
    await f.close();
  }
});

test('ambiguous startup is interrupted without replay, while definite busy rejection remains queued', async () => {
  const f = await fixture();
  try {
    await f.store.create(input);
    await f.store.run(input.id, 'mock-uncertain');
    f.runner.start = async () => {
      throw new Error('synthetic ambiguous failure');
    };
    await f.store.tick();
    assert.equal((await f.store.list())[0].history[0].state, 'interrupted');
    await f.reopen();
    await f.store.tick();
    assert.equal(f.calls.length, 0);
    await f.store.run(input.id, 'mock-busy-race');
    f.runner.start = async () => {
      throw Object.assign(new Error('MODEL_ALREADY_RUNNING'), { code: 'MODEL_ALREADY_RUNNING' });
    };
    await f.store.tick();
    assert.equal((await f.store.list())[0].history[0].state, 'pending');
    await f.store.update(input.id, 1, { enabled: false });
    await f.store.run(input.id, 'mock-accepted-then-lost');
    f.runner.start = async (_bot, task) => {
      f.receipts.set(task.requestId, { runId: 'mock-accepted', phase: 'running', error: '' });
      throw new Error('synthetic response lost after acceptance');
    };
    await f.store.tick();
    assert.equal((await f.store.list())[0].history[0].state, 'running');
  } finally {
    await f.close();
  }
});

test('restart follows durable model receipts and never retries an interrupted running occurrence', async () => {
  const f = await fixture();
  try {
    await f.store.create(input);
    await f.store.run(input.id, 'mock-running');
    await f.store.tick();
    f.receipts.get(f.calls[0].task.requestId)!.phase = 'interrupted';
    f.busy.clear();
    await f.reopen();
    await f.store.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.store.list())[0].history[0].state, 'interrupted');
    await assert.rejects(f.store.create({ ...input, id: '../bad' }), { code: 'INVALID_SCHEDULE' });
    await assert.rejects(f.store.create({ ...input, id: 'mock-bad', prompt: '' }), {
      code: 'INVALID_SCHEDULE',
    });
    const bytes = await readFile(f.options.file);
    assert.ok(bytes.length > 0);
  } finally {
    await f.close();
  }
});
