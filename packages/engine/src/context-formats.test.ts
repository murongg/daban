import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approvalRulesCapability,
  disconnected,
  type Interaction,
  isInteraction,
  type McpReceipt,
  type PolicyDecision,
  remoteReplyFor,
  remoteSnapshotFor,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { RemoteStore } from './remote-store.js';

const decision: PolicyDecision = {
  effect: 'ask',
  source: 'mode',
  reasonCode: 'baselineAsked',
  matchedRules: [],
  policyRevision: 0,
  requestHash: 'c'.repeat(64),
  scope: { kind: 'bot', bot: 'mock-bot' },
  trigger: 'interactive',
  selector: {
    kind: 'mcp',
    connection: 'mock-connection',
    configRevision: 1,
    catalogDigest: 'a'.repeat(64),
    tool: 'synthetic_write',
    inputHash: 'b'.repeat(64),
  },
};
const pending: Interaction = {
  id: 'mock-card',
  sessionId: 'mock-session',
  kind: 'approval',
  tool: 'mcp_call',
  connection: 'mock-connection',
  configRevision: 1,
  catalogDigest: 'a'.repeat(64),
  name: 'Synthetic connection',
  origin: 'https://mcp.example.test',
  operation: 'synthetic_write',
  arguments: '{}',
  inputHash: 'b'.repeat(64),
  bot: 'mock-bot',
  runId: 'mock-run',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  purposeScope: { taskId: 'mock-run', turnId: 'mock-turn' },
  policyDecision: decision,
};

test('AP views preserve ordinary one-time replies without altering stored purpose or permission', () => {
  expect(isInteraction(pending)).toBe(true);
  const resolved: Interaction = {
    ...pending,
    status: 'resolved',
    reply: { kind: 'decision', allow: true, confirmPurpose: true },
  };
  const canonical = JSON.stringify(resolved);
  const legacy = remoteReplyFor('interaction.reply', resolved, {}, 2);
  expect(legacy).not.toHaveProperty('purposeScope');
  expect(legacy).not.toHaveProperty('policyDecision');
  expect(legacy).toHaveProperty('reply', { kind: 'decision', allow: true });
  expect(
    remoteReplyFor('interaction.reply', resolved, {}, 2, {
      approvalRules: approvalRulesCapability,
    }),
  ).toEqual(resolved);
  expect(JSON.stringify(resolved)).toBe(canonical);
  const snapshot = {
    ...disconnected('ready'),
    approvalRules: { capability: approvalRulesCapability, available: true, revision: 0 },
    interactions: [pending],
    delivery: true,
    searchSettings: true,
  };
  expect(remoteSnapshotFor(snapshot, {}, 2)).not.toHaveProperty('approvalRules');
  expect(remoteSnapshotFor(snapshot, {}, 2)).not.toHaveProperty('interactions.0.purposeScope');
  const partial = remoteSnapshotFor(snapshot, {}, 2, { approvalRules: approvalRulesCapability });
  expect(partial).toHaveProperty('interactions.0.purposeScope', pending.purposeScope);
  expect(partial).not.toHaveProperty('delivery');
  expect(partial).not.toHaveProperty('searchSettings');
});

test('cached modern approval writes project for a downgraded peer without redispatch and revoke still wins', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-format-replay-'));
  const keys = await RemoteKeys.open(path.join(root, 'controller'), 'Synthetic controller');
  const store = new RemoteStore({
    file: path.join(root, 'remote.sqlite'),
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
  });
  await store.ready;
  store.pair(keys.identity, 'controller');
  let writes = 0;
  const resolved: Interaction = {
    ...pending,
    status: 'resolved',
    reply: { kind: 'decision', allow: true, confirmPurpose: true },
  };
  const gateway = new RemoteGateway(store, async () => {
    writes++;
    return resolved;
  });
  const request = {
    type: 'request',
    id: 'mock-reply',
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
    method: 'interaction.reply',
    params: { bot: pending.bot, runId: pending.runId, id: pending.id, reply: resolved.reply },
  };
  try {
    expect(
      await gateway.invoke(keys.identity.id, 'mock-modern', request, {
        schema: 2,
        formats: { approvalRules: approvalRulesCapability },
      }),
    ).toEqual(resolved);
    const cached = await gateway.invoke(keys.identity.id, 'mock-old', request, 2);
    const legacy = remoteReplyFor('interaction.reply', cached, {}, 2);
    expect(legacy).toHaveProperty('reply', { kind: 'decision', allow: true });
    expect(legacy).not.toHaveProperty('policyDecision');
    expect(writes).toBe(1);
    expect(resolved.reply).toHaveProperty('confirmPurpose', true);
    store.revoke(keys.identity.id);
    await expect(gateway.invoke(keys.identity.id, 'mock-old', request, 2)).rejects.toThrow(
      'REMOTE_UNAUTHORIZED',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP policy data uses the declared format and Delivery provenance is never flattened', () => {
  const receipt: McpReceipt = {
    id: 'mock-call',
    bot: pending.bot,
    run: pending.runId,
    session: pending.sessionId,
    connection: pending.connection,
    configRevision: 1,
    tool: 'synthetic_write',
    phase: 'settled',
    preview: 'Synthetic result',
    createdAt: pending.createdAt,
    updatedAt: pending.updatedAt,
    policyDecision: decision,
  };
  expect(remoteReplyFor('mcp.receipt', receipt, {}, 2)).not.toHaveProperty('policyDecision');
  expect(
    remoteReplyFor('mcp.calls', { bot: pending.bot, items: [receipt] }, {}, 2),
  ).not.toHaveProperty('items.0.policyDecision');
  expect(
    remoteReplyFor('mcp.receipt', receipt, {}, 2, { approvalRules: approvalRulesCapability }),
  ).toEqual(receipt);
  const delivery = {
    workId: 'mock-work',
    attempts: [
      {
        attemptId: 'mock-attempt',
        workId: 'mock-work',
        requestId: 'mock-request',
        phase: 'unknown',
        source: 'model-report',
      },
    ],
  };
  const bytes = JSON.stringify(delivery);
  expect(() => remoteReplyFor('delivery.get', delivery, {}, 2)).toThrow('RUNTIME_TOO_OLD');
  expect(remoteReplyFor('delivery.get', delivery, {}, 2, { delivery: true })).toEqual(delivery);
  expect(JSON.stringify(delivery)).toBe(bytes);
});
