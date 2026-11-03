import path from 'node:path';
import type { SetupStatus } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import { restartWindows } from './restart';

it('restarts only a waiting Windows installation after its host has fenced and proved all work idle', async () => {
  const actions: string[] = [];
  let status: SetupStatus = {
    required: true,
    target: 'linux',
    phase: 'waiting',
    windows: {
      acceleration: 'restart',
      mode: 'whpx',
      memoryMiB: 6144,
      diskGiB: 64,
    },
  };
  const run = vi.fn(async (program: string, args: string[]) => {
    actions.push('restart');
    expect(path.basename(program)).toBe('shutdown.exe');
    expect(args).toEqual(['/r', '/t', '0']);
  });
  const idle = vi.fn(async () => {
    actions.push('idle');
  });
  await restartWindows({ platform: 'win32', status: async () => status, idle, run });
  expect(actions).toEqual(['idle', 'restart']);
  status = { ...status, phase: 'creating' };
  await expect(
    restartWindows({ platform: 'win32', status: async () => status, idle, run }),
  ).rejects.toThrow('QEMU_RESTART_UNAVAILABLE');
  status = { ...status, phase: 'waiting' };
  idle.mockRejectedValueOnce(Error('AGENT_UPDATE_BUSY'));
  await expect(
    restartWindows({ platform: 'win32', status: async () => status, idle, run }),
  ).rejects.toThrow('AGENT_UPDATE_BUSY');
  expect(run).toHaveBeenCalledTimes(1);
});
