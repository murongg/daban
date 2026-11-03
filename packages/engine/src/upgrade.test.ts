import { expect, test } from 'vitest';
import { UpgradeGate } from './upgrade.js';

test('an update cannot interrupt an in-flight request or a running job', () => {
  const gate = new UpgradeGate();
  const release = gate.enter();
  expect(() => gate.prepare(() => false)).toThrowError(/AGENT_UPDATE_BUSY/);
  expect(gate.admit()).toBe(true);
  release();
  release();
  expect(() => gate.prepare(() => true)).toThrowError(/AGENT_UPDATE_BUSY/);
  expect(gate.admit()).toBe(true);
  gate.prepare(() => false);
  expect(gate.admit()).toBe(false);
  expect(() => gate.enter()).toThrowError(/AGENT_UPDATING/);
});

test('admission is fenced before inspecting idle state and rolled back on refusal', () => {
  const gate = new UpgradeGate();
  expect(() =>
    gate.prepare(() => {
      expect(gate.admit()).toBe(false);
      throw Error('SYNTHETIC_UNAVAILABLE');
    }),
  ).toThrowError(/SYNTHETIC_UNAVAILABLE/);
  expect(gate.admit()).toBe(true);
  gate.prepare(() => false);
  expect(() => gate.prepare(() => false)).toThrowError(/AGENT_UPDATING/);
});
