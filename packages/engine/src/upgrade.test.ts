import assert from 'node:assert/strict';
import test from 'node:test';
import { UpgradeGate } from './upgrade.js';

test('an update cannot interrupt an in-flight request or a running job', () => {
  const gate = new UpgradeGate();
  const release = gate.enter();
  assert.throws(() => gate.prepare(() => false), /AGENT_UPDATE_BUSY/);
  assert.equal(gate.admit(), true);
  release();
  release();
  assert.throws(() => gate.prepare(() => true), /AGENT_UPDATE_BUSY/);
  assert.equal(gate.admit(), true);
  gate.prepare(() => false);
  assert.equal(gate.admit(), false);
  assert.throws(() => gate.enter(), /AGENT_UPDATING/);
});

test('admission is fenced before inspecting idle state and rolled back on refusal', () => {
  const gate = new UpgradeGate();
  assert.throws(
    () =>
      gate.prepare(() => {
        assert.equal(gate.admit(), false);
        throw Error('SYNTHETIC_UNAVAILABLE');
      }),
    /SYNTHETIC_UNAVAILABLE/,
  );
  assert.equal(gate.admit(), true);
  gate.prepare(() => false);
  assert.throws(() => gate.prepare(() => false), /AGENT_UPDATING/);
});
