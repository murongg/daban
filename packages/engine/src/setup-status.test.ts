import { isSetupStatus } from '@daban/protocol';
import { expect, test } from 'vitest';

test('validates legacy and optional-runtime preparation progress without accepting arbitrary fields', () => {
  expect(isSetupStatus({ required: true, phase: 'extracting', progress: 37 })).toBe(true);
  expect(
    isSetupStatus({
      required: true,
      target: 'agent',
      phase: 'downloading',
      downloaded: 37,
      total: 100,
      progress: 37,
    }),
  ).toBe(true);
  expect(isSetupStatus({ required: true, target: 'linux', phase: 'waiting' })).toBe(true);
  for (const status of [
    { required: true, phase: 'not-a-phase' },
    { required: true, phase: 'downloading', downloaded: 101, total: 100 },
    { required: true, phase: 'downloading', downloaded: 1 },
    { required: true, phase: 'downloading', progress: Number.NaN },
    { required: true, phase: 'available', target: 'untrusted' },
    { required: true, phase: 'available', key: 'SYNTHETIC PRIVATE KEY' },
  ])
    expect(isSetupStatus(status)).toBe(false);
});

test('Windows setup carries bounded user-facing resources and acceleration state without private connection details', () => {
  const windows = {
    acceleration: 'restart',
    memoryMiB: 6144,
    diskGiB: 64,
    requiredBytes: 8 * 1024 ** 3,
    availableBytes: 32 * 1024 ** 3,
  };
  const status = { required: true, target: 'linux', phase: 'available', windows };
  expect(isSetupStatus(status)).toBe(true);
  expect(isSetupStatus({ ...status, windows: { ...windows, availableBytes: 4 * 1024 ** 4 } })).toBe(
    true,
  );
  for (const patch of [
    { acceleration: 'invented' },
    { mode: 'untrusted' },
    { memoryMiB: -1 },
    { requiredBytes: Number.NaN },
    { identityFile: 'SYNTHETIC PRIVATE PATH' },
    { token: 'SYNTHETIC SECRET' },
  ])
    expect(isSetupStatus({ ...status, windows: { ...windows, ...patch } })).toBe(false);
});
