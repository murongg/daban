import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAutomationNotice, isAutomationSource, isScheduleInput } from '@daban/protocol';
import { expect, test } from 'vitest';
import { sampleFiles, signalDigest } from './automation.js';
import { secureDirectory } from './private-files.js';
import { type ScheduleDomain, Schedules } from './schedules.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-'));
  await secureDirectory(root);
  let now = Date.parse('2026-01-01T00:00:00Z');
  let bytes: Uint8Array | null = Buffer.from('A');
  let allowed = true;
  const calls: { bot: string; task: { requestId: string; prompt: string }; source?: unknown }[] =
    [];
  const receipts = new Map<string, { runId: string; phase: string; error?: string }>();
  const busy = new Set<string>();
  const domain: ScheduleDomain = {
    create: (value, time) => ({
      ...value,
      kind: 'every',
      scheduledAt: new Date(time + 60000).toISOString(),
    }),
    due: (_value, time) => ({
      occurrenceAt: new Date(time).toISOString(),
      nextScheduledAt: new Date(time + 60000).toISOString(),
    }),
    decode: (value) => value,
  };
  const options = {
    file: path.join(root, 'schedules.sqlite'),
    clock: () => now,
    domain: Promise.resolve(domain),
    observation: {
      authorize: () => {
        if (!allowed)
          throw Object.assign(new Error('PROJECT_ACCESS_DENIED'), {
            code: 'PROJECT_ACCESS_DENIED',
          });
      },
      read: async () => bytes,
    },
    runner: {
      running: (bot: string) => busy.has(bot),
      findRequest: (_bot: string, request: string) => receipts.get(request),
      start: async (
        bot: string,
        task: { requestId: string; prompt: string },
        _conversation?: undefined,
        source?: unknown,
      ) => {
        calls.push({ bot, task, source });
        receipts.set(task.requestId, { runId: `mock-run-${calls.length}`, phase: 'completed' });
      },
    },
  };
  let store = new Schedules(options);
  await store.ready;
  return {
    get store() {
      return store;
    },
    calls,
    receipts,
    busy,
    options,
    setBytes(value: string | null) {
      bytes = value === null ? null : Buffer.from(value);
    },
    revoke() {
      allowed = false;
    },
    setTime(value: number) {
      now = value;
    },
    async poll() {
      now += 60000;
      await store.tick();
    },
    async reopen(beforeFloor = false) {
      await store.close();
      if (beforeFloor) {
        // Build the exact pre-floor schema/journal while retaining synthetic firing and notice records.
        const client = new DatabaseSync(options.file);
        try {
          client.exec('ALTER TABLE automations DROP COLUMN resultFloor');
          client
            .prepare('DELETE FROM __drizzle_migrations WHERE name = ?')
            .run('20261104194048_result-floor');
        } finally {
          client.close();
        }
      }
      store = new Schedules(options);
      await store.ready;
    },
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const rule = {
  kind: 'file',
  scope: { projectId: 'mock-project', revision: 1 },
  paths: ['data/mock.txt'],
  pollSeconds: 60,
};
const input = (value: unknown) => ({
  id: 'mock-file-plan',
  bot: 'mock-bot',
  title: 'Synthetic monitor',
  prompt: 'Inspect synthetic data only',
  enabled: false,
  rule: value,
});

const invalidEnums: unknown[] = [
  ['file'],
  ['manual'],
  ['completed'],
  ['changed'],
  [],
  null,
  false,
  1,
  { toString: null, valueOf: null },
];
test.each(invalidEnums)(
  'rejects non-string automation triggers without coercion or exceptions %#',
  (value) => {
    const source = {
      scheduleId: 'mock-rule',
      firingId: 'mock-firing',
      configRevision: 1,
      trigger: value,
      policy: { kind: 'all' },
    };
    expect(isAutomationSource(source)).toBe(false);
  },
);
test.each(invalidEnums)(
  'rejects non-string automation phases without coercion or exceptions %#',
  (value) => {
    const notice = {
      kind: 'automation',
      id: 'mock-notice',
      bot: 'mock-bot',
      schedule: 'mock-rule',
      phase: 'completed',
      reason: 'changed',
    };
    expect(isAutomationNotice({ ...notice, phase: value })).toBe(false);
  },
);
test.each(invalidEnums)(
  'rejects non-string automation reasons without coercion or exceptions %#',
  (value) => {
    const notice = {
      kind: 'automation',
      id: 'mock-notice',
      bot: 'mock-bot',
      schedule: 'mock-rule',
      phase: 'completed',
      reason: 'changed',
    };
    expect(isAutomationNotice({ ...notice, reason: value })).toBe(false);
  },
);

test('retains valid original enum strings and mandatory file-source evidence', () => {
  const source = {
    scheduleId: 'mock-rule',
    firingId: 'mock-firing',
    configRevision: 1,
    policy: { kind: 'all' },
  };
  for (const trigger of ['time', 'manual'])
    expect(isAutomationSource({ ...source, trigger })).toBe(true);
  expect(isAutomationSource({ ...source, trigger: 'file' })).toBe(false);
  expect(
    isAutomationSource({
      ...source,
      trigger: 'file',
      scope: { projectId: 'mock-project', revision: 1 },
      paths: ['mock.txt'],
      fromCursor: 1,
      toCursor: 2,
      before: 'a'.repeat(64),
      after: 'b'.repeat(64),
    }),
  ).toBe(true);
  for (const phase of ['completed', 'failed', 'interrupted'])
    for (const reason of ['changed', 'fault', 'recovered'])
      expect(
        isAutomationNotice({
          kind: 'automation',
          id: 'mock-notice',
          bot: 'mock-bot',
          schedule: 'mock-rule',
          phase,
          reason,
        }),
      ).toBe(true);
});

test.each([60, 86400])('accepts a paused file rule at %i seconds', (pollSeconds) => {
  expect(isScheduleInput(input({ ...rule, pollSeconds }))).toBe(true);
});

test.each([
  { ...rule, pollSeconds: 59 },
  { ...rule, pollSeconds: 86401 },
  { ...rule, paths: [] },
  { ...rule, paths: ['data/mock.txt', 'data/mock.txt'] },
  { ...rule, paths: Array.from({ length: 21 }, (_, index) => `data/mock-${index}.txt`) },
  { ...rule, paths: ['/synthetic/mock.txt'] },
  { ...rule, paths: ['../mock.txt'] },
  { ...rule, scope: { projectId: 'mock-project', revision: 0 } },
  { ...rule, unexpected: true },
])('rejects an invalid file rule %#', (value) => {
  expect(isScheduleInput(input(value))).toBe(false);
});

test('preserves ordinary time schedule input', () => {
  expect(isScheduleInput(input({ kind: 'every', everySeconds: 60 }))).toBe(true);
});

test('the owner captures ordinary schedule provenance without inferring it from a prompt or request prefix', async () => {
  const f = await fixture();
  try {
    const item = await f.store.create(input({ kind: 'every', everySeconds: 60 }));
    const firing = await f.store.run(item.id, 'mock-user-chosen-request');
    await f.store.tick();
    expect(f.calls[0].source).toMatchObject({
      scheduleId: item.id,
      firingId: firing.id,
      trigger: 'manual',
      policy: { kind: 'all' },
    });
  } finally {
    await f.close();
  }
});

test('file rules start paused, establish a stable baseline and retain A/B/A/B event cursors across restart', async () => {
  const f = await fixture();
  try {
    const created = await f.store.create({ ...input(rule), enabled: true });
    expect(created.enabled).toBe(false);
    await f.store.update(created.id, created.revision, { enabled: true });
    await f.poll();
    await f.poll();
    expect(f.calls).toHaveLength(0);
    for (const value of ['B', 'A', 'B']) {
      const count = f.calls.length;
      f.setBytes(value);
      await f.poll();
      expect(f.calls).toHaveLength(count);
      await f.poll();
      await f.reopen();
    }
    expect(f.calls).toHaveLength(3);
    expect(f.calls.map((call) => call.source)).toMatchObject([
      { trigger: 'file', fromCursor: 1, toCursor: 1 },
      { trigger: 'file', fromCursor: 2, toCursor: 2 },
      { trigger: 'file', fromCursor: 3, toCursor: 3 },
    ]);
    expect(new Set(f.calls.map((call) => call.task.requestId)).size).toBe(3);
  } finally {
    await f.close();
  }
});

test('locking preserves the stable baseline and latest pending input while revoked scopes cannot dispatch', async () => {
  const f = await fixture();
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.busy.add(item.bot);
    for (const value of ['B', 'C']) {
      f.setBytes(value);
      await f.poll();
      await f.poll();
    }
    item = await f.store.get(item.id);
    const prior = item.automation;
    item = await f.store.update(item.id, item.revision, { locked: true });
    expect(item.automation).toStrictEqual(prior);
    expect(item.history.filter((entry) => entry.state === 'pending')).toHaveLength(1);
    f.busy.clear();
    await f.poll();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].source).toMatchObject({ fromCursor: 1, toCursor: 2 });
    await expect(
      f.store.update(item.id, item.revision, { prompt: 'untrusted change' }, { bot: item.bot }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_LOCKED' });
    f.setBytes('D');
    await f.poll();
    await f.poll();
    expect(f.calls).toHaveLength(2);
    f.revoke();
    f.setBytes('E');
    await f.poll();
    await f.poll();
    expect(f.calls).toHaveLength(2);
    expect((await f.store.get(item.id)).enabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('result signals normalize newlines, stay silent on equal results, and notify once for change, failure and recovery', async () => {
  const f = await fixture();
  let result = Buffer.from('A\r\n');
  Object.assign(f.options.runner, { signal: async () => result });
  try {
    let item = await f.store.create(input({ kind: 'every', everySeconds: 60 }));
    item = await f.store.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'mock.txt',
    });
    expect(item.enabled).toBe(false);
    const execute = async () => {
      await f.store.run(item.id, `mock-manual-${f.calls.length}`);
      await f.store.tick();
    };
    await execute();
    expect((await f.store.get(item.id)).history[0].monitor).toBe('baseline');
    expect(await f.store.notices()).toHaveLength(0);
    result = Buffer.from('A\n\n');
    await execute();
    expect((await f.store.get(item.id)).history[0].monitor).toBe('unchanged');
    expect(await f.store.notices()).toHaveLength(0);
    result = Buffer.from('B');
    await execute();
    const changed = (await f.store.notices())[0];
    expect(changed.reason).toBe('changed');
    await f.store.ack(item.id, changed.id);
    await f.reopen();
    await execute();
    expect(await f.store.notices()).toHaveLength(0);
    result = Buffer.from([0xff]);
    await execute();
    const fault = (await f.store.notices())[0];
    expect(fault.code).toBe('AUTOMATION_SIGNAL_UNAVAILABLE');
    await execute();
    expect((await f.store.notices())[0].id).toBe(fault.id);
    await f.store.ack(item.id, fault.id);
    result = Buffer.from('B');
    await execute();
    expect((await f.store.notices())[0].reason).toBe('recovered');
    expect((await f.store.get(item.id)).history[0].monitor).toBe('recovered');
  } finally {
    await f.close();
  }
});

test('an unknown accepted outcome is only reconciled by its original receipt, never dispatched again', async () => {
  const f = await fixture();
  let attempts = 0;
  Object.assign(f.options.runner, {
    start: async () => {
      attempts++;
      throw new Error('synthetic lost acknowledgement');
    },
    signal: async () => Buffer.from('Synthetic result'),
  });
  try {
    let item = await f.store.create(input({ kind: 'every', everySeconds: 60 }));
    item = await f.store.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'mock.txt',
    });
    const firing = await f.store.run(item.id, 'mock-uncertain');
    await f.store.tick();
    await f.reopen();
    await f.store.tick();
    expect(attempts).toBe(1);
    expect((await f.store.get(item.id)).history[0]).toMatchObject({
      state: 'interrupted',
      error: 'SCHEDULE_OUTCOME_UNKNOWN',
    });
    f.receipts.set(firing.requestId, { runId: 'mock-late-run', phase: 'completed' });
    expect(await f.store.receipt(item.id, firing.id)).toMatchObject({
      state: 'completed',
      runId: 'mock-late-run',
    });
    await f.store.tick();
    expect(attempts).toBe(1);
    expect((await f.store.notices())[0].reason).toBe('recovered');
  } finally {
    await f.close();
  }
});

