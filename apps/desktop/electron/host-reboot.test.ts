import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RecoveryReceipt, RecoveryReview } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { ManagedHost } from './host';

const config = {
  limactl: '/mock/tools/limactl',
  limaHome: '/mock/lima',
  vm: 'mock-bots',
  port: 18767,
};
const review: RecoveryReview = {
  boot: 'mock-host-boot',
  instance: 'mock-host-runtime',
  revision: 0,
  computersRevision: 0,
  digest: 'a'.repeat(64),
  screens: [],
  running: [],
  changing: false,
};
const request = {
  id: 'mock-host-operation',
  revision: 0,
  review: review.digest,
  confirmation: 'restart-all-apps' as const,
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mock-managed-reboot-'));
  let vm = 'Running',
    stopped = false;
  let backend: RecoveryReceipt | undefined;
  const client = {
    status: vi.fn(async () => ({ phase: 'ready', protocolVersion: 24 })),
    recoveryReview: vi.fn(async () => review),
    prepareRecovery: vi.fn(
      async () => (backend = { id: request.id, revision: 1, phase: 'prepared', review }),
    ),
    claimRecovery: vi.fn(
      async () => (backend = { id: request.id, revision: 2, phase: 'claimed', review }),
    ),
    receiptRecovery: vi.fn(async () => {
      if (!backend) throw new Error('RECOVERY_RECEIPT_NOT_FOUND');
      return backend;
    }),
    cancelRecovery: vi.fn(
      async () => (backend = { id: request.id, revision: 2, phase: 'cancelled', review }),
    ),
  };
  const exec = vi.fn(async (program: string, args: string[]) => {
    if (program === config.limactl && args[0] === 'stop') {
      expect(
        JSON.parse(await readFile(join(dir, 'runtime-recovery.json'), 'utf8')).operation.stage,
      ).toBe('stop-issued');
      expect(backend?.phase).toBe('claimed');
      vm = 'Stopped';
      stopped = true;
    }
    if (program === config.limactl && args[0] === 'start') {
      vm = 'Running';
      if (stopped)
        backend = {
          id: request.id,
          revision: 3,
          phase: 'complete',
          review,
          boot: 'mock-new-boot',
          instance: 'mock-new-runtime',
        };
    }
    return { stdout: '' };
  });
  const probe = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify({ name: config.vm, status: vm }),
  }));
  const make = () =>
    new ManagedHost(config, join(dir, 'runtime-tunnel.sock'), {
      exec,
      probe,
      client: () => client as never,
    });
  return {
    dir,
    client,
    exec,
    probe,
    make,
    setVm: (value: string) => {
      vm = value;
    },
  };
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
  const sockets = f.exec.mock.calls.flatMap(([program, args]) =>
    program === 'ssh' && args.includes('-S') ? [args[args.indexOf('-S') + 1]] : [],
  );
  for (const socket of new Set(sockets)) {
    if (socket.startsWith(`/tmp/daban-${process.getuid?.()}-`)) await rmdir(dirname(socket));
  }
  await rm(f.dir, { recursive: true, force: true });
}
it('runs the journalled product stop/start against only its fixed VM after exact backend claim', async () => {
  const f = await fixture();
  const host = f.make();
  try {
    await host.connect();
    expect(await host.recoveryReview()).toEqual(review);
    const result = await host.recover(request);
    if (!result.available) throw new Error(result.error);
    expect(result.operation?.stage).toBe('complete');
    expect(
      f.exec.mock.calls.filter(
        ([program, args]) => program === config.limactl && args[0] === 'stop',
      ),
    ).toHaveLength(1);
    expect(
      f.exec.mock.calls.filter(
        ([program, args]) => program === config.limactl && args[0] === 'start',
      ),
    ).toHaveLength(2);
    expect(
      f.exec.mock.calls.filter(
        ([program, args]) => program === config.limactl && args[0] === 'stop',
      )[0][1],
    ).toEqual(['stop', '--tty=false', config.vm]);
    expect(await host.recover(request)).toEqual(result);
    const status = await host.recoveryStatus();
    if (!status.available) throw new Error(status.error);
    expect(status.operation?.stage).toBe('complete');
  } finally {
    await host.close();
    await cleanup(f);
  }
});
it('ordinary reconnect after an unknown stop cannot automatically start or stop the VM on relaunch', async () => {
  const f = await fixture();
  let host = f.make();
  const original = f.exec.getMockImplementation()!;
  f.exec.mockImplementation(async (program, args) => {
    if (program === config.limactl && args[0] === 'stop') throw new Error('MOCK-LOST-STOP');
    return original(program, args);
  });
  try {
    await host.connect();
    await host.recover(request);
    await host.close();
    f.setVm('Stopped');
    const count = f.exec.mock.calls.filter(
      ([p, args]) => p === config.limactl && args[0] === 'start',
    ).length;
    host = f.make();
    await expect(host.connect()).rejects.toThrow('RECOVERY_NEEDS_START');
    expect(
      f.exec.mock.calls.filter(([p, args]) => p === config.limactl && args[0] === 'start'),
    ).toHaveLength(count);
    const inspection = await host.inspectRecovery(request.id);
    if (!inspection.available) throw new Error(inspection.error);
    expect(inspection.operation?.stage).toBe('stopped');
    expect(
      f.exec.mock.calls.filter(([p, args]) => p === config.limactl && args[0] === 'stop'),
    ).toHaveLength(1);
  } finally {
    await host.close();
    await cleanup(f);
  }
});
