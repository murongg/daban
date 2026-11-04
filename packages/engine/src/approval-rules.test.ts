import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type ApprovalRuleDraft,
  type ApprovalSelector,
  isApprovalRuleDraft,
  isApprovalSelector,
  isMcpPurposeScope,
  isUserReply,
  matchesReply,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { ApprovalRules, decide } from './approval-rules.js';

const scope = { kind: 'bot' as const, bot: 'mock-bot' };
const selector: ApprovalSelector = { kind: 'url', url: 'https://example.test/mock?q=1' };
const draft: ApprovalRuleDraft = {
  id: 'mock-rule',
  name: 'Synthetic rule',
  enabled: true,
  effect: 'deny',
  trigger: 'interactive',
  selector,
};
const request = {
  scope,
  selector,
  trigger: 'interactive' as const,
  mode: 'auto' as const,
  baseline: 'allow' as const,
  allowEligible: false,
};

test('purpose scope accepts only its own exact task and Human turn identifiers', () => {
  expect(isMcpPurposeScope({ taskId: 'mock-task', turnId: 'mock-turn' })).toBe(true);
  expect(isMcpPurposeScope({ taskId: 'mock-task', turnId: 'mock-turn', granted: true })).toBe(
    false,
  );
  const inherited = Object.assign(Object.create({ taskId: 'mock-task', turnId: 'mock-turn' }), {
    arbitrary: true,
    granted: true,
  });
  expect(isMcpPurposeScope(inherited)).toBe(false);
});

test('a purpose reply must be an explicit allow on an MCP card with Host purpose scope', () => {
  const reply = { kind: 'decision', allow: true, confirmPurpose: true };
  expect(isUserReply(reply)).toBe(true);
  expect(isUserReply({ ...reply, allow: false })).toBe(false);
  expect(isUserReply({ ...reply, taskId: 'mock-forged' })).toBe(false);
  expect(
    matchesReply(
      {
        kind: 'approval',
        id: 'mock-card',
        sessionId: 'mock-session',
        tool: 'web_fetch',
        url: 'https://example.test',
      },
      reply,
    ),
  ).toBe(false);
});

test('precise selectors reject prefixes, regex, credentials, incomplete MCP identity and software allow', () => {
  for (const input of [
    { kind: 'command', tool: 'shell', commandPrefix: 'ls', cwd: '/workspace' },
    { kind: 'url', url: 'https://user:pass@example.test/mock' },
    { kind: 'url', url: 'https://example.test/mock#fragment' },
    { kind: 'url', url: 'https://example.test/', regex: '.*' },
    { kind: 'command', tool: 'shell', commandHash: 'a'.repeat(64), cwd: '/workspace/../private' },
    {
      kind: 'mcp',
      connection: 'mock-connection',
      configRevision: 1,
      tool: 'mock_echo',
      inputHash: 'a'.repeat(64),
    },
    { kind: 'native', selector: 'button' },
  ])
    expect(isApprovalSelector(input)).toBe(false);
  expect(
    isApprovalRuleDraft({
      ...draft,
      effect: 'allow',
      selector: { kind: 'software', planId: 'mock-plan', planHash: 'a'.repeat(64) },
    }),
  ).toBe(false);
  expect(isApprovalRuleDraft({ ...draft, name: 'x'.repeat(81) })).toBe(false);
  expect(isApprovalRuleDraft({ ...draft, expiresAt: 'tomorrow' })).toBe(false);
  expect(isApprovalRuleDraft({ ...draft, effect: ['deny'] })).toBe(false);
  expect(isApprovalRuleDraft({ ...draft, expiresAt: '2026-02-31T00:00:00Z' })).toBe(false);
  expect(
    isApprovalSelector({
      kind: 'command',
      tool: ['shell'],
      commandHash: 'a'.repeat(64),
      cwd: '/workspace',
    }),
  ).toBe(false);
});

test('deny dominates forced ask and every ordering of overlapping effects', () => {
  const effects = ['deny', 'ask', 'allow'] as const;
  for (const first of effects)
    for (const second of effects.filter((effect) => effect !== first)) {
      const third = effects.find((effect) => effect !== first && effect !== second)!;
      expect(
        decide({ ...request, boundary: 'ask', matches: [first, second, third] }),
      ).toMatchObject({ effect: 'deny', source: 'rule' });
    }
  expect(decide({ ...request, boundary: 'deny', matches: ['ask', 'allow'] }).effect).toBe('deny');
  expect(decide({ ...request, baseline: 'deny', mode: 'ask', matches: ['allow'] }).effect).toBe(
    'deny',
  );
  expect(decide({ ...request, mode: 'ask', matches: ['allow'] }).effect).toBe('ask');
  expect(decide({ ...request, baseline: 'ask', matches: ['allow'] }).effect).toBe('ask');
  expect(
    decide({ ...request, baseline: 'ask', allowEligible: true, matches: ['allow'] }).effect,
  ).toBe('allow');
  expect(decide({ ...request, mode: 'full', matches: [] })).toMatchObject({
    effect: 'allow',
    source: 'mode',
  });
});