test.each(['all', 'changes'] as const)(
  'original completed receipts clear %s-mode unknown state without replay',
  async (kind) => {
    const f = await fixture();
    let attempts = 0;
    Object.assign(f.options.runner, {
      start: async () => {
        attempts++;
        throw new Error('synthetic acknowledgement lost');
      },
      signal: async () => Buffer.from('Synthetic result'),
    });
    try {
      let item = await f.store.create(input(rule));
      if (kind === 'changes')
        item = await f.store.monitor(item.id, item.revision, { kind, signalPath: 'mock.txt' });
      const firing = await f.store.run(item.id, 'mock-original-receipt');
      await f.store.tick();
      await f.reopen(kind === 'all');
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBe('SCHEDULE_OUTCOME_UNKNOWN');
      expect(
        (await f.store.notices()).some((notice) => notice.code === 'SCHEDULE_OUTCOME_UNKNOWN'),
      ).toBe(true);
      expect(attempts).toBe(1);
      f.receipts.set(firing.requestId, { runId: 'mock-confirmed-run', phase: 'completed' });
      expect(await f.store.receipt(item.id, firing.id)).toMatchObject({
        state: 'completed',
        runId: 'mock-confirmed-run',
      });
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBeUndefined();
      expect((await f.store.get(item.id)).history[0].state).toBe('completed');
      const notice = (await f.store.notices())[0];
      expect(notice.reason).toBe('recovered');
      await f.reopen();
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBeUndefined();
      expect((await f.store.notices())[0].id).toBe(notice.id);
      expect(attempts).toBe(1);
    } finally {
      await f.close();
    }
  },
);

