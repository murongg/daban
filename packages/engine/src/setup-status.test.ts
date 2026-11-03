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
