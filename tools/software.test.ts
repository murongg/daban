import assert from 'node:assert/strict';
import test from 'node:test';
import { stopInstaller } from './software.ts';

test('fresh provisioning skips an absent installer while updates stop the existing service', () => {
  const reads: string[][] = [];
  stopInstaller((args) => {
    reads.push([...args]);
    return 'not-found\n';
  });
  assert.equal(reads.length, 1);
  stopInstaller((args) => {
    reads.push([...args]);
    return args[0] === 'show' ? 'loaded\n' : '';
  });
  assert.deepEqual(reads.at(-1), ['stop', 'daban-software.service']);
});
test('installer provisioning never ignores metadata errors or a failed service stop', () => {
  assert.throws(
    () =>
      stopInstaller(() => {
        throw new Error('mock systemd failure');
      }),
    /mock systemd failure/,
  );
  assert.throws(
    () =>
      stopInstaller((args) => {
        if (args[0] === 'stop') throw new Error('mock stop failure');
        return 'loaded\n';
      }),
    /mock stop failure/,
  );
  assert.throws(() => stopInstaller(() => 'error\n'), /Unexpected installer service state/);
});