test('an all-mode failed original receipt reports failure rather than recovery and later success clears it', async () => {
  const f = await fixture();
  let attempts = 0;
  Object.assign(f.options.runner, {
    start: async () => {
      attempts++;
      throw new Error('synthetic acknowledgement lost');
    },
  });
  try {
    const item = await f.store.create(input(rule));
    const firing = await f.store.run(item.id, 'mock-failed-original');
    await f.store.tick();
    f.receipts.set(firing.requestId, {
      runId: 'mock-failed-run',
      phase: 'failed',
      error: 'AUTOMATION_RUN_FAILED',
    });
    expect(await f.store.receipt(item.id, firing.id)).toMatchObject({ state: 'failed' });
    await f.store.tick();
    expect((await f.store.get(item.id)).automation?.error).toBe('AUTOMATION_RUN_FAILED');
    expect((await f.store.notices())[0]).toMatchObject({
      reason: 'fault',
      phase: 'failed',
      code: 'AUTOMATION_RUN_FAILED',
    });
    await f.reopen();
    await f.store.tick();
    expect(attempts).toBe(1);
    Object.assign(f.options.runner, {
      start: async (_bot: string, task: { requestId: string }) => {
        attempts++;
        f.receipts.set(task.requestId, { runId: 'mock-next-run', phase: 'completed' });
      },
    });
    await f.store.run(item.id, 'mock-next-result');
    await f.store.tick();
    expect((await f.store.get(item.id)).automation?.error).toBeUndefined();
    expect((await f.store.notices())[0].reason).toBe('recovered');
    expect(attempts).toBe(2);
  } finally {
    await f.close();
  }
});

