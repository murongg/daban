import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecoveryReceipt, RecoveryReview, RuntimeCommand } from '@daban/protocol';
import { expect, test } from 'vitest';
import { HostPower } from './power.js';

const review: RecoveryReview = {
  boot: 'mock-boot-one',
  instance: 'mock-instance-one',
  revision: 0,
  computersRevision: 0,
  digest: 'a'.repeat(64),
  screens: [],
  running: [],
  changing: false,
};
const request = {
  id: 'mock-host-power',
  revision: 0,
  review: review.digest,
  confirmation: 'restart-all-apps' as const,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mock-host-power-'));
  const file = join(root, 'reboot.json');
  let receipt: RecoveryReceipt | undefined;
  let vm: 'running' | 'stopped' | 'unknown' = 'running';
  const events: string[] = [];
  const driver = {
    review: async () => structuredClone(review),
    prepare: async (): Promise<RecoveryReceipt> => {
      events.push('prepare');
      receipt = { id: request.id, revision: 1, phase: 'prepared', review };
      return receipt;
    },
    claim: async (): Promise<RecoveryReceipt> => {
      events.push('claim');
      receipt = { id: request.id, revision: 2, phase: 'claimed', review };
      return receipt;
    },
    receipt: async () => {
      if (!receipt) throw new Error('RECOVERY_RECEIPT_NOT_FOUND');
      return receipt;
    },
    cancel: async (): Promise<RecoveryReceipt> => {
      events.push('cancel');
      receipt = { id: request.id, revision: 3, phase: 'cancelled', review };
      return receipt;
    },
    vm: async () => vm,
    stop: async () => {
      events.push('stop');
      vm = 'stopped';
    },
    start: async () => {
      events.push('start');
      vm = 'running';
      receipt = {
        id: request.id,
        revision: 3,
        phase: 'complete',
        review,
        boot: 'mock-boot-two',
        instance: 'mock-instance-two',
      };
    },
  };
  const beforeStop = async () => {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.operation.stage).toBe('stop-issued');
    expect(saved.operation.backend.phase).toBe('claimed');
    events.push('models-stop');
  };
  return { root, file, driver, beforeStop, events };
}

test('host power reviews without effects and stops host work only after a durable claimed stop intent', async () => {
  const f = await fixture();
  const power = new HostPower({
    file: f.file,
    target: 'b'.repeat(64),
    driver: f.driver,
    beforeStop: f.beforeStop,
  });
  try {
    await power.ready;
    expect(await power.handle({ type: 'recovery.review' })).toStrictEqual(review);
    expect(f.events).toStrictEqual([]);
    const [a, b] = await Promise.all([
      power.handle({ type: 'recovery.restart', request }),
      power.handle({ type: 'recovery.restart', request }),
    ]);
    expect(a).toStrictEqual(b);
    expect.assert('available' in a && a.available && a.operation?.stage === 'complete');
    expect(f.events).toStrictEqual(['prepare', 'claim', 'models-stop', 'stop', 'start']);
    expect(await power.handle({ type: 'recovery.restart', request })).toStrictEqual(a);
    expect(await power.handle({ type: 'recovery.status' })).toStrictEqual(power.status());
  } finally {
    await power.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('host power rejects unowned command shapes and never accepts bare VM or guest recovery authority', async () => {
  const f = await fixture();
  const power = new HostPower({ file: f.file, target: 'b'.repeat(64), driver: f.driver });
  try {
    for (const command of [
      { type: 'recovery.claim', id: request.id },
      { type: 'recovery.status', token: 'mock-execution-token' },
      { type: 'recovery.restart', request: { ...request, confirmation: undefined } },
      { type: 'recovery.start', id: '../mock' },
      { type: 'recovery.start', id: request.id, vm: 'mock-foreign' },
      { type: 'task.stop', bot: 'mock-bot' },
    ])
      await expect(power.handle(command as RuntimeCommand)).rejects.toMatchObject({
        name: 'Error',
        message: expect.stringMatching(/^INVALID_HOST_RECOVERY_COMMAND$/),
      });
    expect(f.events).toStrictEqual([]);
  } finally {
    await power.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('failed host quiescence leaves an inspectable stop intent without issuing VM power commands', async () => {
  const f = await fixture();
  const power = new HostPower({
    file: f.file,
    target: 'b'.repeat(64),
    driver: f.driver,
    beforeStop: async () => {
      throw new Error('mock quiescence failed');
    },
  });
  try {
    const result = await power.handle({ type: 'recovery.restart', request });
    expect.assert(
      'available' in result &&
        result.available &&
        result.operation?.stage === 'stop-issued' &&
        result.operation.error === 'RECOVERY_STOP_UNCONFIRMED',
    );
    expect(f.events).toStrictEqual(['prepare', 'claim']);
    await power.handle({ type: 'recovery.restart', request });
    expect(f.events).toStrictEqual(['prepare', 'claim']);
  } finally {
    await power.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('host process shutdown drains pending recovery without issuing a late stop or stopping the VM by itself', async () => {
  const f = await fixture();
  let entered: () => unknown = () => {};
  let release: () => unknown = () => {};
  const pending = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  const claim = f.driver.claim;
  f.driver.claim = async () => {
    entered();
    await new Promise<unknown>((done) => {
      release = () => done(undefined);
    });
    return claim();
  };
  const power = new HostPower({
    file: f.file,
    target: 'b'.repeat(64),
    driver: f.driver,
    beforeStop: f.beforeStop,
  });
  try {
    const restarting = power.handle({ type: 'recovery.restart', request });
    await pending;
    const closing = power.close();
    release();
    await restarting;
    await closing;
    expect(f.events.includes('stop')).toBe(false);
    expect(f.events.includes('models-stop')).toBe(false);
    await expect(power.handle({ type: 'recovery.review' })).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringMatching(/^RUNTIME_CLOSED$/),
    });
  } finally {
    release();
    await power.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
