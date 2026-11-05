import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type AutomationSource,
  type DeliveryReference,
  isDeliveryPage,
  isDeliveryReceipt,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { Delivery } from './delivery.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

const automation: AutomationSource = {
  scheduleId: 'mock-schedule',
  firingId: 'mock-firing',
  configRevision: 1,
  trigger: 'manual',
  policy: { kind: 'all' },
};
async function fixture(held = false, metered = false) {
  let release = () => {};
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-origins-'));
  let calls = 0;
  let starts = 0;
  class Harness {
    constructor(readonly options: { dshHome: string }) {}
    async start() {
      starts++;
    }
    async close() {
      release();
    }
    session() {
      return {
        id: 'mock-origin-session',
        run: async () => {
          calls++;
          const bot = path.basename(this.options.dshHome);
          const job = models.jobs.get(bot);
          expect.assert(job?.budget);
          if (metered) {
            const params = {
              scope: job.budget,
              modelAttemptId: job.attemptId,
              attemptId: `mock-wire-${calls}`,
              requestHash: 'a'.repeat(64),
              rootSessionId: job.sessionId,
              sessionId: job.sessionId,
              purpose: 'main',
            };
            const rpc = (method: string, params: Record<string, unknown>) =>
              models.rpc(bot, `Bearer ${job.token}`, { id: `mock-rpc-${calls}`, method, params });
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
                inputTokens: 7,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            });
          }
          if (held && bot === 'mock-bot') await gate;
          return { sessionId: 'mock-origin-session', finalResponse: 'Synthetic delivery result' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const settings = new ModelSettings(path.join(root, 'settings.json'));
  const files = new WorkspaceFiles(path.join(root, 'workspace'));
  const open = () =>
    new ModelRuns({
      dir: path.join(root, 'models'),
      workspace: files,
      settings,
      Harness,
      origin: 'http://127.0.0.1:12345',
    });
  let models = open();
  await models.ready;
  await settings.save({ apiKey: 'mock-origin-secret' });
  await models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  await models.work.write(
    {
      id: 'mock-create',
      item: 'mock-work',
      revision: 0,
      action: 'create',
      value: {
        title: 'Synthetic delivery',
        description: '',
        progress: '',
        status: 'todo',
        assignee: 'mock-bot',
      },
    },
    { kind: 'human' },
  );
  const request = {
    requestId: 'mock-start',
    workId: 'mock-work',
    workRevision: 1,
    checklistRevision: 0,
    bot: 'mock-bot',
  };
  return {
    settings,
    release: () => release(),
    get starts() {
      return starts;
    },
    get models() {
      return models;
    },
    files,
    request,
    get calls() {
      return calls;
    },
    delivery: () => new Delivery(models, undefined, files),
    async claim() {
      const result = await models.work.deliveryEffect((store) => store.start(request));
      expect.assert(result.state === 'complete' && 'attempt' in result);
      return {
        workId: result.attempt.workId,
        attemptId: result.attempt.attemptId,
        requestId: result.attempt.requestId,
      };
    },
    async reopen() {
      await models.close();
      models = open();
      await models.ready;
    },
    async close() {
      release();
      await models.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function trustedStart(
  models: ModelRuns,
  requestId: string,
  delivery: DeliveryReference,
  origin = automation,
) {
  return Reflect.apply(models.startHuman, models, [
    'mock-bot',
    { requestId, prompt: 'Synthetic origin task' },
    undefined,
    undefined,
    { delivery, automation: origin },
  ]) as Promise<unknown>;
}

test('delivery commits its immutable Work claim before the canonical Human start and budget', async () => {
  const f = await fixture();
  try {
    const original = f.models.startHuman.bind(f.models);
    const human = vi.spyOn(f.models, 'startHuman').mockImplementation(async (...args) => {
      const page = await f.models.work.deliveryPage({ workId: 'mock-work' });
      expect(page.attempts[0]).toMatchObject({
        phase: 'accepted',
        title: 'Synthetic delivery',
        workRevision: 1,
      });
      return original(...args);
    });
    await f.delivery().command({ type: 'delivery.start', request: f.request });
    expect(human).toHaveBeenCalledTimes(1);
    const job = f.models.jobs.get('mock-bot');
    expect.assert(job?.budget && job.delivery);
    await job.done;
    expect(job.delivery.attemptId).not.toBe(job.attemptId);
    expect(f.models.budgets.goals.epoch({ bot: 'mock-bot', chatRevision: job.chatRevision })).toBe(
      1,
    );
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
});

test('independent delivery and firing provenance survive fingerprint replay, journal and restart', async () => {
  const f = await fixture();
  try {
    const reference = await f.claim();
    await trustedStart(f.models, f.request.requestId, reference);
    const job = f.models.jobs.get('mock-bot');
    expect.assert(job?.budget);
    await job.done;
    const budget = structuredClone(job.budget);
    expect(f.models.findRequest('mock-bot', f.request.requestId)).toMatchObject({
      delivery: reference,
      automation,
      budget,
    });
    await f.reopen();
    await trustedStart(f.models, f.request.requestId, reference);
    expect(f.calls).toBe(1);
    expect(f.models.findRequest('mock-bot', f.request.requestId)).toMatchObject({
      delivery: reference,
      automation,
      budget,
    });
    await expect(
      trustedStart(f.models, f.request.requestId, { ...reference, attemptId: 'mock-other' }),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    await expect(
      trustedStart(f.models, f.request.requestId, reference, {
        ...automation,
        firingId: 'mock-other-firing',
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
});

test('public task fields and manual firing provenance cannot mint Human or an uncommitted Work claim', async () => {
  const f = await fixture();
  try {
    const forged = {
      workId: 'mock-work',
      attemptId: 'mock-unclaimed',
      requestId: f.request.requestId,
    };
    await expect(trustedStart(f.models, f.request.requestId, forged)).rejects.toMatchObject({
      code: 'DELIVERY_START_REQUIRED',
    });
    await expect(
      f.models.start('mock-bot', {
        requestId: 'mock-forged-task',
        prompt: '/goal resume',
        human: true,
        delivery: forged,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TASK' });
    await expect(
      Reflect.apply(f.models.start, f.models, [
        'mock-bot',
        { requestId: 'mock-manual-firing', prompt: '/goal resume' },
        undefined,
        { automation },
      ]),
    ).rejects.toMatchObject({ code: 'GOAL_HUMAN_COMMAND_REQUIRED' });
    expect(f.calls).toBe(0);
    expect((await f.models.work.deliveryPage({ workId: 'mock-work' })).attempts).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const action of ['accept', 'reject', 'stop', 'close-unknown'] as const)
  test(`a ${action} delivery cannot resume through ordinary retry, trusted retry or Human Goal`, async () => {
    const f = await fixture(action === 'stop');
    try {
      await f.delivery().command({ type: 'delivery.start', request: f.request });
      const job = f.models.jobs.get('mock-bot');
      expect.assert(job?.budget);
      if (action !== 'stop') await job.done;
      else await vi.waitFor(() => expect(f.calls).toBe(1));
      const page = await f
        .delivery()
        .command({ type: 'delivery.get', query: { workId: 'mock-work' } });
      expect.assert(isDeliveryPage(page));
      let attempt = page.attempts[0];
      if (action === 'close-unknown')
        attempt = await f.models.work.deliveryObserve((store) =>
          store.project(
            attempt.workId,
            attempt.attemptId,
            attempt.revision,
            {
              phase: 'unknown',
              error: 'SYNTHETIC_LOST_RECEIPT',
              results: attempt.results,
              outputs: attempt.outputs,
              groups: [],
            },
            true,
          ),
        );
      const target = {
        workId: attempt.workId,
        workRevision: attempt.ownershipRevision,
        attemptId: attempt.attemptId,
        attemptRevision: attempt.revision,
        requestId: `mock-${action}`,
      };
      const result = await f.delivery().command(
        action === 'stop'
          ? { type: 'delivery.stop', request: target }
          : {
              type: 'delivery.decide',
              request: {
                ...target,
                action,
                checked: [],
                reason: 'Synthetic review reason',
                confirmed: true,
              },
            },
      );
      expect(isDeliveryReceipt(result)).toBe(true);
      const reference = {
        workId: attempt.workId,
        attemptId: attempt.attemptId,
        requestId: attempt.requestId,
      };
      const retry = { requestId: 'mock-retry', prompt: 'Synthetic retry', retryOf: job.id };
      await expect(f.models.startHuman('mock-bot', retry)).rejects.toMatchObject({
        code: 'DELIVERY_START_REQUIRED',
      });
      await expect(
        Reflect.apply(f.models.startHuman, f.models, [
          'mock-bot',
          retry,
          undefined,
          job.budget,
          { delivery: reference },
        ]),
      ).rejects.toMatchObject({ code: 'DELIVERY_START_REQUIRED' });
      await expect(
        f.models.startHuman('mock-bot', {
          ...retry,
          requestId: 'mock-project-bypass',
          project: { projectId: 'mock-other-project', revision: 1 },
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_START_REQUIRED' });
      const view = f.models.budgets.view(job.budget.budgetId);
      const raised = f.models.budgets.increase(
        view.scope.budgetId,
        view.scope.revision,
        { ...view.policy, toolLimit: view.policy.toolLimit + 1 },
        `mock-increase-${action}`,
      );
      await expect(
        f.models.startHuman(
          'mock-bot',
          { ...retry, requestId: 'mock-raised-bypass' },
          undefined,
          raised.scope,
          { delivery: reference },
        ),
      ).rejects.toMatchObject({ code: 'DELIVERY_START_REQUIRED' });
      const record = await f.models.journal.read('mock-bot', job.id);
      expect.assert(record);
      const owner = { bot: 'mock-bot', chatRevision: job.chatRevision ?? 0 };
      const goal = {
        id: 'mock-goal',
        revision: 1,
        objective: 'Synthetic goal',
        phase: 'paused' as const,
        activation: 'disarmed' as const,
        rounds: 1,
        limit: 3,
      };
      await f.models.journal.put({
        ...record,
        sessionId: 'mock-origin-session',
        goal,
        goalSession: true,
      });
      f.models.budgets.goals.observe(owner, 'mock-origin-session', goal, raised.scope, true);
      const resume = await f.models.goalTarget(owner);
      await expect(
        f.models.startHuman('mock-bot', {
          requestId: 'mock-goal-resume',
          prompt: '/goal resume',
          goalResume: resume,
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_START_REQUIRED' });
      expect(f.calls).toBe(1);
    } finally {
      await f.close();
    }
  });

test('a retired Work claim during asynchronous preparation cannot start a physical model attempt', async () => {
  const f = await fixture();
  try {
    const capture = f.settings.capture.bind(f.settings);
    vi.spyOn(f.settings, 'capture').mockImplementationOnce(async (...args) => {
      const page = await f.models.work.deliveryPage({ workId: 'mock-work' });
      const claim = page.attempts[0];
      await f.models.work.deliveryObserve((store) =>
        store.project(claim.workId, claim.attemptId, claim.revision, {
          phase: 'failed',
          error: 'SYNTHETIC_RETIRED_CLAIM',
          results: [],
          outputs: [],
          groups: [],
        }),
      );
      return capture(...args);
    });
    await f.delivery().command({ type: 'delivery.start', request: f.request });
    const job = f.models.jobs.get('mock-bot');
    expect.assert(job);
    await job.done;
    expect(f.starts).toBe(0);
    expect(f.calls).toBe(0);
    expect(job.error).toBe('DELIVERY_START_REQUIRED');
  } finally {
    await f.close();
  }
});

test('malformed persisted delivery provenance is quarantined rather than downgraded into an ordinary retry', async () => {
  const f = await fixture();
  try {
    await f.delivery().command({ type: 'delivery.start', request: f.request });
    const job = f.models.jobs.get('mock-bot');
    expect.assert(job);
    await job.done;
    const record = await f.models.journal.read('mock-bot', job.id);
    expect.assert(record);
    await writeFile(
      path.join(f.models.journal.dir, `${job.id}.json`),
      JSON.stringify({
        version: 1,
        task: { ...record, delivery: { ...record.delivery, human: true } },
      }),
    );
    await f.reopen();
    await expect(
      f.models.startHuman('mock-bot', { requestId: record.requestId, prompt: record.prompt }),
    ).rejects.toMatchObject({ code: 'TASK_OUTCOME_UNKNOWN' });
    await expect(
      f.models.startHuman('mock-bot', {
        requestId: 'mock-corrupt-retry',
        prompt: 'Synthetic retry',
        retryOf: job.id,
      }),
    ).rejects.toThrow();
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
});

test('real group children retain the original delivery, firing and cumulative budget across a Groups restart', async () => {
  const f = await fixture(true, true);
  let groups: Groups | undefined;
  const file = path.join(f.models.dir, 'origin-groups.sqlite');
  const open = () =>
    new Groups(file, {
      member: (bot) => f.models.profiles.get(bot),
      source: (bot, run, group) => f.models.groupSource(bot, run, group),
      budget: (group, source) => f.models.groupBudget(group, source),
      running: (bot) => f.models.running(bot),
      findRequest: (bot, request) => f.models.findRequest(bot, request),
      start: (bot, task, scope, origin) => f.models.start(bot, task, scope, origin),
      stopRequest: (bot, request, scope) => f.models.stopRequest(bot, request, scope),
    });
  try {
    await f.models.profiles.register({
      id: 'mock-peer',
      name: 'Synthetic peer',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const delivery = await f.claim();
    await trustedStart(f.models, f.request.requestId, delivery);
    await vi.waitFor(() => expect(f.calls).toBe(1));
    const root = f.models.jobs.get('mock-bot');
    expect.assert(root?.budget);
    const budget = structuredClone(root.budget);
    groups = open();
    await groups.ready;
    const created = await groups.collaborate(
      { bot: 'mock-bot', runId: root.id },
      {
        name: 'Synthetic delivery group',
        members: ['mock-peer'],
        message: 'Synthetic shared task',
      },
    );
    await groups.close();
    groups = open();
    await groups.ready;
    f.release();
    await root.done;
    await groups.tick();
    const peer = f.models.jobs.get('mock-peer');
    expect.assert(peer);
    await peer.done;
    expect(peer).toMatchObject({ delivery, automation, budget });
    await groups.close();
    groups = open();
    await groups.ready;
    expect(f.calls).toBe(2);
    await groups.tick();
    const summary = f.models.jobs.get('mock-bot');
    expect.assert(summary && summary.id !== root.id);
    await summary.done;
    await groups.tick();
    expect(summary).toMatchObject({ delivery, automation, budget });
    expect(summary.attemptId).not.toBe(root.attemptId);
    expect(f.models.budgets.view(budget.budgetId)).toMatchObject({
      requests: 3,
      reported: { inputTokens: 21, outputTokens: 3 },
    });
    expect((await groups.deliveryProgress(delivery))[0]).toMatchObject({
      groupId: created.group.id,
      state: 'completed',
    });
    expect(f.calls).toBe(3);
  } finally {
    await groups?.close();
    await f.close();
  }
});

test('a trusted group Goal continuation keeps its canonical active Work claim and budget', async () => {
  const f = await fixture();
  try {
    const delivery = await f.claim();
    const scope = {
      id: 'mock-goal-group',
      sourceId: 'mock-group-turn',
      context: 'Synthetic accepted group stage',
    };
    await f.models.startHuman(
      'mock-bot',
      { requestId: f.request.requestId, prompt: 'Synthetic group goal' },
      scope,
      undefined,
      { automation, delivery },
    );
    const first = f.models.jobs.get('mock-bot');
    expect.assert(first?.budget);
    await first.done;
    const record = await f.models.journal.read('mock-bot', first.id);
    expect.assert(record);
    const owner = { bot: 'mock-bot', conversationId: scope.id };
    const goal = {
      id: 'mock-current-goal',
      revision: 1,
      objective: 'Synthetic current goal',
      phase: 'paused' as const,
      activation: 'disarmed' as const,
      rounds: 1,
      limit: 3,
    };
    await f.models.journal.put({ ...record, goalSession: true, goal });
    f.models.budgets.goals.observe(owner, record.sessionId!, goal, first.budget, true);
    const target = await f.models.goalTarget(owner);
    await f.models.startHuman(
      'mock-bot',
      { requestId: 'mock-active-goal', prompt: '/goal resume', goalResume: target },
      scope,
      first.budget,
      { automation, delivery },
    );
    const next = f.models.jobs.get('mock-bot');
    expect.assert(next);
    await next.done;
    expect(next).toMatchObject({ budget: first.budget, delivery, automation });
    expect(f.models.budgets.runs(first.budget.budgetId)).toHaveLength(2);
    expect(f.calls).toBe(2);
  } finally {
    await f.close();
  }
});

test('a trusted root retry still needs a fresh Work claim rather than replacing its frozen root request', async () => {
  const f = await fixture();
  try {
    const delivery = await f.claim();
    await trustedStart(f.models, f.request.requestId, delivery);
    const first = f.models.jobs.get('mock-bot');
    expect.assert(first?.budget);
    await first.done;
    await expect(
      f.models.startHuman(
        'mock-bot',
        { requestId: 'mock-replacement-root', prompt: 'Synthetic retry', retryOf: first.id },
        undefined,
        first.budget,
        { automation, delivery },
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_START_REQUIRED' });
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
});

test('a group source snapshot cannot mutate the running Model owner delivery reference', async () => {
  const f = await fixture(true);
  try {
    const delivery = await f.claim();
    await trustedStart(f.models, f.request.requestId, delivery);
    await vi.waitFor(() => expect(f.calls).toBe(1));
    const job = f.models.jobs.get('mock-bot');
    expect.assert(job);
    const source = f.models.groupSource(job.bot, job.id);
    expect.assert(source?.delivery);
    source.delivery.workId = 'mock-mutated-snapshot';
    expect(job.delivery).toEqual(delivery);
    expect(f.models.groupSource(job.bot, job.id)?.delivery).toEqual(delivery);
  } finally {
    await f.close();
  }
});

test('a budget revision changed during delivery preparation cannot dispatch against the old scope', async () => {
  const f = await fixture(false, true);
  try {
    const capture = f.settings.capture.bind(f.settings);
    vi.spyOn(f.settings, 'capture').mockImplementationOnce(async (...args) => {
      const job = f.models.jobs.get('mock-bot');
      expect.assert(job?.budget);
      const view = f.models.budgets.view(job.budget.budgetId);
      f.models.budgets.increase(
        view.scope.budgetId,
        view.scope.revision,
        { ...view.policy, toolLimit: view.policy.toolLimit + 1 },
        'mock-revoke-old-budget',
      );
      return capture(...args);
    });
    await f.delivery().command({ type: 'delivery.start', request: f.request });
    const job = f.models.jobs.get('mock-bot');
    expect.assert(job?.budget);
    await job.done;
    expect(job.phase).toBe('failed');
    expect(f.models.budgets.view(job.budget.budgetId)).toMatchObject({
      scope: { revision: 2 },
      requests: 0,
    });
    expect(f.models.findRequest('mock-bot', f.request.requestId)?.delivery).toBeDefined();
  } finally {
    await f.close();
  }
});