test.each([
  { kind: 'all', backwards: false, failure: 'run' },
  { kind: 'all', backwards: true, failure: 'run' },
  { kind: 'changes', backwards: true, failure: 'run' },
  { kind: 'changes', backwards: false, failure: 'signal' },
] as const)(
  'an older completed receipt cannot clear a newer firing failure ($kind, backwards=$backwards, $failure)',
  async ({ kind, backwards, failure }) => {
    const f = await fixture();
    let starts = 0;
    Object.assign(f.options.runner, {
      start: async () => {
        starts++;
        throw new Error('Synthetic old acknowledgement lost');
      },
      signal: async (_bot: string, run: string) => {
        if (run === 'mock-newer-run' && failure === 'signal')
          throw new Error('Synthetic missing signal');
        return Buffer.from('Synthetic result');
      },
    });
    try {
      let item = await f.store.create(input(rule));
      if (kind === 'changes')
        item = await f.store.monitor(item.id, item.revision, { kind, signalPath: 'mock.txt' });
      const older = await f.store.run(item.id, 'mock-older-firing');
      await f.store.tick();
      await f.reopen();
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBe('SCHEDULE_OUTCOME_UNKNOWN');
      if (backwards) f.setTime(Date.parse('2025-12-31T23:59:00Z'));
      Object.assign(f.options.runner, {
        start: async (_bot: string, task: { requestId: string }) => {
          starts++;
          f.receipts.set(task.requestId, {
            runId: 'mock-newer-run',
            phase: failure === 'run' ? 'failed' : 'completed',
            ...(failure === 'run' ? { error: 'AUTOMATION_RUN_FAILED' } : {}),
          });
        },
      });
      const newer = await f.store.run(item.id, 'mock-newer-firing');
      await f.store.tick();
      const code = failure === 'run' ? 'AUTOMATION_RUN_FAILED' : 'AUTOMATION_SIGNAL_UNAVAILABLE';
      expect((await f.store.receipt(item.id, newer.id)).state).toBe(
        failure === 'run' ? 'failed' : 'completed',
      );
      expect((await f.store.get(item.id)).automation?.error).toBe(code);
      const fault = (await f.store.notices()).find((notice) => notice.runId === 'mock-newer-run');
      expect.assert(fault);
      expect(fault).toMatchObject({
        reason: 'fault',
        code,
        runId: 'mock-newer-run',
      });
      await f.reopen(kind === 'all' && !backwards);
      f.receipts.set(older.requestId, { runId: 'mock-older-run', phase: 'completed' });
      expect(await f.store.receipt(item.id, older.id)).toMatchObject({
        id: older.id,
        requestId: older.requestId,
        state: 'completed',
        source: older.source,
      });
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBe(code);
      expect(await f.store.notices()).toEqual([fault]);
      await f.reopen();
      await f.store.receipt(item.id, older.id);
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBe(code);
      expect(await f.store.notices()).toEqual([fault]);
      expect(starts).toBe(2);
      Object.assign(f.options.runner, {
        start: async (_bot: string, task: { requestId: string }) => {
          starts++;
          f.receipts.set(task.requestId, { runId: 'mock-latest-run', phase: 'completed' });
        },
      });
      await f.store.run(item.id, 'mock-latest-firing');
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBeUndefined();
      const recovered = (await f.store.notices())[0];
      expect(recovered).toMatchObject({ reason: 'recovered', runId: 'mock-latest-run' });
      await f.store.tick();
      expect(await f.store.notices()).toEqual([recovered]);
      expect(starts).toBe(3);
    } finally {
      await f.close();
    }
  },
);