test('the active-rule bound is transactional and deleting a rule frees capacity without erasing receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-policy-limit-'));
  const rules = new ApprovalRules(path.join(root, 'rules.sqlite'));
  try {
    for (let i = 0; i < 100; i++)
      await rules.write({
        requestId: `mock-save-${i}`,
        expectedRevision: i,
        scope,
        action: 'save',
        rule: { ...draft, id: `mock-rule-${i}` },
      });
    const next = {
      requestId: 'mock-over-limit',
      expectedRevision: 100,
      scope,
      action: 'save' as const,
      rule: { ...draft, id: 'mock-extra-rule' },
    };
    await expect(rules.write(next)).rejects.toThrow('APPROVAL_RULE_LIMIT');
    expect((await rules.snapshot(scope)).revision).toBe(100);
    await rules.write({
      requestId: 'mock-delete',
      expectedRevision: 100,
      scope,
      action: 'delete',
      id: 'mock-rule-0',
    });
    expect((await rules.write({ ...next, expectedRevision: 101 })).revision).toBe(102);
    expect((await rules.receipt(scope, 'mock-save-0')).rule?.id).toBe('mock-rule-0');
  } finally {
    await rules.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('durable edits are scoped, optimistic and idempotent; old decisions do not survive change or expiry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-approval-rules-'));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const file = path.join(root, 'rules.sqlite');
  let rules = new ApprovalRules(file, () => now);
  try {
    expect(await rules.snapshot(scope)).toEqual({ scope, revision: 0, rules: [] });
    const edit = {
      requestId: 'mock-save',
      expectedRevision: 0,
      scope,
      action: 'save' as const,
      rule: { ...draft, expiresAt: '2026-01-01T00:01:00Z' },
    };
    const saved = await rules.write(edit);
    expect(await rules.write(edit)).toEqual(saved);
    expect(await rules.receipt(scope, edit.requestId)).toEqual(saved);
    await expect(rules.write({ ...edit, rule: { ...edit.rule, effect: 'allow' } })).rejects.toThrow(
      'APPROVAL_REQUEST_ID_REUSED',
    );
    await expect(rules.write({ ...edit, requestId: 'mock-stale' })).rejects.toThrow(
      'APPROVAL_RULE_CONFLICT',
    );
    await expect(rules.receipt({ kind: 'bot', bot: 'mock-other' }, edit.requestId)).rejects.toThrow(
      'APPROVAL_RECEIPT_NOT_FOUND',
    );
    const decision = await rules.evaluate(request);
    expect(decision).toMatchObject({
      effect: 'deny',
      matchedRules: [{ id: draft.id, revision: 1 }],
    });
    expect((await rules.evaluate({ ...request, trigger: 'automation' })).matchedRules).toEqual([]);
    expect(
      (
        await rules.evaluate({
          ...request,
          selector: { kind: 'url', url: 'https://example.test/mock?q=2' },
        })
      ).matchedRules,
    ).toEqual([]);
    rules.assertCurrent(decision);
    now += 61_000;
    expect((await rules.evaluate(request)).effect).toBe('allow');
    expect(() => rules.assertCurrent(decision)).toThrow('APPROVAL_POLICY_CHANGED');
    await rules.close();
    rules = new ApprovalRules(file, () => now);
    expect((await rules.snapshot(scope)).rules).toHaveLength(1);
    expect(await rules.receipt(scope, edit.requestId)).toEqual(saved);
    const current = await rules.evaluate(request);
    await rules.write({
      ...edit,
      requestId: 'mock-disable',
      expectedRevision: 1,
      rule: { ...draft, enabled: false },
    });
    expect(() => rules.assertCurrent(current)).toThrow('APPROVAL_POLICY_CHANGED');
  } finally {
    await rules.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt rule store refuses effects and does not replace the corrupt file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-corrupt-rules-'));
  const file = path.join(root, 'rules.sqlite');
  await writeFile(file, 'synthetic corrupt database');
  const rules = new ApprovalRules(file);
  try {
    await expect(rules.evaluate(request)).rejects.toThrow('APPROVAL_RULES_UNAVAILABLE');
    expect((await rules.status()).available).toBe(false);
  } finally {
    await rules.close();
    await rm(root, { recursive: true, force: true });
  }
});
