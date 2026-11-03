import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RecoveryReceipt, RecoveryReview } from '@daban/protocol';
import { expect, test } from 'vitest';
import { secureDirectory } from './private-files.js';
import { Reboot } from './reboot.js';

test('private restart receipts retain ownership, deduplication and restart recovery on Windows and POSIX', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-private-restart-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const file = path.join(root, 'power.json');
  const review: RecoveryReview = {
    boot: 'mock-boot',
    instance: 'mock-instance',
    revision: 0,
    computersRevision: 0,
    digest: 'a'.repeat(64),
    screens: [],
    running: [],
    changing: false,
  };
  const request = {
    id: 'mock-restart',
    revision: 0,
    review: review.digest,
    confirmation: 'restart-all-apps' as const,
  };
  let receipt: RecoveryReceipt = { id: request.id, phase: 'prepared', revision: 1, review };
  let state: 'running' | 'stopped' = 'running';
  let stops = 0;
  const driver = {
    review: async () => review,
    prepare: async () => receipt,
    claim: async () => (receipt = { ...receipt, phase: 'claimed', revision: 2 }),
    receipt: async () => receipt,
    cancel: async () => (receipt = { ...receipt, phase: 'cancelled', revision: 2 }),
    vm: async () => state,
    stop: async () => {
      expect(JSON.parse(await readFile(file, 'utf8')).operation.stage).toBe('stop-issued');
      expect(receipt.phase).toBe('claimed');
      state = 'stopped';
      stops++;
    },
    start: async () => {
      state = 'running';
      receipt = {
        ...receipt,
        phase: 'complete',
        revision: 3,
        boot: 'mock-boot-two',
        instance: 'mock-instance-two',
      };
    },
  };
  const options = { file, target: 'b'.repeat(64), driver };
  const owner = new Reboot(options);
  const first = await owner.restart(request);
  expect(first.available).toBe(true);
  expect.assert(first.available && first.operation?.stage === 'complete');
  await owner.close();
  const recovered = new Reboot(options);
  await recovered.ready;
  const next = await recovered.restart(request);
  expect.assert(next.available && next.operation?.stage === 'complete');
  expect(stops).toBe(1);
  await recovered.close();
  const link = path.join(root, 'linked.json');
  await symlink(file, link);
  const unsafe = new Reboot({ ...options, file: link });
  await unsafe.ready;
  expect(unsafe.status().available).toBe(false);
  await unsafe.close();
});