test('a late manual receipt preserves a newer file-event fault and its event identity', async () => {
  const f = await fixture();
  const sources: unknown[] = [];
  let starts = 0;
  Object.assign(f.options.runner, {
    start: async () => {
      starts++;
      throw new Error('Synthetic old acknowledgement lost');
    },
  });
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    const older = await f.store.run(item.id, 'mock-old-manual');
    await f.store.tick();
    Object.assign(f.options.runner, {
      start: async (
        _bot: string,
        task: { requestId: string },
        _conversation?: undefined,
        source?: unknown,
      ) => {
        starts++;
        sources.push(source);
        f.receipts.set(task.requestId, {
          runId: 'mock-file-run',
          phase: 'failed',
          error: 'AUTOMATION_RUN_FAILED',
        });
      },
    });
    f.setBytes('B');
    await f.poll();
    await f.poll();
    const newer = (await f.store.get(item.id)).history.find(
      (entry) => entry.source?.trigger === 'file',
    );
    expect.assert(newer);
    expect(sources).toEqual([newer.source]);
    expect(newer.source).toMatchObject({ firingId: newer.id, fromCursor: 1, toCursor: 1 });
    const fault = (await f.store.notices()).find((notice) => notice.runId === 'mock-file-run');
    expect.assert(fault);
    await f.reopen();
    f.receipts.set(older.requestId, { runId: 'mock-late-manual-run', phase: 'completed' });
    await f.store.receipt(item.id, older.id);
    await f.store.tick();
    expect((await f.store.get(item.id)).automation).toMatchObject({
      error: 'AUTOMATION_RUN_FAILED',
      cursor: 1,
    });
    expect(await f.store.receipt(item.id, newer.id)).toMatchObject({
      state: 'failed',
      source: newer.source,
      requestId: newer.requestId,
    });
    expect(await f.store.notices()).toEqual([fault]);
    expect(starts).toBe(2);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  'a late original receipt cannot recover a capability fault (restored before receipt=%s)',
  async (restored) => {
    const f = await fixture();
    let available = true;
    let starts = 0;
    Object.assign(f.options.runner, {
      monitoringAvailable: () => available,
      start: async () => {
        starts++;
        throw new Error('Synthetic old acknowledgement lost');
      },
      signal: async () => Buffer.from('Synthetic signal'),
    });
    try {
      let item = await f.store.create(input({ kind: 'every', everySeconds: 60 }));
      item = await f.store.monitor(item.id, item.revision, {
        kind: 'changes',
        signalPath: 'mock.txt',
      });
      const older = await f.store.run(item.id, 'mock-before-capability-fault');
      await f.store.tick();
      item = await f.store.update(item.id, item.revision, { enabled: true });
      available = false;
      await f.store.tick();
      const fault = (await f.store.notices()).find(
        (notice) => notice.code === 'AUTOMATION_MONITOR_UNAVAILABLE',
      );
      expect.assert(fault);
      if (restored) await f.reopen(true);
      available = restored;
      f.receipts.set(older.requestId, { runId: 'mock-late-known-run', phase: 'completed' });
      expect((await f.store.receipt(item.id, older.id)).state).toBe('completed');
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBe('AUTOMATION_MONITOR_UNAVAILABLE');
      expect(await f.store.notices()).toEqual([fault]);
      expect(starts).toBe(1);
      await f.store.ack(item.id, fault.id);
      await f.reopen();
      await f.store.receipt(item.id, older.id);
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBe('AUTOMATION_MONITOR_UNAVAILABLE');
      expect(await f.store.notices()).toHaveLength(0);
      available = true;
      Object.assign(f.options.runner, {
        start: async (_bot: string, task: { requestId: string }) => {
          starts++;
          f.receipts.set(task.requestId, {
            runId: 'mock-after-capability-recovery',
            phase: 'completed',
          });
        },
      });
      await f.store.run(item.id, 'mock-after-capability-recovery');
      await f.store.tick();
      expect((await f.store.get(item.id)).automation?.error).toBeUndefined();
      expect((await f.store.notices())[0].reason).toBe('recovered');
      expect(starts).toBe(2);
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  'a newer unknown firing keeps result ownership while its original completed signal is in flight (old schema=%s)',
  async (beforeFloor) => {
    const f = await fixture();
    let release!: () => unknown;
    let entered!: () => unknown;
    const waiting = new Promise<Uint8Array>((resolve) => {
      release = () => resolve(Buffer.from('Synthetic newer signal'));
    });
    const reading = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    let starts = 0;
    let work: Promise<unknown> | undefined;
    Object.assign(f.options.runner, {
      start: async () => {
        starts++;
        throw new Error('Synthetic acknowledgement lost');
      },
      signal: async (_bot: string, run: string) => {
        if (run === 'mock-newer-original') {
          entered();
          return waiting;
        }
        return Buffer.from('Synthetic older signal');
      },
    });
    try {
      let item = await f.store.create(input(rule));
      item = await f.store.monitor(item.id, item.revision, {
        kind: 'changes',
        signalPath: 'mock.txt',
      });
      const older = await f.store.run(item.id, 'mock-older-unknown');
      await f.store.tick();
      const newer = await f.store.run(item.id, 'mock-newer-unknown');
      await f.store.tick();
      f.receipts.set(newer.requestId, { runId: 'mock-newer-original', phase: 'completed' });
      await f.store.receipt(item.id, newer.id);
      f.receipts.set(older.requestId, { runId: 'mock-older-original', phase: 'completed' });
      await f.store.receipt(item.id, older.id);
      if (beforeFloor) await f.reopen(true);
      work = f.store.tick();
      await reading;
      expect((await f.store.get(item.id)).automation?.error).toBe('SCHEDULE_OUTCOME_UNKNOWN');
      expect((await f.store.notices()).some((notice) => notice.reason === 'recovered')).toBe(false);
      release();
      await work;
      expect((await f.store.get(item.id)).automation?.error).toBeUndefined();
      const recovered = (await f.store.notices())[0];
      expect(recovered).toMatchObject({ reason: 'recovered', runId: 'mock-newer-original' });
      await f.reopen();
      await f.store.tick();
      expect(await f.store.notices()).toEqual([recovered]);
      expect(starts).toBe(2);
    } finally {
      release();
      await work;
      await f.close();
    }
  },
);

test('result comparisons use persisted firing order when the clock moves backwards between accepted runs', async () => {
  const f = await fixture();
  let starts = 0;
  Object.assign(f.options.runner, {
    start: async (_bot: string, task: { requestId: string }) => {
      starts++;
      f.receipts.set(task.requestId, {
        runId: starts === 1 ? 'mock-first-result' : 'mock-second-result',
        phase: starts === 1 ? 'running' : 'completed',
      });
    },
    signal: async (_bot: string, run: string) => Buffer.from(run),
  });
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'mock.txt',
    });
    const first = await f.store.run(item.id, 'mock-first-accepted');
    await f.store.tick();
    f.receipts.set(first.requestId, { runId: 'mock-first-result', phase: 'completed' });
    f.setTime(Date.parse('2025-12-31T23:59:00Z'));
    const second = await f.store.run(item.id, 'mock-second-accepted');
    await f.store.tick();
    expect(await f.store.receipt(item.id, first.id)).toMatchObject({ monitor: 'baseline' });
    expect(await f.store.receipt(item.id, second.id)).toMatchObject({ monitor: 'changed' });
    expect((await f.store.notices())[0]).toMatchObject({
      reason: 'changed',
      runId: 'mock-second-result',
    });
    expect(starts).toBe(2);
  } finally {
    await f.close();
  }
});

