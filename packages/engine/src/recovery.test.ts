import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RecoveryScreen } from '@daban/protocol';
import { expect, test } from 'vitest';
import { Recovery } from './recovery.js';

async function fixture(quiesce: () => Promise<unknown> = async () => undefined) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mock-runtime-recovery-'));
  const state = {
    computersRevision: 0,
    screens: [] as RecoveryScreen[],
    running: [] as string[],
    changing: false,
  };
  const file = path.join(dir, 'recovery.json');
  const owner = new Recovery(
    Object.assign(
      {
        file,
        boot: 'mock-boot-one',
        instance: 'mock-runtime-one',
        snapshot: () => structuredClone(state),
      },
      { quiesce },
    ),
  );
  await owner.ready;
  return { dir, file, state, owner };
}
test('claim waits for accepted queue preparation to drain before issuing its durable host permission', async () => {
  let release: () => unknown = () => undefined,
    entered: () => unknown = () => undefined;
  const started = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const waiting = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const f = await fixture(async () => {
    entered();
    await waiting;
  });
  try {
    const review = f.owner.review();
    const prepared = await f.owner.prepare({
      id: 'mock-draining',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    let settled = false;
    const claiming = f.owner.claim(prepared.id, prepared.revision).then((value) => {
      settled = true;
      return value;
    });
    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error('DRAIN_NOT_CALLED')), 100)),
    ]);
    expect(settled).toBe(false);
    expect(f.owner.receipt(prepared.id).phase).toBe('prepared');
    expect(f.owner.admit()).toBe(false);
    release();
    expect((await claiming).phase).toBe('claimed');
  } finally {
    release();
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('a drain timeout keeps the prepared fence cancellable and a late drain cannot grant a host permission', async () => {
  let release: () => unknown = () => undefined;
  const waiting = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const f = await fixture(async () => waiting);
  try {
    const review = f.owner.review();
    const prepared = await f.owner.prepare({
      id: 'mock-timeout',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    await expect(f.owner.claim(prepared.id, prepared.revision)).rejects.toMatchObject({
      code: 'RECOVERY_DRAIN_TIMEOUT',
    });
    expect(f.owner.receipt(prepared.id).phase).toBe('prepared');
    expect(f.owner.admit()).toBe(false);
    await f.owner.cancel(prepared.id, prepared.revision);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.owner.receipt(prepared.id).phase).toBe('cancelled');
    expect(f.owner.admit()).toBe(true);
  } finally {
    release();
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('a changed control/resource review cannot be claimed and an old prepared server can only cancel its intent', async () => {
  const f = await fixture();
  try {
    f.state.screens = [
      {
        computer: {
          bot: 'mock-human',
          revision: 1,
          phase: 'connected',
          desired: true,
          reserved: true,
          instance: 'mock-screen',
        },
        lease: { owner: 'human', epoch: 1 },
      },
    ];
    const review = f.owner.review();
    const value = await f.owner.prepare({
      id: 'mock-changed-review',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    f.state.screens[0].lease!.epoch++;
    await expect(f.owner.claim(value.id, value.revision)).rejects.toMatchObject({
      code: 'RECOVERY_REVIEW_CHANGED',
    });
    expect(f.owner.receipt(value.id).phase).toBe('prepared');
    await f.owner.close();
    const restarted = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: review.boot,
      instance: 'mock-new-server',
      snapshot: () => structuredClone(f.state),
    });
    await restarted.ready;
    expect(restarted.admit()).toBe(false);
    await expect(restarted.claim(value.id, value.revision)).rejects.toMatchObject({
      code: 'RECOVERY_REVIEW_CHANGED',
    });
    await restarted.cancel(value.id, value.revision);
    expect(restarted.admit()).toBe(true);
    await restarted.close();
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('a corrupt review digest is retained across a new boot rather than accepted as completion proof', async () => {
  const f = await fixture();
  try {
    const review = f.owner.review();
    const prepared = await f.owner.prepare({
      id: 'mock-corrupt-digest',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    await f.owner.claim(prepared.id, prepared.revision);
    await f.owner.close();
    const corrupt = JSON.parse(await readFile(f.file, 'utf8'));
    corrupt.receipt.review.digest = 'a'.repeat(64);
    const bytes = JSON.stringify(corrupt);
    await writeFile(f.file, bytes);
    const restarted = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: 'mock-new-boot',
      instance: 'mock-new-server',
      snapshot: () => structuredClone(f.state),
    });
    await restarted.ready;
    expect(restarted.admit()).toBe(false);
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
    await restarted.close();
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('busy work and stale reviews reject without fencing existing work; prepared intent is durable and gates new mutations', async () => {
  const f = await fixture();
  try {
    const first = f.owner.review();
    f.state.running = ['mock-task'];
    await expect(
      f.owner.prepare({
        id: 'mock-busy',
        revision: first.revision,
        review: first.digest,
        confirmation: 'restart-all-apps',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_TASKS_RUNNING' });
    expect(f.owner.admit()).toBe(true);
    f.state.running = [];
    const release = f.owner.enter();
    await expect(
      f.owner.prepare({
        id: 'mock-writing',
        revision: first.revision,
        review: first.digest,
        confirmation: 'restart-all-apps',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_CHANGES_RUNNING' });
    release();
    release();
    f.state.computersRevision++;
    await expect(
      f.owner.prepare({
        id: 'mock-stale',
        revision: first.revision,
        review: first.digest,
        confirmation: 'restart-all-apps',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_CHANGED' });
    const review = f.owner.review();
    const request = {
      id: 'mock-prepare',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    };
    const [a, b] = await Promise.all([
      f.owner.prepare(request),
      f.owner.prepare({
        confirmation: request.confirmation,
        review: request.review,
        revision: request.revision,
        id: request.id,
      }),
    ]);
    expect(a).toStrictEqual(b);
    expect(a.phase).toBe('prepared');
    expect(f.owner.admit()).toBe(false);
    expect(() => f.owner.enter()).toThrowError(
      expect.objectContaining({ code: 'RUNTIME_RECOVERY_PENDING' }),
    );
    expect(JSON.parse(await readFile(f.file, 'utf8')).receipt.id).toBe(request.id);
    expect(f.owner.receipt(request.id)).toStrictEqual(a);
    const cancelled = await f.owner.cancel(request.id, a.revision);
    expect(cancelled.phase).toBe('cancelled');
    expect(f.owner.admit()).toBe(true);
    expect(await f.owner.prepare(request)).toStrictEqual(cancelled);
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('claim and cancellation serialize, same-boot restart stays fenced, and only a new kernel boot proves completion', async () => {
  const f = await fixture();
  try {
    const review = f.owner.review();
    const prepared = await f.owner.prepare({
      id: 'mock-claim',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    const claimed = await f.owner.claim(prepared.id, prepared.revision);
    expect(claimed.phase).toBe('claimed');
    await expect(f.owner.cancel(prepared.id, claimed.revision)).rejects.toMatchObject({
      code: 'RECOVERY_ALREADY_CLAIMED',
    });
    expect(await f.owner.claim(prepared.id, prepared.revision)).toStrictEqual(claimed);
    await f.owner.close();
    const same = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: review.boot,
      instance: 'mock-runtime-two',
      snapshot: () => structuredClone(f.state),
    });
    await same.ready;
    expect(same.admit()).toBe(false);
    expect(same.receipt(prepared.id).phase).toBe('claimed');
    await same.close();
    const fresh = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: 'mock-boot-two',
      instance: 'mock-runtime-three',
      snapshot: () => structuredClone(f.state),
    });
    await fresh.ready;
    expect(fresh.admit()).toBe(true);
    expect(fresh.receipt(prepared.id).phase).toBe('complete');
    expect(fresh.receipt(prepared.id).boot).toBe('mock-boot-two');
    await fresh.close();
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('malformed recovery authority is retained and cannot silently admit work or overwrite the record', async () => {
  const f = await fixture();
  await f.owner.close();
  try {
    await writeFile(f.file, 'SYNTHETIC-CORRUPT-AUTHORITY');
    const corrupt = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: 'mock-boot-one',
      instance: 'mock-other-runtime',
      snapshot: () => structuredClone(f.state),
    });
    await corrupt.ready;
    expect(corrupt.admit()).toBe(false);
    expect(() => corrupt.review()).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_STORE_UNAVAILABLE' }),
    );
    expect(await readFile(f.file, 'utf8')).toBe('SYNTHETIC-CORRUPT-AUTHORITY');
    await corrupt.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
