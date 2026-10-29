import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RecoveryScreen } from '@daban/protocol';
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
    assert.equal(settled, false);
    assert.equal(f.owner.receipt(prepared.id).phase, 'prepared');
    assert.equal(f.owner.admit(), false);
    release();
    assert.equal((await claiming).phase, 'claimed');
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
    await assert.rejects(f.owner.claim(prepared.id, prepared.revision), {
      code: 'RECOVERY_DRAIN_TIMEOUT',
    });
    assert.equal(f.owner.receipt(prepared.id).phase, 'prepared');
    assert.equal(f.owner.admit(), false);
    await f.owner.cancel(prepared.id, prepared.revision);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.owner.receipt(prepared.id).phase, 'cancelled');
    assert.equal(f.owner.admit(), true);
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
    await assert.rejects(f.owner.claim(value.id, value.revision), {
      code: 'RECOVERY_REVIEW_CHANGED',
    });
    assert.equal(f.owner.receipt(value.id).phase, 'prepared');
    await f.owner.close();
    const restarted = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: review.boot,
      instance: 'mock-new-server',
      snapshot: () => structuredClone(f.state),
    });
    await restarted.ready;
    assert.equal(restarted.admit(), false);
    await assert.rejects(restarted.claim(value.id, value.revision), {
      code: 'RECOVERY_REVIEW_CHANGED',
    });
    await restarted.cancel(value.id, value.revision);
    assert.equal(restarted.admit(), true);
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
    assert.equal(restarted.admit(), false);
    assert.equal(await readFile(f.file, 'utf8'), bytes);
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
    await assert.rejects(
      f.owner.prepare({
        id: 'mock-busy',
        revision: first.revision,
        review: first.digest,
        confirmation: 'restart-all-apps',
      }),
      { code: 'RECOVERY_TASKS_RUNNING' },
    );
    assert.equal(f.owner.admit(), true);
    f.state.running = [];
    const release = f.owner.enter();
    await assert.rejects(
      f.owner.prepare({
        id: 'mock-writing',
        revision: first.revision,
        review: first.digest,
        confirmation: 'restart-all-apps',
      }),
      { code: 'RECOVERY_CHANGES_RUNNING' },
    );
    release();
    release();
    f.state.computersRevision++;
    await assert.rejects(
      f.owner.prepare({
        id: 'mock-stale',
        revision: first.revision,
        review: first.digest,
        confirmation: 'restart-all-apps',
      }),
      { code: 'RECOVERY_REVIEW_CHANGED' },
    );
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
    assert.deepEqual(a, b);
    assert.equal(a.phase, 'prepared');
    assert.equal(f.owner.admit(), false);
    assert.throws(() => f.owner.enter(), { code: 'RUNTIME_RECOVERY_PENDING' });
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).receipt.id, request.id);
    assert.deepEqual(f.owner.receipt(request.id), a);
    const cancelled = await f.owner.cancel(request.id, a.revision);
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(f.owner.admit(), true);
    assert.deepEqual(await f.owner.prepare(request), cancelled);
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
    assert.equal(claimed.phase, 'claimed');
    await assert.rejects(f.owner.cancel(prepared.id, claimed.revision), {
      code: 'RECOVERY_ALREADY_CLAIMED',
    });
    assert.deepEqual(await f.owner.claim(prepared.id, prepared.revision), claimed);
    await f.owner.close();
    const same = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: review.boot,
      instance: 'mock-runtime-two',
      snapshot: () => structuredClone(f.state),
    });
    await same.ready;
    assert.equal(same.admit(), false);
    assert.equal(same.receipt(prepared.id).phase, 'claimed');
    await same.close();
    const fresh = new Recovery({
      file: f.file,
      quiesce: async () => undefined,
      boot: 'mock-boot-two',
      instance: 'mock-runtime-three',
      snapshot: () => structuredClone(f.state),
    });
    await fresh.ready;
    assert.equal(fresh.admit(), true);
    assert.equal(fresh.receipt(prepared.id).phase, 'complete');
    assert.equal(fresh.receipt(prepared.id).boot, 'mock-boot-two');
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
    assert.equal(corrupt.admit(), false);
    assert.throws(() => corrupt.review(), { code: 'RECOVERY_STORE_UNAVAILABLE' });
    assert.equal(await readFile(f.file, 'utf8'), 'SYNTHETIC-CORRUPT-AUTHORITY');
    await corrupt.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