test('a late receipt from an old configuration cannot alter the current configuration fault', async () => {
  const f = await fixture();
  let starts = 0;
  Object.assign(f.options.runner, {
    start: async () => {
      starts++;
      throw new Error('Synthetic acknowledgement lost');
    },
  });
  try {
    let item = await f.store.create(input(rule));
    const older = await f.store.run(item.id, 'mock-old-configuration');
    await f.store.tick();
    item = await f.store.update(item.id, item.revision, { prompt: 'Synthetic revised task' });
    const newer = await f.store.run(item.id, 'mock-current-configuration');
    await f.store.tick();
    f.receipts.set(newer.requestId, {
      runId: 'mock-current-failure',
      phase: 'failed',
      error: 'AUTOMATION_RUN_FAILED',
    });
    await f.store.receipt(item.id, newer.id);
    await f.store.tick();
    const fault = (await f.store.notices()).find(
      (notice) => notice.runId === 'mock-current-failure',
    );
    expect.assert(fault);
    expect(newer.source?.configRevision).toBe((older.source?.configRevision ?? 0) + 1);
    f.receipts.set(older.requestId, { runId: 'mock-old-success', phase: 'completed' });
    await f.store.receipt(item.id, older.id);
    await f.store.tick();
    expect((await f.store.get(item.id)).automation?.error).toBe('AUTOMATION_RUN_FAILED');
    expect(await f.store.notices()).toEqual([fault]);
    expect(starts).toBe(2);
  } finally {
    await f.close();
  }
});

test('a late receipt preserves a newer observation fault without reporting false recovery', async () => {
  const f = await fixture();
  let starts = 0;
  Object.assign(f.options.runner, {
    start: async () => {
      starts++;
      throw new Error('Synthetic acknowledgement lost');
    },
  });
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    const older = await f.store.run(item.id, 'mock-before-observation-fault');
    await f.store.tick();
    f.revoke();
    await f.poll();
    const fault = (await f.store.notices()).find(
      (notice) => notice.code === 'PROJECT_ACCESS_DENIED',
    );
    expect.assert(fault);
    f.receipts.set(older.requestId, { runId: 'mock-late-before-revocation', phase: 'completed' });
    await f.store.receipt(item.id, older.id);
    await f.store.tick();
    expect((await f.store.get(item.id)).automation?.error).toBe('PROJECT_ACCESS_DENIED');
    expect(await f.store.notices()).toEqual([fault]);
    expect(starts).toBe(1);
  } finally {
    await f.close();
  }
});

test('a paused or edited rule rejects an observation that finishes late; locking does not cancel it', async () => {
  const f = await fixture();
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    let release!: () => unknown;
    let entered!: () => unknown;
    const waiting = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    const started = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    Object.assign(f.options.observation, {
      read: async () => {
        entered();
        await waiting;
        return Buffer.from('B');
      },
    });
    const polling = f.poll();
    await started;
    const locked = await f.store.update(item.id, item.revision, { locked: true });
    expect(locked.automation?.configRevision).toBe(item.automation?.configRevision);
    await f.store.update(item.id, locked.revision, { prompt: 'New synthetic scope' });
    release();
    await polling;
    const current = await f.store.get(item.id);
    expect(current.enabled).toBe(false);
    expect(current.automation?.initialized).toBe(false);
    expect(current.automation?.cursor).toBe(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a stable file event can merge into an unclaimed manual run without losing its cursor or request identity', async () => {
  const f = await fixture();
  try {
    const created = await f.store.create(input(rule));
    await f.store.update(created.id, created.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.busy.add(created.bot);
    const manual = await f.store.run(created.id, 'mock-manual-pending');
    f.setBytes('B');
    await f.poll();
    await f.poll();
    f.busy.clear();
    await f.store.tick();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].task.requestId).toBe(manual.requestId);
    expect(f.calls[0].source).toMatchObject({ trigger: 'file', fromCursor: 1, toCursor: 1 });
  } finally {
    await f.close();
  }
});

test('path ordering is canonical and cannot reset an accepted baseline or configuration revision', async () => {
  const f = await fixture();
  try {
    let item = await f.store.create(input({ ...rule, paths: ['b.txt', 'a.txt'] }));
    item = await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    const before = await f.store.get(item.id);
    const after = await f.store.update(item.id, before.revision, {
      rule: { ...rule, kind: 'file', paths: ['b.txt', 'a.txt'] },
    });
    expect(after.revision).toBe(before.revision);
    expect(after.automation).toStrictEqual(before.automation);
    expect(after.enabled).toBe(true);
  } finally {
    await f.close();
  }
});

