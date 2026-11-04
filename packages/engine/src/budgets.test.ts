import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BudgetPrice, defaultBudgetPolicy } from '@daban/protocol';
import { expect, test } from 'vitest';

import { Budgets } from './budgets.js';

const request = {
  attemptId: 'synthetic-attempt',
  runId: 'synthetic-run',
  modelAttemptId: 'synthetic-model-attempt',
  rootSessionId: 'synthetic-root',
  sessionId: 'synthetic-root',
  purpose: 'main' as const,
  routeKey: 'synthetic-route',
  auth: 'synthetic-auth',
  requestHash: 'a'.repeat(64),
  reservedTokens: 100,
};
const reported = {
  state: 'reported',
  inputTokens: 40,
  outputTokens: 20,
  cacheReadTokens: 10,
  cacheWriteTokens: 0,
} as const;
async function fixture(
  run: (store: Budgets, file: string, open: () => Promise<Budgets>) => Promise<unknown>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budgets-'));
  const file = path.join(root, 'budgets.sqlite');
  const open = async () => {
    const store = new Budgets(file);
    await store.ready;
    return store;
  };
  let store: Budgets | undefined;
  try {
    store = await open();
    await run(store, file, open);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
}
test('atomic single-use permits count concurrent reservations and idempotent attempts', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-root', {
      ...defaultBudgetPolicy,
      mode: 'strict',
      maxRequests: 1,
    });
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => store.reserve(scope, request)),
      Promise.resolve().then(() =>
        store.reserve(scope, { ...request, attemptId: 'synthetic-other' }),
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(store.reserve(scope, request).attemptId).toBe(request.attemptId);
    expect(() => store.reserve(scope, { ...request, routeKey: 'forged-route' })).toThrow(
      'BUDGET_ATTEMPT_CONFLICT',
    );
    expect(store.dispatch(scope, request.attemptId)).toBe(true);
    expect(store.dispatch(scope, request.attemptId)).toBe(false);
    expect(store.view(scope.budgetId).requests).toBe(1);
  }));
test('duplicate settlement is immutable; invalid, foreign and conflicting reports cannot lower totals', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-root');
    store.reserve(scope, request);
    store.dispatch(scope, request.attemptId);
    expect(() => store.report(request.attemptId, reported, request.runId, 'wrong-auth')).toThrow();
    store.report(request.attemptId, reported, request.runId, request.auth);
    store.report(request.attemptId, reported, request.runId, request.auth);
    expect(store.view(scope.budgetId).reported.inputTokens).toBe(40);
    expect(() =>
      store.report(request.attemptId, { ...reported, inputTokens: 5 }, request.runId, request.auth),
    ).toThrow('BUDGET_RECEIPT_CONFLICT');
  }));
test('restart releases unsent reservations, preserves dispatched unknown and permits only late settlement', async () =>
  fixture(async (store, _file, open) => {
    const scope = store.ensure('synthetic-root');
    store.reserve(scope, request);
    store.dispatch(scope, request.attemptId);
    store.reserve(scope, { ...request, attemptId: 'synthetic-unsent' });
    store.close();
    const recovered = await open();
    try {
      const view = recovered.view(scope.budgetId);
      expect(view.unknownCount).toBe(1);
      expect(view.reservedTokens).toBe(100);
      expect(view.receipts.find((r) => r.attemptId === 'synthetic-unsent')?.phase).toBe('released');
      recovered.report(request.attemptId, reported, request.runId, request.auth);
      expect(recovered.view(scope.budgetId).reported.outputTokens).toBe(20);
    } finally {
      recovered.close();
    }
  }));
