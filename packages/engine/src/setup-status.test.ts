import assert from 'node:assert/strict';
import test from 'node:test';
import { isSetupStatus } from '@daban/protocol';

test('validates legacy and optional-runtime preparation progress without accepting arbitrary fields', () => {
  assert.equal(isSetupStatus({ required: true, phase: 'extracting', progress: 37 }), true);
  assert.equal(
    isSetupStatus({
      required: true,
      target: 'agent',
      phase: 'downloading',
      downloaded: 37,
      total: 100,
      progress: 37,
    }),
    true,
  );
  assert.equal(isSetupStatus({ required: true, target: 'linux', phase: 'waiting' }), true);
  for (const status of [
    { required: true, phase: 'not-a-phase' },
    { required: true, phase: 'downloading', downloaded: 101, total: 100 },
    { required: true, phase: 'downloading', downloaded: 1 },
    { required: true, phase: 'downloading', progress: Number.NaN },
    { required: true, phase: 'available', target: 'untrusted' },
    { required: true, phase: 'available', key: 'SYNTHETIC PRIVATE KEY' },
  ])
    assert.equal(isSetupStatus(status), false);
});