test('permission is rechecked at claim even when the next file poll is not due', async () => {
  const f = await fixture();
  try {
    const item = await f.store.create(input(rule));
    await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.busy.add(item.bot);
    f.setBytes('B');
    await f.poll();
    await f.poll();
    expect((await f.store.get(item.id)).history[0].state).toBe('pending');
    f.revoke();
    f.busy.clear();
    await f.store.tick();
    expect(f.calls).toHaveLength(0);
    expect((await f.store.get(item.id)).history[0].state).toBe('cancelled');
    expect((await f.store.get(item.id)).enabled).toBe(false);
  } finally {
    await f.close();
  }
});

test('binary sampling distinguishes absent files, enforces whole-file bounds, and never reads after scope denial', async () => {
  const trigger = { ...rule, kind: 'file' as const };
  const signal = new AbortController().signal;
  const absent = await sampleFiles(
    { authorize: () => {}, read: async () => null },
    'mock-bot',
    trigger,
    signal,
  );
  const empty = await sampleFiles(
    { authorize: () => {}, read: async () => Buffer.alloc(0) },
    'mock-bot',
    trigger,
    signal,
  );
  expect(absent).not.toBe(empty);
  for (const [size, paths] of [
    [1024 * 1024 + 1, ['mock.bin']],
    [1024 * 1024, ['a', 'b', 'c', 'd', 'e']],
  ] as const)
    await expect(
      sampleFiles(
        { authorize: () => {}, read: async () => Buffer.alloc(size) },
        'mock-bot',
        { ...trigger, paths: [...paths] },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'AUTOMATION_FILES_TOO_LARGE' });
  let reads = 0;
  await expect(
    sampleFiles(
      {
        authorize: () => {
          throw Object.assign(new Error('denied'), { code: 'PROJECT_SCOPE_STALE' });
        },
        read: async () => {
          reads++;
          return Buffer.from('private synthetic');
        },
      },
      'mock-bot',
      trigger,
      signal,
    ),
  ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_STALE' });
  expect(reads).toBe(0);
  expect(() => signalDigest(Buffer.alloc(64 * 1024 + 1))).toThrow('AUTOMATION_SIGNAL_UNAVAILABLE');
  expect(signalDigest(Buffer.from('value \r\n'))).not.toBe(signalDigest(Buffer.from('value\n')));
});

test('a recovered file read cannot announce recovery while the result signal is still unavailable', async () => {
  const f = await fixture();
  Object.assign(f.options.runner, { signal: async () => Buffer.from([0xff]) });
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'mock.txt',
    });
    await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.setBytes('B');
    await f.poll();
    await f.poll();
    expect((await f.store.notices())[0].reason).toBe('fault');
    Object.assign(f.options.observation, {
      read: async () => {
        throw new Error('synthetic read unavailable');
      },
    });
    await f.poll();
    Object.assign(f.options.observation, { read: async () => Buffer.from('B') });
    await f.poll();
    expect((await f.store.get(item.id)).automation?.error).toBe('AUTOMATION_SIGNAL_UNAVAILABLE');
    expect((await f.store.notices())[0].reason).toBe('fault');
  } finally {
    await f.close();
  }
});

test('unknown receipts remain actionable after rule deletion and acknowledgement never changes the execution outcome', async () => {
  const f = await fixture();
  let attempts = 0;
  Object.assign(f.options.runner, {
    start: async () => {
      attempts++;
      throw new Error('synthetic lost acknowledgement');
    },
  });
  try {
    const item = await f.store.create({
      ...input({ kind: 'every', everySeconds: 60 }),
      enabled: false,
    });
    const firing = await f.store.run(item.id, 'mock-unknown-after-delete');
    await f.store.tick();
    const notices = await f.store.notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'SCHEDULE_OUTCOME_UNKNOWN', firing: firing.id });
    await f.store.remove(item.id, item.revision);
    await f.reopen();
    expect((await f.store.notices())[0].id).toBe(notices[0].id);
    expect(await f.store.receipt(item.id, firing.id)).toMatchObject({ state: 'interrupted' });
    await f.store.ack(item.id, notices[0].id);
    expect(await f.store.notices()).toHaveLength(0);
    expect(await f.store.receipt(item.id, firing.id)).toMatchObject({ state: 'interrupted' });
    await f.store.tick();
    expect(attempts).toBe(1);
    f.receipts.set(firing.requestId, {
      runId: 'mock-completed-after-deletion',
      phase: 'completed',
    });
    expect(await f.store.receipt(item.id, firing.id)).toMatchObject({
      id: firing.id,
      requestId: firing.requestId,
      state: 'completed',
      runId: 'mock-completed-after-deletion',
    });
    await f.reopen();
    await f.store.tick();
    expect(await f.store.notices()).toHaveLength(0);
    expect(attempts).toBe(1);
  } finally {
    await f.close();
  }
});