test('human revision keeps cumulative usage and rejects old unsent permits', async () =>
  fixture(async (store) => {
    const policy = { ...defaultBudgetPolicy, mode: 'strict' as const, maxRequests: 1 };
    const scope = store.ensure('synthetic-root', policy);
    store.reserve(scope, request);
    store.dispatch(scope, request.attemptId);
    store.report(request.attemptId, reported, request.runId, request.auth);
    const next = store.increase(
      scope.budgetId,
      1,
      { ...policy, maxRequests: 3 },
      'synthetic-human-command',
    );
    expect(next.scope.revision).toBe(2);
    expect(next.state).toBe('stopped');
    expect(next.requests).toBe(1);
    expect(next.reported.inputTokens).toBe(40);
    expect(
      store.increase(scope.budgetId, 1, { ...policy, maxRequests: 3 }, 'synthetic-human-command'),
    ).toEqual(next);
    expect(() => store.reserve(scope, { ...request, attemptId: 'synthetic-new' })).toThrow(
      'BUDGET_REVISION_CONFLICT',
    );
    expect(store.ensure('synthetic-root')).toEqual(next.scope);
    expect(() =>
      store.reserve(next.scope, { ...request, attemptId: 'synthetic-before-continue' }),
    ).toThrow('BUDGET_STOPPED');
    store.activate(next.scope, 'synthetic-human-command');
    expect(
      store.reserve(next.scope, { ...request, attemptId: 'synthetic-after-continue' }).phase,
    ).toBe('reserved');
  }));
test('missing prices and missing usage are visible unknowns, never free calls', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-root');
    store.reserve(scope, request);
    store.dispatch(scope, request.attemptId);
    store.report(
      request.attemptId,
      { state: 'unknown', reason: 'STREAM_INTERRUPTED' },
      request.runId,
      request.auth,
    );
    const view = store.view(scope.budgetId);
    expect(view.unknownCount).toBe(1);
    expect(view.unknownCostCount).toBe(1);
    expect(view.estimatedMicros).toBeUndefined();
    expect(view.reservedMicros).toBeUndefined();
    expect(view.reservedTokens).toBe(100);
  }));

test('different currencies never become one total and captured prices survive settings changes', async () =>
  fixture(async (store) => {
    const price: BudgetPrice = {
      id: 'synthetic-usd',
      routeKey: 'synthetic-route',
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00.000Z',
      input: 1000000,
      output: 2000000,
      cacheRead: 500000,
      cacheWrite: 1000000,
    };
    store.configure(
      0,
      defaultBudgetPolicy,
      [price, { ...price, id: 'synthetic-cny', routeKey: 'synthetic-other', currency: 'CNY' }],
      'synthetic-config',
    );
    const scope = store.ensure('synthetic-root');
    store.reserve(scope, request);
    store.dispatch(scope, request.attemptId);
    store.report(request.attemptId, reported, request.runId, request.auth);
    store.configure(1, defaultBudgetPolicy, [], 'synthetic-price-delete');
    store.reserve(scope, {
      ...request,
      attemptId: 'synthetic-other-attempt',
      routeKey: 'synthetic-other',
    });
    store.dispatch(scope, 'synthetic-other-attempt');
    store.report('synthetic-other-attempt', reported, request.runId, request.auth);
    const view = store.view(scope.budgetId);
    expect(view.estimatedMicros).toBeUndefined();
    expect(view.receipts[0].price?.id).toBe('synthetic-usd');
    expect(view.receipts[1].price?.id).toBe('synthetic-cny');
  }));

test('logical active time is cumulative across runs before admitting another send', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-time', { ...defaultBudgetPolicy, activeMs: 1000 });
    store.bind(scope, 'synthetic-first');
    store.bind(scope, 'synthetic-second');
    store.time('synthetic-first', 600);
    store.time('synthetic-second', 500);
    expect(() => store.reserve(scope, request)).toThrow('BUDGET_TIME_LIMIT');
    expect(store.view(scope.budgetId).requests).toBe(0);
  }));

test('successful fallback metering cannot erase an earlier attempt coverage gap', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-coverage');
    store.bind(scope, 'synthetic-run');
    store.coverage('synthetic-run', 'synthetic-first-attempt', false);
    store.coverage('synthetic-run', 'synthetic-fallback-attempt', true);
    expect(store.view(scope.budgetId).availability).toBe('partial');
  }));

test('known reservation prices do not turn an unknown provider result into a known cost', async () =>
  fixture(async (store) => {
    const price: BudgetPrice = {
      id: 'synthetic-price',
      routeKey: 'synthetic-route',
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00.000Z',
      input: 1000000,
      output: 2000000,
      cacheRead: 500000,
      cacheWrite: 1000000,
    };
    store.configure(0, defaultBudgetPolicy, [price], 'synthetic-price-config');
    const scope = store.ensure('synthetic-unknown-priced');
    store.reserve(scope, request);
    store.dispatch(scope, request.attemptId);
    store.report(
      request.attemptId,
      { state: 'unknown', reason: 'SYNTHETIC_DISCONNECT' },
      request.runId,
      request.auth,
    );
    const view = store.view(scope.budgetId);
    expect(view.estimatedMicros).toBeUndefined();
    expect(view.reservedMicros).toBeGreaterThan(0);
    expect(view.unknownCostCount).toBe(1);
  }));

