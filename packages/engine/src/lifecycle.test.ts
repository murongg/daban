import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBotLifecycleAck } from '@daban/protocol';
import { expect, test } from 'vitest';
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
    const operation = expect(f.lifecycle.operate(archive)).rejects.toMatchObject({
      code: 'BOT_TASK_RUNNING',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.profiles.admit(archive.bot)).toBe(true);
    await operation;
    expect(f.suspended.length).toBe(0);
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
      await expect(f.lifecycle.operate(archive)).rejects.toMatchObject({ code });
      set.clear();
      expect((await f.profiles.get(archive.bot))?.archived).toBe(undefined);
    }
    expect(f.suspended.length).toBe(0);
    const result = await f.lifecycle.operate(archive);
    expect.assert(isBotLifecycleAck(result));
    expect(result.receipt.phase).toBe('complete');
    expect(result.profile.archived).toBe(true);
    expect(result.profile.memory).toBe('SYNTHETIC-RETAINED-MEMORY');
    const bytes = await readFile(path.join(f.root, 'mock-a.json'));
    f.busy.add(archive.bot);
    expect(await f.lifecycle.operate(archive)).toStrictEqual(result);
    expect(await f.lifecycle.receipt(archive.bot, archive.id)).toStrictEqual(result);
    expect(await readFile(path.join(f.root, 'mock-a.json'))).toStrictEqual(bytes);
    expect(f.suspended.length).toBe(1);
    await expect(f.lifecycle.receipt('mock-b', archive.id)).rejects.toMatchObject({
      code: 'BOT_LIFECYCLE_NOT_FOUND',
    });
    await expect(f.lifecycle.operate({ ...archive, action: 'restore' })).rejects.toMatchObject({
      code: 'BOT_REQUEST_ID_REUSED',
    });
    f.busy.clear();
    const restored = await f.lifecycle.operate({
      id: 'mock-restore-a',
      bot: archive.bot,
      action: 'restore',
      revision: result.profile.revision,
    });
    expect(restored.profile.archived).toBe(false);
    expect(f.suspended.length).toBe(1);
    expect(f.profiles.admit(archive.bot)).toBe(true);
    await expect(f.lifecycle.operate(archive)).rejects.toMatchObject({
      code: 'BOT_PROFILE_CONFLICT',
    });
    expect((await f.profiles.get('mock-b'))?.revision).toBe(1);
  } finally {
    await f.close();
  }
});

test('accepted archive remains fenced after cleanup failure and is resumed idempotently after restart', async () => {
  const f = await fixture();
  let reopened: BotLifecycle | undefined;
  try {
    f.fail(true);
    await expect(f.lifecycle.operate(archive)).rejects.toMatchObject({
      code: 'BOT_ARCHIVE_INCOMPLETE',
    });
    const pending = await f.lifecycle.receipt(archive.bot, archive.id);
    expect.assert(isBotLifecycleAck(pending));
    expect(pending.profile.archived).toBe(true);
    expect(pending.receipt.phase).toBe('pending');
    expect(pending.receipt.error).toBe('BOT_ARCHIVE_INCOMPLETE');
    expect(f.profiles.admit(archive.bot)).toBe(false);
    await expect(
      f.lifecycle.operate({
        id: 'mock-premature-restore',
        bot: archive.bot,
        action: 'restore',
        revision: pending.profile.revision,
      }),
    ).rejects.toMatchObject({ code: 'BOT_RESTORE_NOT_READY' });
    await f.lifecycle.close();
    f.fail(false);
    const profiles = new BotProfiles(f.root);
    reopened = new BotLifecycle({ ...f.options, profiles });
    await reopened.recover();
    const receipt = await reopened.receipt(archive.bot, archive.id);
    expect(receipt.receipt.phase).toBe('complete');
    expect(receipt.profile.revision).toBe(3);
    expect(profiles.admit(archive.bot)).toBe(false);
    expect((await profiles.get('mock-b'))?.memory).toBe('SYNTHETIC-RETAINED-MEMORY');
    const effects = f.suspended.length;
    await reopened.recover();
    expect(f.suspended.length).toBe(effects);
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
    expect(f.profiles.admit(archive.bot)).toBe(false);
    const retry = f.lifecycle.operate(archive);
    await expect(
      f.lifecycle.operate({ ...archive, id: 'mock-different-operation' }),
    ).rejects.toMatchObject({
      code: 'BOT_CHANGING',
    });
    const other = await f.lifecycle.operate({
      id: 'mock-archive-b',
      bot: 'mock-b',
      action: 'archive',
      revision: 1,
    });
    expect(other.profile.archived).toBe(true);
    release();
    expect(await first).toStrictEqual(await retry);
    expect(f.suspended.filter((bot) => bot === archive.bot).length).toBe(1);
    const valid = await f.lifecycle.receipt(archive.bot, archive.id);
    expect(isBotLifecycleAck({ ...valid, receipt: { ...valid.receipt, bot: 'mock-b' } })).toBe(
      false,
    );
    expect(isBotLifecycleAck({ ...valid, path: '/synthetic/private' })).toBe(false);
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
    await expect(operation).rejects.toMatchObject({ code: 'BOT_LIFECYCLE_CLOSED' });
    await closing;
    expect((await f.profiles.get(archive.bot))?.archived).toBe(undefined);
    expect(f.profiles.admit(archive.bot)).toBe(true);
    expect(f.suspended.length).toBe(0);
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
    expect(closed).toBe(false);
    expect((await f.lifecycle.receipt(archive.bot, archive.id)).receipt.phase).toBe('pending');
    release();
    expect((await operation).receipt.phase).toBe('complete');
    await closing;
    expect(closed).toBe(true);
    expect(f.profiles.admit(archive.bot)).toBe(false);
  } finally {
    release();
    await f.close();
  }
});
