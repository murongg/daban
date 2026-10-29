import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBotLifecycleAck } from '@daban/protocol';
import { Fault } from './control.js';
import { BotLifecycle } from './lifecycle.js';
import { BotProfiles } from './profiles.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-bot-lifecycle-'));
  const profiles = new BotProfiles(root);
  for (const id of ['mock-a', 'mock-b'])
    await profiles.register({
      id,
      name: `合成 ${id}`,
      instructions: '',
      memory: 'SYNTHETIC-RETAINED-MEMORY',
      color: 'mint',
    });
  const busy = new Set<string>();
  const connected = new Set<string>();
  const queued = new Set<string>();
  const suspended: string[] = [];
  let failure = false;
  const options = {
    profiles,
    running: (bot: string) => busy.has(bot),
    assertIdle: async (bot: string) => {
      if (busy.has(bot)) throw new Fault('BOT_TASK_RUNNING');
      if (connected.has(bot)) throw new Fault('BOT_COMPUTER_CONNECTED');
      if (queued.has(bot)) throw new Fault('BOT_GROUP_PENDING');
    },
    suspendSchedules: async (bot: string) => {
      suspended.push(bot);
      if (failure) throw new Error('synthetic cleanup failure');
    },
  };
  const lifecycle = new BotLifecycle(options);
  return {
    root,
    profiles,
    lifecycle,
    options,
    busy,
    connected,
    queued,
    suspended,
    fail: (value: boolean) => {
      failure = value;
    },
    close: async () => {
      await lifecycle.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const archive = { id: 'mock-archive-a', bot: 'mock-a', action: 'archive' as const, revision: 1 };

test('an already-running Bot is rejected without transiently fencing its ongoing profile tools', async () => {
  const f = await fixture();
  try {
    f.busy.add(archive.bot);
    const operation = assert.rejects(f.lifecycle.operate(archive), { code: 'BOT_TASK_RUNNING' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.profiles.admit(archive.bot), true);
    await operation;
    assert.equal(f.suspended.length, 0);
  } finally {
    await f.close();
  }
});

test('archive preflights live work, preserves profiles and returns exact read-only receipts on retry', async () => {
  const f = await fixture();
  try {
    for (const [set, code] of [
      [f.busy, 'BOT_TASK_RUNNING'],
      [f.connected, 'BOT_COMPUTER_CONNECTED'],
      [f.queued, 'BOT_GROUP_PENDING'],
    ] as const) {
      set.add(archive.bot);
      await assert.rejects(f.lifecycle.operate(archive), { code });
      set.clear();
      assert.equal((await f.profiles.get(archive.bot))?.archived, undefined);
    }
    assert.equal(f.suspended.length, 0);
    const result = await f.lifecycle.operate(archive);
    assert.ok(isBotLifecycleAck(result));
    assert.equal(result.receipt.phase, 'complete');
    assert.equal(result.profile.archived, true);
    assert.equal(result.profile.memory, 'SYNTHETIC-RETAINED-MEMORY');
    const bytes = await readFile(path.join(f.root, 'mock-a.json'));
    f.busy.add(archive.bot);
    assert.deepEqual(await f.lifecycle.operate(archive), result);
    assert.deepEqual(await f.lifecycle.receipt(archive.bot, archive.id), result);
    assert.deepEqual(await readFile(path.join(f.root, 'mock-a.json')), bytes);
    assert.equal(f.suspended.length, 1);
    await assert.rejects(f.lifecycle.receipt('mock-b', archive.id), {
      code: 'BOT_LIFECYCLE_NOT_FOUND',
    });
    await assert.rejects(f.lifecycle.operate({ ...archive, action: 'restore' }), {
      code: 'BOT_REQUEST_ID_REUSED',
    });
    f.busy.clear();
    const restored = await f.lifecycle.operate({
      id: 'mock-restore-a',
      bot: archive.bot,
      action: 'restore',
      revision: result.profile.revision,
    });
    assert.equal(restored.profile.archived, false);
    assert.equal(f.suspended.length, 1);
    assert.equal(f.profiles.admit(archive.bot), true);
    await assert.rejects(f.lifecycle.operate(archive), { code: 'BOT_PROFILE_CONFLICT' });
    assert.equal((await f.profiles.get('mock-b'))?.revision, 1);
  } finally {
    await f.close();
  }
});

test('accepted archive remains fenced after cleanup failure and is resumed idempotently after restart', async () => {
  const f = await fixture();
  let reopened: BotLifecycle | undefined;
  try {
    f.fail(true);
    await assert.rejects(f.lifecycle.operate(archive), { code: 'BOT_ARCHIVE_INCOMPLETE' });
    const pending = await f.lifecycle.receipt(archive.bot, archive.id);
    assert.ok(isBotLifecycleAck(pending));
    assert.equal(pending.profile.archived, true);
    assert.equal(pending.receipt.phase, 'pending');
    assert.equal(pending.receipt.error, 'BOT_ARCHIVE_INCOMPLETE');
    assert.equal(f.profiles.admit(archive.bot), false);
    await assert.rejects(
      f.lifecycle.operate({
        id: 'mock-premature-restore',
        bot: archive.bot,
        action: 'restore',
        revision: pending.profile.revision,
      }),
      { code: 'BOT_RESTORE_NOT_READY' },
    );
    await f.lifecycle.close();
    f.fail(false);
    const profiles = new BotProfiles(f.root);
    reopened = new BotLifecycle({ ...f.options, profiles });
    await reopened.recover();
    const receipt = await reopened.receipt(archive.bot, archive.id);
    assert.equal(receipt.receipt.phase, 'complete');
    assert.equal(receipt.profile.revision, 3);
    assert.equal(profiles.admit(archive.bot), false);
    assert.equal((await profiles.get('mock-b'))?.memory, 'SYNTHETIC-RETAINED-MEMORY');
    const effects = f.suspended.length;
    await reopened.recover();
    assert.equal(f.suspended.length, effects);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('concurrent exact archive retries share work; another identity and a later operation keep their own authority', async () => {
  const f = await fixture();
  let release!: () => unknown;
  let entered!: () => unknown;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const start = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  f.options.assertIdle = async (bot: string) => {
    if (bot === archive.bot) {
      entered();
      await gate;
    }
  };
  try {
    const first = f.lifecycle.operate(archive);
    await start;
    assert.equal(f.profiles.admit(archive.bot), false);
    const retry = f.lifecycle.operate(archive);
    await assert.rejects(f.lifecycle.operate({ ...archive, id: 'mock-different-operation' }), {
      code: 'BOT_CHANGING',
    });
    const other = await f.lifecycle.operate({
      id: 'mock-archive-b',
      bot: 'mock-b',
      action: 'archive',
      revision: 1,
    });
    assert.equal(other.profile.archived, true);
    release();
    assert.deepEqual(await first, await retry);
    assert.equal(f.suspended.filter((bot) => bot === archive.bot).length, 1);
    const valid = await f.lifecycle.receipt(archive.bot, archive.id);
    assert.equal(
      isBotLifecycleAck({ ...valid, receipt: { ...valid.receipt, bot: 'mock-b' } }),
      false,
    );
    assert.equal(isBotLifecycleAck({ ...valid, path: '/synthetic/private' }), false);
  } finally {
    release();
    await f.close();
  }
});

test('shutdown before accepting intent releases admission without changing the profile', async () => {
  const f = await fixture();
  let release!: () => unknown;
  let entered!: () => unknown;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const start = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  f.options.assertIdle = async () => {
    entered();
    await gate;
  };
  const operation = f.lifecycle.operate(archive);
  try {
    await start;
    const closing = f.lifecycle.close();
    release();
    await assert.rejects(operation, { code: 'BOT_LIFECYCLE_CLOSED' });
    await closing;
    assert.equal((await f.profiles.get(archive.bot))?.archived, undefined);
    assert.equal(f.profiles.admit(archive.bot), true);
    assert.equal(f.suspended.length, 0);
  } finally {
    release();
    await f.close();
  }
});

test('shutdown drains an accepted archive before its dependent stores may close', async () => {
  const f = await fixture();
  let release!: () => unknown;
  let entered!: () => unknown;
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const start = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  f.options.suspendSchedules = async () => {
    entered();
    await gate;
  };
  const operation = f.lifecycle.operate(archive);
  try {
    await start;
    let closed = false;
    const closing = f.lifecycle.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(closed, false);
    assert.equal((await f.lifecycle.receipt(archive.bot, archive.id)).receipt.phase, 'pending');
    release();
    assert.equal((await operation).receipt.phase, 'complete');
    await closing;
    assert.equal(closed, true);
    assert.equal(f.profiles.admit(archive.bot), false);
  } finally {
    release();
    await f.close();
  }
});