test('partial writes need distinct matching polls and claimed input stays frozen while later events coalesce', async () => {
  const f = await fixture();
  const start = f.options.runner.start;
  Object.assign(f.options.runner, {
    start: async (
      bot: string,
      task: { requestId: string; prompt: string },
      conversation?: undefined,
      source?: unknown,
    ) => {
      await start(bot, task, conversation, source);
      f.receipts.get(task.requestId)!.phase = 'running';
      f.busy.add(bot);
    },
  });
  try {
    const item = await f.store.create(input(rule));
    await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.setBytes('partial');
    await f.poll();
    await Promise.all([f.store.tick(), f.store.tick()]);
    expect(f.calls).toHaveLength(0);
    f.setBytes('complete');
    await f.poll();
    expect(f.calls).toHaveLength(0);
    await f.poll();
    expect(f.calls).toHaveLength(1);
    const accepted = structuredClone(f.calls[0]);
    for (const value of ['D', 'E']) {
      f.setBytes(value);
      await f.poll();
      await f.poll();
    }
    expect(f.calls[0]).toStrictEqual(accepted);
    expect(
      (await f.store.get(item.id)).history.filter((entry) => entry.state === 'pending'),
    ).toHaveLength(1);
    f.receipts.get(accepted.task.requestId)!.phase = 'completed';
    f.busy.clear();
    await f.store.tick();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].source).toMatchObject({ fromCursor: 2, toCursor: 3 });
    expect(f.calls[0]).toStrictEqual(accepted);
  } finally {
    await f.close();
  }
});

test('a polling pass bounds concurrent project file IO instead of multiplying per-rule buffers without limit', async () => {
  const f = await fixture();
  let active = 0,
    peak = 0;
  Object.assign(f.options.observation, {
    read: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(setImmediate);
      active--;
      return Buffer.from('A');
    },
  });
  try {
    for (let index = 0; index < 6; index++) {
      const item = await f.store.create({ ...input(rule), id: `mock-file-${index}` });
      await f.store.update(item.id, item.revision, { enabled: true });
    }
    await f.poll();
    expect(peak).toBeLessThanOrEqual(4);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('locking is still a pure edit-protection operation when admission or source access has become unavailable', async () => {
  const f = await fixture();
  try {
    let item = await f.store.create(input(rule));
    item = await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.busy.add(item.bot);
    f.setBytes('B');
    await f.poll();
    await f.poll();
    const before = await f.store.get(item.id);
    f.revoke();
    Object.assign(f.options.runner, { admit: () => false });
    const locked = await f.store.update(item.id, before.revision, { locked: true });
    expect(locked.locked).toBe(true);
    expect(locked.automation).toStrictEqual(before.automation);
    expect(locked.history[0].state).toBe('pending');
    await f.store.tick();
    expect(f.calls).toHaveLength(0);
    await f.poll();
    expect((await f.store.get(item.id)).enabled).toBe(false);
    expect((await f.store.get(item.id)).locked).toBe(true);
  } finally {
    await f.close();
  }
});

test('renaming a monitored rule while resaving unchanged instructions cannot consume its pending event', async () => {
  const f = await fixture();
  try {
    const item = await f.store.create(input(rule));
    await f.store.update(item.id, item.revision, { enabled: true });
    await f.poll();
    await f.poll();
    f.busy.add(item.bot);
    f.setBytes('B');
    await f.poll();
    await f.poll();
    const before = await f.store.get(item.id);
    const renamed = await f.store.update(item.id, before.revision, {
      title: 'Synthetic renamed',
      prompt: before.prompt,
      rule: before.rule,
      enabled: true,
    });
    expect(renamed.automation).toStrictEqual(before.automation);
    expect(renamed.history[0].state).toBe('pending');
    expect(renamed.history[0].requestId).toBe(before.history[0].requestId);
    f.busy.clear();
    await f.store.tick();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('ordinary all-policy saves and reordered equivalent policies do not pause or reset schedules', async () => {
  const f = await fixture();
  try {
    const item = await f.store.create({
      ...input({ kind: 'every', everySeconds: 60 }),
      enabled: true,
    });
    const ordinary = await f.store.monitor(item.id, item.revision, { kind: 'all' });
    expect(ordinary).toStrictEqual(item);
    const monitor = await f.store.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'mock.txt',
    });
    const same = await f.store.monitor(item.id, monitor.revision, {
      signalPath: 'mock.txt',
      kind: 'changes',
    });
    expect(same).toStrictEqual(monitor);
  } finally {
    await f.close();
  }
});

test('an executor capability downgrade pauses changes monitoring before model dispatch and requires explicit reenable', async () => {
  const f = await fixture();
  let available = true;
  Object.assign(f.options.runner, {
    monitoringAvailable: () => available,
    signal: async () => Buffer.from('Synthetic result'),
  });
  try {
    let item = await f.store.create(input({ kind: 'every', everySeconds: 60 }));
    item = await f.store.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'mock.txt',
    });
    item = await f.store.update(item.id, item.revision, { enabled: true });
    available = false;
    await f.store.tick();
    const paused = await f.store.get(item.id);
    expect(paused.enabled).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect((await f.store.notices())[0].code).toBe('AUTOMATION_MONITOR_UNAVAILABLE');
    await expect(f.store.run(item.id, 'mock-unsupported')).rejects.toMatchObject({
      code: 'AUTOMATION_MONITOR_UNAVAILABLE',
    });
    available = true;
    await f.poll();
    expect(f.calls).toHaveLength(0);
    await f.store.update(item.id, paused.revision, { enabled: true });
    await f.poll();
    expect(f.calls).toHaveLength(1);
    expect((await f.store.notices())[0].reason).toBe('recovered');
  } finally {
    await f.close();
  }
});
