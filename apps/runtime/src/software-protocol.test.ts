import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isInteractionInput,
  isSoftwarePackages,
  isSoftwarePlan,
  isSoftwareReceipt,
  isSoftwareState,
} from '@daban/protocol';

const plan = {
  id: 'mock-plan',
  requested: ['mock-calculator'],
  targets: [{ name: 'mock-calculator', version: '1.2-1' }],
  packages: [
    { name: 'mock-calculator', version: '1.2-1' },
    { name: 'mock-library', version: '2:3.0~1' },
  ],
  source: 'debian',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:20:00Z',
  digest: 'a'.repeat(64),
};
test('software wire contract rejects command syntax, duplicates, foreign plans and unbounded payloads', () => {
  assert.equal(isSoftwarePackages(['mock-calculator']), true);
  for (const packages of [
    [],
    ['-y'],
    ['curl https://example.test'],
    ['mock-tool-'],
    ['mock-tool+'],
    ['../mock-tool'],
    ['mock-tool=1'],
    ['mock-tool', 'mock-tool'],
    ['mock-tool\nother'],
    Array.from({ length: 9 }, (_, i) => `mock-app${i}`),
  ])
    assert.equal(isSoftwarePackages(packages), false);
  assert.equal(isSoftwarePlan(plan), true);
  for (const patch of [
    { command: 'mock-command' },
    { source: 'other' },
    { digest: 'bad' },
    { targets: [] },
    { packages: [...plan.packages, plan.packages[0]] },
    { expiresAt: plan.createdAt },
    { requested: ['other-package'] },
    { packages: [{ name: 'mock-tool', version: '1; echo mock' }] },
  ])
    assert.equal(isSoftwarePlan({ ...plan, ...patch }), false);
  const receipt = { plan, phase: 'installed', updatedAt: plan.createdAt };
  assert.equal(isSoftwareReceipt(receipt), true);
  assert.equal(isSoftwareState({ available: true, items: [receipt] }), true);
  assert.equal(isSoftwareState({ available: true, items: [receipt, receipt] }), false);
  assert.equal(isSoftwareReceipt({ ...receipt, phase: 'approved' }), false);
});
test('software approval embeds the exact immutable plan and only a decision can authorize it', () => {
  const card = {
    id: 'mock-approval',
    sessionId: 'mock-session',
    kind: 'approval',
    tool: 'software_install',
    plan,
    purpose: '合成用途',
  };
  assert.equal(isInteractionInput(card), true);
  assert.equal(isInteractionInput({ ...card, packages: ['other-package'] }), false);
  assert.equal(isInteractionInput({ ...card, plan: { ...plan, digest: 'bad' } }), false);
});
