import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Interaction, isInteraction, type McpReceipt, remoteReplyFor } from '@daban/protocol';
import { expect, test } from 'vitest';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { RemoteStore } from './remote-store.js';

const resolved: Interaction = {
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
  status: 'resolved',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  reply: { kind: 'decision', allow: true },
};
const historical = {
  ...resolved,
  policyDecision: { source: 'retired-rule' },
  purposeScope: { taskId: 'mock-run', turnId: 'mock-turn' },
};

test('historical approval replies have a strict basic outbound view without mutating stored data', () => {
  const before = JSON.stringify(historical);
  const projected = remoteReplyFor('interaction.reply', historical, {}, 2);
  expect(projected).toEqual(resolved);
  expect(isInteraction(projected)).toBe(true);
  expect(JSON.stringify(historical)).toBe(before);
  expect(
    isInteraction(
      remoteReplyFor(
        'interaction.reply',
        {
          ...historical,
          privateSdk: 'SYNTHETIC PRIVATE',
        },
        {},
        2,
      ),
    ),
  ).toBe(false);
  expect(
    remoteReplyFor(
      'interaction.reply',
      {
        ...historical,
        reply: { kind: 'decision', allow: true, confirmPurpose: true },
      },
      {},
      2,
    ),
  ).toEqual(resolved);
});

test('cached historical approvals project after lookup while revoke and single dispatch remain enforced', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-basic-replay-'));
  const keys = await RemoteKeys.open(path.join(root, 'controller'), 'Synthetic controller');
  const store = new RemoteStore({
    file: path.join(root, 'remote.sqlite'),
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
  });
  await store.ready;
  store.pair(keys.identity, 'controller');
  let writes = 0;
  const gateway = new RemoteGateway(store, async () => {
    writes++;
    return historical;
  });
  const request = {
    type: 'request',
    id: 'mock-reply',
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
    method: 'interaction.reply',
    params: { bot: resolved.bot, runId: resolved.runId, id: resolved.id, reply: resolved.reply },
  };
  try {
    await gateway.invoke(keys.identity.id, 'mock-first', request, 2);
    const cached = await gateway.invoke(keys.identity.id, 'mock-reconnect', request, 2);
    expect(remoteReplyFor('interaction.reply', cached, {}, 2)).toEqual(resolved);
    expect(writes).toBe(1);
    expect(historical).toHaveProperty('purposeScope');
    store.revoke(keys.identity.id);
    await expect(gateway.invoke(keys.identity.id, 'mock-reconnect', request, 2)).rejects.toThrow(
      'REMOTE_UNAUTHORIZED',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('historical MCP receipts keep basic identity and result without retaining a rule decision', () => {
  const receipt: McpReceipt = {
    id: 'mock-call',
    bot: resolved.bot,
    run: resolved.runId,
    session: resolved.sessionId,
    connection: 'mock-connection',
    configRevision: 1,
    tool: 'synthetic_write',
    phase: 'settled',
    preview: 'Synthetic result',
    createdAt: resolved.createdAt,
    updatedAt: resolved.updatedAt,
  };
  const archived = { ...receipt, policyDecision: { source: 'retired-rule' } };
  expect(remoteReplyFor('mcp.receipt', archived, {}, 2)).toEqual(receipt);
  expect(remoteReplyFor('mcp.calls', { bot: resolved.bot, items: [archived] }, {}, 2)).toEqual({
    bot: resolved.bot,
    items: [receipt],
  });
  expect(archived).toHaveProperty('policyDecision');
});
