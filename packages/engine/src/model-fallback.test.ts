import type { DeliveryReference } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { canFallback, type FallbackInput, fallbackIssue } from './model-fallback.js';

const clean: FallbackInput = {
  enabled: true,
  attempts: 1,
  fence: 'clean',
  failure: 'auth',
  stopped: false,
  closed: true,
  inserted: false,
  eligible: true,
  budgetAvailable: true,
};
test('one fallback requires every clean-failure gate and never becomes a retry loop', () => {
  for (const failure of ['auth', 'quota', 'rate-limit', 'unavailable', 'timeout'] as const)
    expect(canFallback({ ...clean, failure })).toBe(true);
  for (const blocked of [
    { enabled: false },
    { attempts: 0 },
    { attempts: 2 },
    { fence: 'output' },
    { fence: 'tool' },
    { fence: 'unknown' },
    { failure: 'unknown' },
    { stopped: true },
    { closed: false },
    { inserted: true },
    { eligible: false },
    { budgetAvailable: false },
  ] satisfies Partial<FallbackInput>[])
    expect(canFallback({ ...clean, ...blocked })).toBe(false);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalComputerClient } from './local-computer.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import type { TaskRecord } from './tasks.js';

async function runScenario(
  scenario:
    | 'clean'
    | 'empty-goal-projection'
    | 'text'
    | 'cleared-text'
    | 'thinking'
    | 'tool'
    | 'insert'
    | 'shutdown'
    | 'two-failures'
    | 'revoked'
    | 'local-selection'
    | 'unknown-capability'
    | 'context'
    | 'context-queued'
    | 'context-queued-failure',
  plan?: ('plan' | 'text' | 'tool' | 'failure')[],
  plannedModel: 'mock-primary' | 'mock-fallback' = 'mock-primary',
  claimedDelivery = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-fallback-'));
  const starts: string[] = [];
  const order: string[] = [];
  const sessions: string[] = [];
  const rounds: string[] = [];
  const queuedContext = scenario === 'context-queued' || scenario === 'context-queued-failure';
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-primary' }, { id: 'mock-fallback' }] }),
  );
  let models: ModelRuns;
  let originalToken = '';
  let originalSession = '';
  const incomingPressure: unknown[] = [];
  const incomingBreakdown: unknown[] = [];
  const projections: unknown[] = [];
  let releaseCapture: (() => unknown) | undefined;
  let pendingContext: Promise<unknown> | undefined;
  const failure = {
    type: 'turn/end',
    data: {
      reason: { kind: 'error', error: { code: 'AUTH', message: 'Synthetic provider denial' } },
    },
  };
  class Harness {
    constructor(readonly options: { model: string }) {}
    async start() {
      starts.push(this.options.model);
      order.push(`start:${this.options.model}`);
      if (this.options.model === 'mock-fallback' && queuedContext) {
        releaseCapture?.();
        await pendingContext;
      }
    }
    async close() {
      order.push(`close:${this.options.model}`);
      if (scenario === 'shutdown' && this.options.model === 'mock-primary')
        throw new Error('Synthetic unconfirmed shutdown');
      const job = models.jobs.get('mock-bot');
      if (job?.token && !job.abort.signal.aborted)
        await models.rpc(job.bot, `Bearer ${job.token}`, {
          id: 'mock-drained',
          method: 'attempt.closed',
          params: { sessionId: job.sessionId, attemptId: job.attemptId, fence: 'clean' },
        });
    }
    session() {
      const id = `mock-session-${this.options.model}`;
      sessions.push(id);
      return {
        id,
        run: async (_input: unknown, observer: { onNotification: (note: unknown) => unknown }) => {
          rounds.push(this.options.model);
          const job = models.jobs.get('mock-bot')!;
          if (claimedDelivery) {
            const params = {
              scope: job.budget,
              modelAttemptId: job.attemptId,
              attemptId: `mock-wire-${rounds.length}`,
              requestHash: 'a'.repeat(64),
              rootSessionId: id,
              sessionId: id,
              purpose: 'main',
            };
            const rpc = (method: string, params: Record<string, unknown>) =>
              models.rpc(job.bot, `Bearer ${job.token}`, {
                id: `mock-budget-${rounds.length}`,
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
              usage: {
                state: 'reported',
                inputTokens: 5,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            });
          }
          const planned = async () => {
            const round = rounds.filter((model) => model === this.options.model).length;
            const step = plan?.[round - 1];
            if (!step) throw new Error('Unexpected synthetic plan continuation');
            if (step === 'text' || step === 'failure')
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: `mock-plan-output-${round}`,
                method: 'response.update',
                params: {
                  sessionId: id,
                  revision: round,
                  text: step === 'text' ? 'Synthetic earlier round output' : '',
                  state: 'streaming',
                },
              });
            if (step === 'tool')
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: `mock-plan-tool-${round}`,
                method: 'tools/call',
                params: { name: 'list_files', arguments: {} },
              });
            observer.onNotification({
              method: 'session.event',
              params: {
                sessionId: id,
                event: {
                  type: 'todo/write',
                  seq: round,
                  time: 1800000000000 + round,
                  data: { todos: [{ content: 'Synthetic pending work', status: 'in_progress' }] },
                },
              },
            });
            return {
              sessionId: id,
              finalResponse: step === 'text' ? 'Synthetic earlier round output' : '',
              ...(step === 'failure' ? { events: [failure] } : {}),
            };
          };
          if (this.options.model === 'mock-primary') {
            originalToken = job.token;
            originalSession = id;
            if (scenario === 'context' || queuedContext) {
              const update = (key: string, value: unknown) =>
                models.rpc(job.bot, `Bearer ${job.token}`, {
                  id: `mock-primary-${key}`,
                  method: 'context.update',
                  params: {
                    sessionId: id,
                    turnId: 'mock-fallback-request',
                    key,
                    seq: 7,
                    value,
                  },
                });
              if (queuedContext) {
                job.context!.writing = new Promise<unknown>((resolve, reject) => {
                  releaseCapture = () =>
                    scenario === 'context-queued-failure'
                      ? reject(new Error('Synthetic retired capture failure'))
                      : resolve(undefined);
                });
                pendingContext = update('contextPressure', { pressureTokens: 900 }).catch(
                  (error: unknown) => ({ error }),
                );
                await Promise.resolve();
                expect(job.context?.seqs.contextPressure).toBe(7);
              } else {
                await update('contextPressure', { pressureTokens: 900 });
                await update('contextBreakdown', {
                  systemTokens: 0,
                  toolsTokens: 0,
                  messageTokens: 700,
                });
              }
            }
            if (plan && plannedModel === this.options.model) return planned();
            if (scenario === 'text' || scenario === 'cleared-text' || scenario === 'thinking')
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: 1,
                method: 'response.update',
                params: {
                  sessionId: id,
                  revision: 1,
                  text:
                    scenario === 'text' || scenario === 'cleared-text'
                      ? 'Synthetic visible prefix'
                      : '',
                  state: 'streaming',
                  ...(scenario === 'thinking'
                    ? { thinking: { id: 'mock-thinking', text: 'Synthetic visible reasoning' } }
                    : {}),
                },
              });
            if (scenario === 'cleared-text')
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: 4,
                method: 'response.update',
                params: { sessionId: id, revision: 2, text: '', state: 'streaming' },
              });
            if (scenario === 'empty-goal-projection')
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: 5,
                method: 'goal.observe',
                params: { sessionId: id, goal: null },
              });
            if (scenario === 'tool')
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: 2,
                method: 'tools/call',
                params: { name: 'list_files', arguments: {} },
              });
            if (scenario === 'insert')
              await models.insert(job.bot, {
                id: 'mock-insert',
                text: 'Synthetic new intent',
                runId: job.id,
                chatRevision: 0,
              });
            if (scenario === 'revoked')
              await settings.configure({
                model: 'provider:mock-provider:mock-primary',
                apiKey: 'synthetic-revoked-key',
                revision: 2,
                requestId: 'mock-revoke-current-key',
              });
            return { sessionId: id, finalResponse: '', events: [failure] };
          }
          await expect(
            models.rpc(job.bot, `Bearer ${originalToken}`, {
              id: 3,
              method: 'response.update',
              params: {
                sessionId: originalSession,
                revision: 2,
                state: 'streaming',
                text: 'Synthetic stale prefix',
              },
            }),
          ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
          if (scenario === 'context' || queuedContext) {
            incomingPressure.push(structuredClone(job.context?.pressure));
            incomingBreakdown.push(structuredClone(job.context?.breakdown));
            const params = {
              sessionId: id,
              turnId: 'mock-fallback-request',
              key: 'contextPressure',
              seq: 0,
              value: { pressureTokens: 100 },
            };
            await expect(
              models.rpc(job.bot, `Bearer ${job.token}`, {
                id: 'mock-retired-root',
                method: 'context.update',
                params: { ...params, sessionId: originalSession },
              }),
            ).rejects.toMatchObject({ code: 'INVALID_CONTEXT_UPDATE' });
            projections.push(
              await models.rpc(job.bot, `Bearer ${job.token}`, {
                id: 'mock-fallback-projection',
                method: 'context.update',
                params,
              }),
            );
          }
          if (plan && plannedModel === this.options.model) return planned();
          return {
            sessionId: id,
            finalResponse: scenario === 'two-failures' ? '' : 'Synthetic fallback reply',
            ...(scenario === 'two-failures' ? { events: [failure] } : {}),
          };
        },
      };
    }
    async resumeSession(): Promise<never> {
      throw new Error('A fallback must never resume the primary native session');
    }
  }
  try {
    await settings.configure({
      revision: 0,
      requestId: 'mock-primary-config',
      apiKey: 'synthetic-model-key',
      model: 'provider:mock-provider:mock-primary',
      connection: {
        id: 'mock-provider',
        name: 'Synthetic provider',
        baseURL: 'https://models.example.test/v1',
        models: ['mock-primary', 'mock-fallback'].map((id) => ({
          id,
          name: id,
          vision: true,
          contextWindow: 64000,
          maxTokens: 4096,
          ...(scenario === 'unknown-capability' ? {} : { capabilities: { toolCall: true } }),
        })),
      },
    });
    await settings.fallback({
      scope: (await settings.status(true)).modelAccess!.scope,
      revision: 1,
      requestId: 'mock-fallback-config',
      model: 'provider:mock-provider:mock-fallback',
    });
    const localComputer =
      scenario === 'local-selection' ? new LocalComputerClient(root) : undefined;
    if (localComputer) {
      vi.spyOn(localComputer, 'selected').mockReturnValue(true);
      vi.spyOn(localComputer, 'prepare').mockResolvedValue(true);
      vi.spyOn(localComputer, 'cancel').mockResolvedValue(undefined);
    }
    models = new ModelRuns({
      settings,
      Harness,
      dir: path.join(root, 'model'),
      workspace: path.join(root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
      localComputer,
    });
    const task = {
      requestId: 'mock-fallback-request',
      prompt: 'Synthetic accepted input',
      files: [{ name: 'mock-input.txt', content: 'Synthetic attachment' }],
    };
    let delivery: DeliveryReference | undefined;
    if (claimedDelivery) {
      await models.work.write(
        {
          id: 'mock-work-create',
          item: 'mock-work',
          revision: 0,
          action: 'create',
          value: {
            title: 'Synthetic fallback delivery',
            description: '',
            progress: '',
            status: 'todo',
          },
        },
        { kind: 'human' },
      );
      const receipt = await models.work.deliveryEffect((store) =>
        store.start({
          requestId: task.requestId,
          workId: 'mock-work',
          workRevision: 1,
          checklistRevision: 0,
          bot: 'mock-bot',
        }),
      );
      expect.assert(receipt.state === 'complete' && 'attempt' in receipt);
      delivery = {
        workId: receipt.attempt.workId,
        attemptId: receipt.attempt.attemptId,
        requestId: receipt.attempt.requestId,
      };
    }
    const accepted = delivery
      ? await models.startHuman('mock-bot', task, undefined, undefined, { delivery })
      : await models.start('mock-bot', task);
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    const record = await models.journal.read(job.bot, job.id);
    return {
      accepted,
      result: models.status().bots['mock-bot'],
      record,
      starts,
      order,
      sessions,
      rounds,
      incomingPressure,
      incomingBreakdown,
      projections,
      toolCount: job.toolCount,
      delivery,
      budget: job.budget && models.budgets.view(job.budget.budgetId),
      settings: await settings.status(true),
    };
  } finally {
    releaseCapture?.();
    await pendingContext;
    if (models!) await models.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

for (const scenario of ['context', 'context-queued', 'context-queued-failure'] as const)
  test(`${scenario} cannot carry SDK samples or queued captures into a fallback attempt`, async () => {
    const result = await runScenario(scenario);
    expect(result.result.phase, result.result.error).toBe('completed');
    expect(result.starts).toEqual(['mock-primary', 'mock-fallback']);
    expect(result.incomingPressure).toEqual([undefined]);
    expect(result.incomingBreakdown).toEqual([undefined]);
    expect(result.projections).toMatchObject([{ result: { accepted: true } }]);
    const captures = result.record?.contextCaptures?.captures ?? [];
    const turns = captures.filter((capture) => capture.reason === 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1].pressure).toBeUndefined();
    expect(turns[1].breakdown).toBeUndefined();
    expect(captures.at(-1)?.pressure).toMatchObject({ seq: 0, pressureTokens: 100 });
    expect(captures.at(-1)?.breakdown).toBeUndefined();
    if (scenario !== 'context')
      expect(captures.some((capture) => capture.pressure?.seq === 7)).toBe(false);
    else expect(captures.some((capture) => capture.pressure?.seq === 7)).toBe(true);
    if (scenario === 'context-queued-failure') {
      expect(result.record?.contextCaptureFailed).toBe(true);
      expect(captures.at(-1)?.gaps).toContain('capture-failed');
    }
  });

test('clean provider failure closes the primary and succeeds once inside the original task and receipt', async () => {
  const result = await runScenario('clean');
  expect(result.starts).toEqual(['mock-primary', 'mock-fallback']);
  expect(result.order.indexOf('close:mock-primary')).toBeLessThan(
    result.order.indexOf('start:mock-fallback'),
  );
  expect(result.result).toMatchObject({
    phase: 'completed',
    runId: result.accepted.runId,
    requestId: 'mock-fallback-request',
    result: 'Synthetic fallback reply',
    model: 'provider:mock-provider:mock-fallback',
    attemptSummary: [
      {
        model: 'provider:mock-provider:mock-primary',
        phase: 'failed',
        fence: 'clean',
        failure: 'auth',
        usage: 'unknown',
      },
      { model: 'provider:mock-provider:mock-fallback', phase: 'completed' },
    ],
  });
  expect(result.settings.model).toBe('provider:mock-provider:mock-primary');
  expect(result.record).toHaveProperty('attemptSummary');
  expect(result.record?.inputs).toContain('mock-input.txt');
});

for (const scenario of [
  'text',
  'cleared-text',
  'thinking',
  'tool',
  'insert',
  'shutdown',
  'revoked',
  'unknown-capability',
] as const)
  test(`${scenario} closes the automatic fallback window`, async () => {
    const result = await runScenario(scenario);
    expect(result.starts).toEqual(['mock-primary']);
    expect(result.result.phase).toBe('failed');
    if (scenario === 'text' || scenario === 'cleared-text')
      expect(result.result.response?.text).toBe('Synthetic visible prefix');
  });

test('two failed providers produce at most two attempts and one failed task', async () => {
  const result = await runScenario('two-failures');
  expect(result.starts).toEqual(['mock-primary', 'mock-fallback']);
  expect(result.result.phase).toBe('failed');
  expect(result.result.runId).toBe(result.accepted.runId);
});

test('a model-bound local desktop grant prevents automatic model switching', async () => {
  const result = await runScenario('local-selection');
  expect(result.starts).toEqual(['mock-primary']);
  expect(result.result).toMatchObject({ phase: 'failed', error: 'LOCAL_MODEL_CHANGED' });
  expect(result.record?.attemptSummary).toHaveLength(1);
});

for (const activity of ['text', 'tool'] as const)
  for (const preceding of [[], ['plan']] satisfies 'plan'[][])
    test(`plan continuation preserves ${activity} from ${preceding.length ? 'an intermediate' : 'the first'} round before a later failure`, async () => {
      const result = await runScenario('clean', [...preceding, activity, 'failure']);
      expect(result.rounds).toEqual(Array(preceding.length + 2).fill('mock-primary'));
      expect(result.starts).toEqual(['mock-primary']);
      expect(result.result).toMatchObject({
        phase: 'failed',
        runId: result.accepted.runId,
        requestId: 'mock-fallback-request',
        attemptSummary: [
          { fence: activity === 'text' && !preceding.length ? 'output' : 'tool', failure: 'auth' },
        ],
      });
      if (activity === 'text')
        expect(result.result.response?.text).toBe('Synthetic earlier round output');
      expect(result.toolCount).toBe(activity === 'tool' ? 1 : 0);
      expect(result.record?.attemptSummary).toHaveLength(1);
    });

for (const beforeFailure of [[], ['plan']] satisfies 'plan'[][])
  test(`a structured failure in plan round ${beforeFailure.length + 1} is checked before another continuation`, async () => {
    const result = await runScenario('clean', [...beforeFailure, 'failure']);
    expect(result.rounds).toEqual(Array(beforeFailure.length + 1).fill('mock-primary'));
    expect(result.starts).toEqual(['mock-primary']);
    expect(result.result).toMatchObject({
      phase: 'failed',
      runId: result.accepted.runId,
      requestId: 'mock-fallback-request',
      attemptSummary: [{ failure: 'auth', fence: 'tool' }],
    });
  });

test('a fallback plan continuation failure cannot open a third provider attempt', async () => {
  const result = await runScenario('clean', ['plan', 'failure'], 'mock-fallback');
  expect(result.rounds).toEqual(['mock-primary', 'mock-fallback', 'mock-fallback']);
  expect(result.starts).toEqual(['mock-primary', 'mock-fallback']);
  expect(result.result).toMatchObject({ phase: 'failed', runId: result.accepted.runId });
  expect(result.record?.attemptSummary).toHaveLength(2);
});

test('an explicit continuation cannot replay an earlier unknown tool outcome', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-unknown-recovery-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-session') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'Synthetic new work' }) };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.save({ apiKey: 'synthetic-recovery-key' });
    await models.ready;
    const outputDirectory = path.join(root, 'workspace', 'model-runs', 'mock-prior', 'mock-bot');
    await mkdir(outputDirectory, { recursive: true });
    await models.journal.put({
      bot: 'mock-bot',
      runId: 'mock-prior',
      intentId: 'mock-prior',
      requestId: 'mock-prior-request',
      prompt: 'Synthetic original work',
      result: '',
      error: 'MCP_OUTCOME_UNKNOWN',
      phase: 'failed',
      running: false,
      outputDirectory,
      inputs: [],
      trace: [
        {
          name: 'mock_external_action',
          surface: 'integration',
          phase: 'rejected',
          code: 'MCP_OUTCOME_UNKNOWN',
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    await expect(
      models.start('mock-bot', {
        requestId: 'mock-continue',
        prompt: 'Synthetic original work',
        retryOf: 'mock-prior',
      }),
    ).rejects.toMatchObject({ code: 'TASK_OUTCOME_UNKNOWN' });
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty initial goal projection is observation rather than a new tool or goal intent', async () => {
  const result = await runScenario('empty-goal-projection');
  expect(result.starts).toEqual(['mock-primary', 'mock-fallback']);
  expect(result.result.phase).toBe('completed');
});

for (const budget of [
  { toolCount: 60, elapsedMs: 0, error: 'TOOL_LIMIT' },
  { toolCount: 0, elapsedMs: 300001, error: 'MODEL_TIME_LIMIT' },
])
  test(`explicit continuation retains the logical task's ${budget.error} boundary`, async () => {
    const { mkdir } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-root-budget-'));
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    class Harness {
      async start() {}
      async close() {}
      session(id = 'mock-session') {
        return { id, run: async () => ({ sessionId: id, finalResponse: 'Synthetic reply' }) };
      }
      async resumeSession(id: string) {
        return this.session(id);
      }
    }
    const models = new ModelRuns({
      settings,
      Harness,
      dir: path.join(root, 'model'),
      workspace: path.join(root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    });
    try {
      await settings.save({ apiKey: 'synthetic-root-budget-key' });
      await models.ready;
      const outputDirectory = path.join(root, 'workspace', 'model-runs', 'mock-prior', 'mock-bot');
      await mkdir(outputDirectory, { recursive: true });
      await models.journal.put({
        bot: 'mock-bot',
        runId: 'mock-prior',
        intentId: 'mock-root',
        prompt: 'Synthetic task',
        result: '',
        error: '',
        phase: 'failed',
        running: false,
        outputDirectory,
        inputs: [],
        trace: [],
        toolCount: budget.toolCount,
        elapsedMs: budget.elapsedMs,
      });
      await expect(
        models.start('mock-bot', {
          requestId: 'mock-continue-budget',
          prompt: 'Synthetic task',
          retryOf: 'mock-prior',
        }),
      ).rejects.toMatchObject({ code: budget.error });
    } finally {
      await models.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test('fallback qualification explains the exact missing input, context or tool capability', () => {
  const route = {
    vision: true,
    contextWindow: 64000,
    maxTokens: 4096,
    capabilities: { toolCall: true },
  };
  const required = { vision: true, tools: true, contextTokens: 2048 };
  expect(fallbackIssue(route, required)).toBeUndefined();
  expect(fallbackIssue({ ...route, vision: false }, required)).toBe(
    'MODEL_FALLBACK_VISION_REQUIRED',
  );
  expect(fallbackIssue({ ...route, contextWindow: 4096 }, required)).toBe(
    'MODEL_FALLBACK_CONTEXT_REQUIRED',
  );
  expect(fallbackIssue({ ...route, capabilities: { toolCall: false } }, required)).toBe(
    'MODEL_FALLBACK_TOOLS_REQUIRED',
  );
  expect(fallbackIssue({ ...route, capabilities: undefined }, required)).toBe(
    'MODEL_FALLBACK_TOOLS_UNKNOWN',
  );
});

for (const scenario of [
  { name: 'tool budget', following: { toolCount: 60 }, error: 'TOOL_LIMIT' },
  {
    name: 'legacy trace activity',
    following: {
      toolCount: undefined,
      executedCount: undefined,
      trace: Array.from({ length: 58 }, () => ({
        name: 'write_file',
        surface: 'workspace',
        phase: 'settled',
        at: '2026-01-01T00:00:00.000Z',
      })),
    },
    error: 'TOOL_LIMIT',
  },
  { name: 'active time', following: { activeMs: 300001 }, error: 'MODEL_TIME_LIMIT' },
  { name: 'chat scope', following: {}, renew: true, error: 'CHAT_REVISION_REQUIRED' },
  {
    name: 'unknown effect',
    following: {
      trace: [
        {
          name: 'mock-effect',
          surface: 'integration',
          phase: 'rejected',
          code: 'MCP_OUTCOME_UNKNOWN',
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    error: 'TASK_OUTCOME_UNKNOWN',
  },
  { name: 'known contributions', following: {} },
] satisfies { name: string; following: Partial<TaskRecord>; error?: string; renew?: boolean }[])
  test(`canonical root retains ${scenario.name} when retryOf names an older ancestor`, async () => {
    const { mkdir } = await import('node:fs/promises');
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-canonical-root-'));
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    class Harness {
      async start() {}
      async close() {}
      session(id = 'mock-root-session') {
        return {
          id,
          run: async () => ({ sessionId: id, finalResponse: 'Synthetic continued reply' }),
        };
      }
      async resumeSession(id: string) {
        return this.session(id);
      }
    }
    const options = {
      settings,
      Harness,
      dir: path.join(root, 'model'),
      workspace: path.join(root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    };
    let models = new ModelRuns(options);
    try {
      await settings.save({ apiKey: 'synthetic-canonical-key' });
      await models.ready;
      const directory = async (id: string) => {
        const target = path.join(root, 'workspace', 'model-runs', id, 'mock-bot');
        await mkdir(target, { recursive: true });
        return target;
      };
      const prior: TaskRecord = {
        bot: 'mock-bot',
        runId: '1700000000000-root',
        intentId: '1700000000000-root',
        prompt: 'Synthetic root input',
        phase: 'failed',
        running: false,
        result: '',
        error: '',
        trace: [],
        inputs: [],
        toolCount: 2,
        activeMs: 100,
        outputDirectory: await directory('1700000000000-root'),
      };
      await models.journal.put(prior);
      await models.journal.put({
        ...prior,
        runId: '1700000000001-descendant',
        toolCount: 3,
        activeMs: 200,
        outputDirectory: await directory('1700000000001-descendant'),
        ...scenario.following,
      });
      const request = {
        requestId: 'mock-old-ancestor',
        prompt: prior.prompt,
        retryOf: prior.runId,
      };
      if ('renew' in scenario)
        await models.chats.renew({ id: 'mock-new-chat', bot: 'mock-bot', revision: 0 });
      if ('error' in scenario) {
        await expect(models.start('mock-bot', request)).rejects.toMatchObject({
          code: scenario.error,
        });
        expect(models.jobs.size).toBe(0);
      } else {
        const accepted = await models.start('mock-bot', request);
        const first = models.jobs.get('mock-bot')!;
        await first.done;
        expect(first.toolCount).toBe(5);
        expect(first.intentId).toBe(prior.intentId);
        expect((await models.journal.read('mock-bot', first.id))?.toolCount).toBe(0);
        expect((await models.start('mock-bot', request)).runId).toBe(accepted.runId);
        await models.start('mock-bot', { ...request, requestId: 'mock-another-ancestor' });
        const second = models.jobs.get('mock-bot')!;
        await second.done;
        expect(second.toolCount).toBe(5);
        expect(second.activeMs).toBeGreaterThanOrEqual(300);
        expect(second.intentId).toBe(prior.intentId);
        await models.close();
        models = new ModelRuns(options);
        await models.ready;
        expect(models.jobs.get('mock-bot')?.toolCount).toBe(5);
        await models.start('mock-bot', { ...request, requestId: 'mock-restarted-ancestor' });
        const restarted = models.jobs.get('mock-bot')!;
        await restarted.done;
        expect(restarted.toolCount).toBe(5);
        expect(restarted.intentId).toBe(prior.intentId);
      }
    } finally {
      await models.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test('delivery fallback retains one Work claim and cumulative budget while physical attempts rotate', async () => {
  const result = await runScenario('clean', undefined, 'mock-primary', true);
  expect(result.starts).toEqual(['mock-primary', 'mock-fallback']);
  expect(result.record?.delivery).toEqual(result.delivery);
  expect(result.record?.attemptSummary).toHaveLength(2);
  expect(
    result.record?.attemptSummary?.every(
      (attempt) => attempt.attemptId !== result.delivery?.attemptId,
    ),
  ).toBe(true);
  expect(result.budget).toMatchObject({
    requests: 2,
    reported: { inputTokens: 10, outputTokens: 2 },
  });
  expect(result.record?.budget).toEqual(result.budget?.scope);
});
