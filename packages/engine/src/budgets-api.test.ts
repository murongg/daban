import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultBudgetPolicy,
  isBudgetSettings,
  isBudgetView,
  managedProtocol,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

test('Host budget HTTP validates owners, revisions, receipts and unavailable strict bounds without inference', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-api-'));
  await secureDirectory(root);
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const headers = {
    'x-prototype-token': app.token,
    'x-daban-client-protocol': String(managedProtocol),
    'content-type': 'application/json',
  };
  const call = async (action: string, value: unknown = {}) => {
    const response = await fetch(`${app.url}/api/budgets/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(value),
    });
    return { status: response.status, value: (await response.json()) as unknown };
  };
  try {
    const initial = await call('settings');
    expect(initial.status).toBe(200);
    expect.assert(isBudgetSettings(initial.value));
    const policy = { ...defaultBudgetPolicy, mode: 'strict' as const, maxRequests: 4 };
    const input = {
      scope: initial.value.scope,
      id: 'synthetic-settings-write',
      revision: 0,
      policy,
      prices: [],
    };
    const first = await call('configure', input);
    expect(first.status).toBe(200);
    expect(await call('configure', input)).toEqual(first);
    expect(
      (
        await call('configure', {
          ...input,
          id: 'synthetic-stale',
          policy: { ...policy, maxRequests: 5 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('configure', {
          ...input,
          id: 'synthetic-fees',
          revision: 1,
          policy: { ...policy, maxTokens: 100 },
        })
      ).status,
    ).toBe(400);
    const scope = app.models!.budgets.ensure('synthetic-root');
    await app.models!.journal.put({
      bot: 'mock-bot',
      runId: 'mock-run',
      chatRevision: 0,
      prompt: 'SYNTHETIC TASK',
      kind: 'chat',
      phase: 'stopped',
      running: false,
      result: '',
      error: '',
      trace: [],
      budget: scope,
    });
    const view = await call('read', {
      scope: { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 },
    });
    expect(view.status).toBe(200);
    expect(isBudgetView(view.value)).toBe(true);
    expect(
      (await call('read', { scope: { bot: 'mock-other', runId: 'mock-run', chatRevision: 0 } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call('read', {
          scope: { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 },
          budgetId: 'forged',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('continue', {
          scope: { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 },
          budget: { ...scope, revision: 99 },
          id: 'synthetic-stale-continue',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('increase', {
          scope: { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 },
          budgetId: 'forged',
          revision: 1,
          policy,
          id: 'synthetic-wrong-budget',
        })
      ).status,
    ).toBe(403);
    expect(app.models!.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
