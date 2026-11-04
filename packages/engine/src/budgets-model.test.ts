import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BudgetScope } from '@daban/protocol';
import { expect, test } from 'vitest';
import type { Budgets } from './budgets.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('Host owns logical budgets across retries and accepts only original-attempt late usage after stop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-model-'));
  let release: () => unknown = () => {};
  let entered: () => unknown = () => {};
  const ready = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session() {
      return {
        id: 'synthetic-session',
        run: async () => {
          entered();
          await gate;
          return { sessionId: 'synthetic-session', finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const models = new ModelRuns({
    dir: path.join(root, 'models'),
    workspace: path.join(root, 'workspace'),
    settings,
    Harness,
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.save({ apiKey: 'synthetic-budget-secret' });
    await models.start('mock-bot', { requestId: 'synthetic-request', prompt: 'Synthetic task' });
    await ready;
    const job = models.jobs.get('mock-bot')!;
    const scope = Reflect.get(job, 'budget') as BudgetScope | undefined;
    expect(scope, 'accepted Host task must persist its trusted budget identity').toBeDefined();
    const ledger = Reflect.get(models, 'budgets') as Budgets;
    const auth = `Bearer ${job.token}`;
    const rpc = (method: string, params: Record<string, unknown>) =>
      models.rpc('mock-bot', auth, { id: 'synthetic-rpc', method, params });
    const params = {
      scope,
      modelAttemptId: job.attemptId,
      attemptId: 'synthetic-wire',
      requestHash: 'a'.repeat(64),
      rootSessionId: job.sessionId,
      sessionId: job.sessionId,
      purpose: 'main',
    };
    expect(await rpc('budget.reserve', params)).toMatchObject({ result: { accepted: true } });
    expect(
      await rpc('budget.dispatched', {
        scope,
        modelAttemptId: job.attemptId,
        attemptId: 'synthetic-wire',
      }),
    ).toMatchObject({ result: { send: true } });
    expect(
      await rpc('budget.dispatched', {
        scope,
        modelAttemptId: job.attemptId,
        attemptId: 'synthetic-wire',
      }),
    ).toMatchObject({ result: { send: false } });
    await expect(
      rpc('budget.reserve', {
        ...params,
        attemptId: 'synthetic-forged',
        rootSessionId: 'foreign-root',
      }),
    ).rejects.toThrow();
    await models.stop('mock-bot');
    const usage = {
      state: 'reported',
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    await expect(
      rpc('budget.report', {
        scope: { ...scope, revision: 99 },
        runId: job.id,
        attemptId: 'synthetic-wire',
        usage,
      }),
    ).rejects.toThrow();
    expect(ledger.view(scope!.budgetId).reported.inputTokens).toBe(0);
    expect(
      await rpc('budget.report', { scope, runId: job.id, attemptId: 'synthetic-wire', usage }),
    ).toMatchObject({ result: { accepted: true } });
    expect(ledger.view(scope!.budgetId).reported.inputTokens).toBe(8);
    await expect(rpc('tools/list', {})).rejects.toThrow();
    await models.start('mock-bot', {
      requestId: 'synthetic-retry',
      retryOf: job.id,
      prompt: 'Synthetic task',
    });
    const retry = models.jobs.get('mock-bot')!;
    expect(Reflect.get(retry, 'budget')).toEqual(scope);
    await retry.done;
    expect(ledger.view(scope!.budgetId).requests).toBe(1);
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retrying an old ancestor keeps later ledger usage and unknown attempts in the same budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-ancestor-'));
  let models: ModelRuns;
  let round = 0;
  class Harness {
    async start() {}
    async close() {}
    session() {
      return {
        id: 'synthetic-ancestor-session',
        run: async () => {
          const index = ++round;
          const job = models.jobs.get('mock-bot')!;
          const params = {
            scope: job.budget,
            modelAttemptId: job.attemptId,
            attemptId: `synthetic-wire-${index}`,
            requestHash: 'a'.repeat(64),
            rootSessionId: job.sessionId,
            sessionId: job.sessionId,
            purpose: 'main',
          };
          const rpc = (method: string, params: Record<string, unknown>) =>
            models.rpc(job.bot, `Bearer ${job.token}`, {
              id: `synthetic-${index}`,
              method,
              params,
            });
          await rpc('budget.reserve', params);
          await rpc('budget.dispatched', {
            scope: job.budget,
            modelAttemptId: job.attemptId,
            attemptId: params.attemptId,
          });
          await rpc('budget.report', {
            scope: job.budget,
            runId: job.id,
            attemptId: params.attemptId,
            usage:
              index === 2
                ? { state: 'unknown', reason: 'SYNTHETIC_INTERRUPTED' }
                : {
                    state: 'reported',
                    inputTokens: 10,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  },
          });
          return { sessionId: 'synthetic-ancestor-session', finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  models = new ModelRuns({
    dir: path.join(root, 'models'),
    workspace: path.join(root, 'workspace'),
    settings,
    Harness,
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.save({ apiKey: 'synthetic-ancestor-key' });
    await models.start('mock-bot', {
      requestId: 'synthetic-root-request',
      prompt: 'SYNTHETIC ROOT',
    });
    const first = models.jobs.get('mock-bot')!;
    await first.done;
    for (const requestId of ['synthetic-second', 'synthetic-old-ancestor']) {
      await models.start('mock-bot', { requestId, retryOf: first.id, prompt: 'SYNTHETIC ROOT' });
      await models.jobs.get('mock-bot')!.done;
    }
    const view = models.budgets.view(first.budget!.budgetId);
    expect(models.jobs.get('mock-bot')!.budget?.budgetId).toBe(first.budget!.budgetId);
    expect(view.requests).toBe(3);
    expect(view.unknownCount).toBe(1);
    expect(view.reported.inputTokens).toBe(20);
    expect(view.reservedTokens).toBeGreaterThan(0);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a trusted continuation pinned to an old budget revision cannot silently adopt a later quota', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-pinned-'));
  let runs = 0;
  class Harness {
    async start() {}
    async close() {}
    session() {
      return {
        id: 'synthetic-pinned-session',
        run: async () => {
          runs++;
          return { sessionId: 'synthetic-pinned-session', finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const models = new ModelRuns({
    dir: path.join(root, 'models'),
    workspace: path.join(root, 'workspace'),
    settings,
    Harness,
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.save({ apiKey: 'synthetic-pinned-key' });
    await models.start('mock-bot', {
      requestId: 'synthetic-pinned-root',
      prompt: 'SYNTHETIC TASK',
    });
    const first = models.jobs.get('mock-bot')!;
    await first.done;
    const view = models.budgets.view(first.budget!.budgetId);
    const raised = models.budgets.increase(
      view.scope.budgetId,
      1,
      view.policy,
      'synthetic-new-quota',
    );
    models.budgets.activate(raised.scope, 'synthetic-new-quota');
    await expect(
      models.start(
        'mock-bot',
        { requestId: 'synthetic-stale', retryOf: first.id, prompt: 'SYNTHETIC TASK' },
        undefined,
        view.scope,
      ),
    ).rejects.toThrow('BUDGET_REVISION_CONFLICT');
    expect(runs).toBe(1);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