test('snapshot identity is immutable even after removing an active manual price', async () =>
  fixture(async (store) => {
    const price: BudgetPrice = {
      id: 'synthetic-immutable-price',
      routeKey: 'synthetic-route',
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00.000Z',
      input: 1000000,
      output: 2000000,
      cacheRead: 500000,
      cacheWrite: 1000000,
    };
    store.configure(0, defaultBudgetPolicy, [price], 'synthetic-price-first');
    expect(() =>
      store.configure(1, defaultBudgetPolicy, [{ ...price, input: 1 }], 'synthetic-price-rewrite'),
    ).toThrow('BUDGET_PRICE_IMMUTABLE');
    store.configure(1, defaultBudgetPolicy, [], 'synthetic-price-remove');
    expect(() =>
      store.configure(2, defaultBudgetPolicy, [{ ...price, input: 1 }], 'synthetic-price-reuse'),
    ).toThrow('BUDGET_PRICE_IMMUTABLE');
  }));

test('a permit cannot be claimed by a different run sharing the same logical budget', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-scope');
    store.reserve(scope, request);
    expect(() =>
      store.dispatch(scope, request.attemptId, {
        runId: 'foreign-run',
        modelAttemptId: request.modelAttemptId,
        auth: request.auth,
      }),
    ).toThrow('BUDGET_OWNER_CONFLICT');
    expect(store.view(scope.budgetId).receipts[0].phase).toBe('reserved');
  }));

test('the same attempt ID with a different actual wire body digest conflicts', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-body-owner');
    const first = { ...request, requestHash: 'a'.repeat(64) };
    const changed = { ...first, requestHash: 'b'.repeat(64) };
    store.reserve(scope, first);
    expect(() => store.reserve(scope, changed)).toThrow('BUDGET_ATTEMPT_CONFLICT');
  }));

test('defaults reject goal limits that the existing native owner does not expose', async () =>
  fixture(async (store) => {
    expect(() =>
      store.configure(
        0,
        { ...defaultBudgetPolicy, goalRounds: 1 },
        [],
        'synthetic-unsupported-goal-limit',
      ),
    ).toThrow('INVALID_BUDGET_SETTINGS');
    expect(store.settings().policy.goalRounds).toBe(3);
  }));

test('conservative active time charged by the existing owner cannot be erased by ledger recovery', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-owner-time');
    store.bind(scope, 'synthetic-old-run');
    store.time('synthetic-old-run', 100);
    store.bind(scope, 'synthetic-new-run');
    expect(store.time('synthetic-new-run', 0, 300000)).toBe(300000);
    expect(() => store.reserve(scope, request)).toThrow('BUDGET_TIME_LIMIT');
  }));

test('corrupt persisted policy fails closed instead of silently disabling a strict limit', async () =>
  fixture(async (store, file, open) => {
    const scope = store.ensure('synthetic-corrupt', {
      ...defaultBudgetPolicy,
      mode: 'strict',
      maxRequests: 1,
    });
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const corrupt = new DatabaseSync(file);
    corrupt
      .prepare('UPDATE budget_tasks SET policy = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...defaultBudgetPolicy, mode: 'corrupt', maxRequests: 1 }),
        scope.budgetId,
      );
    corrupt.close();
    const recovered = await open();
    try {
      expect(() => recovered.reserve(scope, request)).toThrow('BUDGET_STORE_CORRUPT');
    } finally {
      recovered.close();
    }
  }));

test('legacy continuation history remains explicitly partial and cannot acquire a strict historical request guarantee', async () =>
  fixture(async (store) => {
    const scope = store.ensure('synthetic-legacy', defaultBudgetPolicy, true);
    expect(Reflect.get(store.view(scope.budgetId), 'historyUnmetered')).toBe(true);
    expect(store.view(scope.budgetId).availability).toBe('partial');
    expect(() =>
      store.ensure(
        'synthetic-legacy-strict',
        { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
        true,
      ),
    ).toThrow('BUDGET_HISTORY_UNMETERED');
  }));
