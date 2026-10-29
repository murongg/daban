import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RebootStatus } from '@daban/protocol';
import { isRebootStatus, type RecoveryReceipt, type RecoveryReview } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { Reboot } from './reboot';

function available(value: RebootStatus) {
  if (!value.available) throw new Error(value.error);
  return value;
}
const review: RecoveryReview = {
  boot: 'mock-boot-one',
  instance: 'mock-runtime-one',
  revision: 0,
  computersRevision: 0,
  digest: 'a'.repeat(64),
  screens: [],
  running: [],
  changing: false,
};
const request = {
  id: 'mock-host-reboot',
  revision: 0,
  review: review.digest,
  confirmation: 'restart-all-apps' as const,
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mock-host-reboot-'));
  const file = join(dir, 'runtime-recovery.json');
  let receipt: RecoveryReceipt | undefined;
  let vm: 'running' | 'stopped' | 'unknown' = 'running';
  const driver = {
    review: vi.fn(async () => structuredClone(review)),
    prepare: vi.fn(
      async (): Promise<RecoveryReceipt> =>
        (receipt = { id: request.id, phase: 'prepared', revision: 1, review }),
    ),
    claim: vi.fn(
      async (): Promise<RecoveryReceipt> =>
        (receipt = { id: request.id, phase: 'claimed', revision: 2, review }),
    ),
    receipt: vi.fn(async () => {
      if (!receipt) throw new Error('RECOVERY_RECEIPT_NOT_FOUND');
      return receipt;
    }),
    cancel: vi.fn(
      async (): Promise<RecoveryReceipt> =>
        (receipt = { id: request.id, phase: 'cancelled', revision: 2, review }),
    ),
    vm: vi.fn(async () => vm),
    stop: vi.fn(async () => {
      const record = JSON.parse(await readFile(file, 'utf8'));
      expect(record.operation.stage).toBe('stop-issued');
      expect(receipt?.phase).toBe('claimed');
      vm = 'stopped';
    }),
    start: vi.fn(async () => {
      vm = 'running';
      receipt = {
        id: request.id,
        phase: 'complete',
        revision: 3,
        review,
        boot: 'mock-boot-two',
        instance: 'mock-runtime-two',
      };
    }),
  };
  const owner = new Reboot({ file, target: 'b'.repeat(64), driver });
  await owner.ready;
  return {
    dir,
    file,
    owner,
    driver,
    setVm: (value: typeof vm) => {
      vm = value;
    },
    setReceipt: (value: RecoveryReceipt) => {
      receipt = value;
    },
  };
}
it('persists stop-issued before the only stop, waits for stopped proof, and coalesces exact retries', async () => {
  const f = await fixture();
  try {
    const [raw, b] = await Promise.all([f.owner.restart(request), f.owner.restart({ ...request })]);
    const a = available(raw);
    expect(a).toEqual(b);
    expect(a.operation?.stage).toBe('complete');
    expect(a.busy).toBe(false);
    expect(f.driver.stop).toHaveBeenCalledTimes(1);
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    expect(await f.owner.restart(request)).toEqual(a);
    expect(f.driver.stop).toHaveBeenCalledTimes(1);
    const serialized = await readFile(f.file, 'utf8');
    expect(serialized).not.toContain('confirmation');
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
it('rejects stale or busy review before journal ownership or VM effects are created', async () => {
  const f = await fixture();
  try {
    f.driver.review.mockResolvedValueOnce({ ...review, running: ['mock-running'] });
    await expect(f.owner.restart(request)).rejects.toThrow('RECOVERY_TASKS_RUNNING');
    expect(f.driver.prepare).not.toHaveBeenCalled();
    expect(f.driver.stop).not.toHaveBeenCalled();
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.owner.restart({ ...request, review: 'c'.repeat(64) })).rejects.toThrow(
      'RECOVERY_REVIEW_CHANGED',
    );
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
it('does not treat stop-command success as proof of a stopped VM', async () => {
  const f = await fixture();
  f.driver.stop.mockImplementation(async () => undefined);
  try {
    const value = available(await f.owner.restart(request));
    expect(value.operation?.stage).toBe('stop-issued');
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(isRebootStatus(value)).toBe(true);
    expect(isRebootStatus({ ...value, target: 'SYNTHETIC-PRIVATE' })).toBe(false);
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
it('closing during claim cannot advance to stop or start after a late backend reply', async () => {
  const f = await fixture();
  let release: () => unknown = () => undefined,
    entered: () => unknown = () => undefined;
  const waiting = new Promise<RecoveryReceipt>((resolve) => {
    release = () => resolve({ id: request.id, revision: 2, phase: 'claimed', review });
  });
  const started = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  f.driver.claim.mockImplementation(async () => {
    entered();
    return waiting;
  });
  try {
    const pending = f.owner.restart(request);
    await started;
    const closing = f.owner.close();
    release();
    await Promise.all([pending, closing]);
    expect(f.driver.stop).not.toHaveBeenCalled();
    expect(f.driver.start).not.toHaveBeenCalled();
    await expect(f.owner.restart(request)).rejects.toThrow('RUNTIME_CLOSED');
  } finally {
    release();
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
it('retains corrupt or different-target journals without silently admitting a new recovery', async () => {
  const f = await fixture();
  try {
    await f.owner.restart(request);
    await f.owner.close();
    const bytes = await readFile(f.file, 'utf8');
    const moved = new Reboot({ file: f.file, target: 'c'.repeat(64), driver: f.driver });
    await moved.ready;
    expect(moved.status()).toEqual({ available: false, error: 'RECOVERY_TARGET_CHANGED' });
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
    await moved.close();
    await writeFile(f.file, 'SYNTHETIC-CORRUPT');
    const corrupt = new Reboot({ file: f.file, target: 'b'.repeat(64), driver: f.driver });
    await corrupt.ready;
    expect(corrupt.status()).toEqual({
      available: false,
      error: 'RECOVERY_HOST_STORE_UNAVAILABLE',
    });
    expect(await readFile(f.file, 'utf8')).toBe('SYNTHETIC-CORRUPT');
    await corrupt.close();
    expect(f.driver.stop).toHaveBeenCalledTimes(1);
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
it('retains a lost stop outcome across relaunch and inspection never repeats a destructive effect', async () => {
  const f = await fixture();
  f.driver.stop.mockImplementation(async () => {
    throw new Error('SYNTHETIC-TRANSPORT-LOSS');
  });
  try {
    const result = available(await f.owner.restart(request));
    expect(result.operation?.stage).toBe('stop-issued');
    await f.owner.close();
    const reopened = new Reboot({ file: f.file, target: 'b'.repeat(64), driver: f.driver });
    await reopened.ready;
    expect(available(await reopened.restart(request)).operation?.stage).toBe('stop-issued');
    await reopened.inspect(request.id);
    expect(f.driver.stop).toHaveBeenCalledTimes(1);
    expect(f.driver.start).not.toHaveBeenCalled();
    f.setVm('stopped');
    expect(available(await reopened.inspect(request.id)).operation?.stage).toBe('stopped');
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(available(await reopened.start(request.id)).operation?.stage).toBe('complete');
    expect(f.driver.stop).toHaveBeenCalledTimes(1);
    await reopened.close();
  } finally {
    await f.owner.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
