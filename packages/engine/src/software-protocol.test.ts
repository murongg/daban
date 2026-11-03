import {
  isInteractionInput,
  isSoftwarePackages,
  isSoftwarePlan,
  isSoftwareReceipt,
  isSoftwareState,
} from '@daban/protocol';
import { expect, test } from 'vitest';

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
  expect(isSoftwarePackages(['mock-calculator'])).toBe(true);
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
    expect(isSoftwarePackages(packages)).toBe(false);
  expect(isSoftwarePlan(plan)).toBe(true);
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
    expect(isSoftwarePlan({ ...plan, ...patch })).toBe(false);
  const receipt = { plan, phase: 'installed', updatedAt: plan.createdAt };
  expect(isSoftwareReceipt(receipt)).toBe(true);
  expect(isSoftwareState({ available: true, items: [receipt] })).toBe(true);
  expect(isSoftwareState({ available: true, items: [receipt, receipt] })).toBe(false);
  expect(isSoftwareReceipt({ ...receipt, phase: 'approved' })).toBe(false);
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
  expect(isInteractionInput(card)).toBe(true);
  expect(isInteractionInput({ ...card, packages: ['other-package'] })).toBe(false);
  expect(isInteractionInput({ ...card, plan: { ...plan, digest: 'bad' } })).toBe(false);
});
