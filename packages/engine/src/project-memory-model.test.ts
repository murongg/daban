import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  executionVersion,
  isExecutionRequest,
  isProjectFileScope,
  type MemoryCandidate,
  modelExecutionCapability,
  type ProjectDocument,
  type ProjectScope,
  projectCapability,
  taskRunCapability,
  validAgentId,
} from '@daban/protocol';
import { expect, type TestContext, test, vi } from 'vitest';
import { type AgentToolRun, executionAttemptId } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import * as guest from './executor.js';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import type { WorkspaceExecutor } from './remote-workspace.js';
import { ModelSettings } from './settings.js';

function output<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  const block = result.content[0];
  if (block.type !== 'text') throw Error('MOCK EXPECTED TEXT');
  return JSON.parse(block.text) as T;
}
const scope = { projectId: 'mock-project', revision: 1 };
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-memory-model-'));
  const owners: { models?: ModelRuns; groups?: Groups } = {};
  t.onTestFinished(async () => {
    try {
      await owners.groups?.close();
    } finally {
      try {
        await owners.models?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  let handles = 0;
  const executionCalls: { method: string; params: Record<string, unknown> }[] = [];
  // The host consumes a POSIX guest protocol even on Windows; its memory policy needs no host-side guest daemon.
  const execution = {
    snapshot: { capabilities: [projectCapability, modelExecutionCapability, taskRunCapability] },
    async call(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const request = {
        role: 'executor',
        version: executionVersion,
        id: 'mock-execution',
        method,
        params,
      };
      if (!isExecutionRequest(request)) throw Error(`MOCK_INVALID_EXECUTION_REQUEST:${method}`);
      executionCalls.push({ method, params: structuredClone(params) });
      const binding = isProjectFileScope(params.project) ? params.project : undefined;
      const base =
        typeof params.root === 'string'
          ? params.root
          : binding
            ? `/mock-guest/projects/${binding.resourceId}`
            : '/mock-guest/shared';
      switch (request.method) {
        case 'workspace.base':
          return base;
        case 'workspace.create': {
          const parts: unknown = params.parts;
          if (!Array.isArray(parts) || !parts.every(validAgentId))
            throw Error('MOCK_INVALID_TASK_PARTS');
          const directory = path.posix.join(base, ...parts);
          return {
            root: base,
            path: directory,
            canonical: directory,
            handleId: `mock-handle-${++handles}`,
          };
        }
        case 'workspace.list':
          return [];
        case 'tools.open':
          return { tools: [] };
        case 'projects.bind':
          return { bot: params.bot, ...(params.scope ? { scope: params.scope } : {}) };
        case 'projects.sync':
        case 'workspace.verify':
        case 'workspace.close':
        case 'tools.cancel':
        case 'tools.drain':
          return { ok: true };
        default:
          throw Error(`MOCK_UNEXPECTED_EXECUTION_METHOD:${request.method}`);
      }
    },
  } satisfies WorkspaceExecutor;
  let activeBot = 'mock-alpha',
    sequence = 0;
  let action: (run: AgentToolRun) => Promise<unknown> = async () => undefined;
  const inputs: string[] = [];
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-session') {
      return {
        id,
        run: async (input: unknown) => {
          inputs.push(JSON.stringify(input));
          await action(models.jobs.get(activeBot)!);
          return { sessionId: id, finalResponse: 'SYNTHETIC COMPLETE' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const settings = new ModelSettings(path.join(root, 'settings.json'));
  const models = new ModelRuns({
    settings,
    execution,
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  owners.models = models;
  await models.ready;
  const dispatches: string[] = [];
  const groups = new Groups(path.join(root, 'groups.sqlite'), {
    member: (bot) => models.profiles.get(bot),
    directory: () => models.profiles.list(),
    source: (bot, runId, group) => models.groupSource(bot, runId, group),
    projectScope: (bot, project) => models.projects.assertScope(bot, project, 'read'),
    running: (bot) => models.running(bot),
    findRequest: (bot, requestId) => models.findRequest(bot, requestId),
    start: async (bot) => {
      dispatches.push(bot);
      throw Error('MOCK UNEXPECTED DISPATCH');
    },
    stopRequest: async () => undefined,
  });
  owners.groups = groups;
  await groups.ready;
  models.tools.groups = new GroupTools(groups);
  await settings.save({ apiKey: 'synthetic-model-key' });
  for (const bot of ['mock-alpha', 'mock-beta', 'mock-outsider'])
    await models.profiles.register({
      id: bot,
      name: bot,
      instructions: '',
      memory: 'SYNTHETIC PRIVATE PREFERENCE',
      color: 'mint',
    });
  await models.projects.write({
    action: 'create',
    requestId: 'mock-project-create',
    projectId: scope.projectId,
    expectedRevision: 0,
    value: { name: 'SYNTHETIC PROJECT', grants: [{ bot: 'mock-alpha' }, { bot: 'mock-beta' }] },
  });
  const source = {
    kind: 'text' as const,
    title: 'Synthetic reference',
    content: 'SYNTHETIC SHARED FACT',
  };
  const preview = await models.knowledge.project.preview(scope, source);
  const receipt = await models.knowledge.project.write({
    requestId: 'mock-publish',
    scope,
    action: 'publish',
    source,
    digest: preview.digest,
  });
  if (receipt.state !== 'complete' || !receipt.document) throw Error('MOCK EXPECTED DOCUMENT');
  return {
    models,
    groups,
    dispatches,
    inputs,
    executionCalls,
    document: receipt.document,
    async run(
      bot: string,
      invoke: (run: AgentToolRun) => Promise<unknown>,
      project: ProjectScope | null = scope,
      allowFailure = false,
    ) {
      activeBot = bot;
      action = invoke;
      await models.start(bot, {
        requestId: `mock-task-${++sequence}`,
        prompt: 'SYNTHETIC TASK',
        ...(project ? { project } : {}),
      });
      const job = models.jobs.get(bot)!;
      await job.done;
      if (!allowFailure) {
        expect(job.error, job.result).toBe('');
        expect(job.phase).toBe('completed');
      }
      return job;
    },
  };
}

test('project tools require an accepted scope and real reads; proposal authorship stays bound to its run', async (t) => {
  const f = await fixture(t);
  let candidate: MemoryCandidate | undefined;
  await f.run(
    'mock-alpha',
    async (run) => {
      expect(
        f.models.tools
          .list(run.bot, run.model, undefined, run)
          .some((tool) => tool.name.startsWith('project_memory_')),
      ).toBe(false);
    },
    null,
  );
  const firstJob = await f.run('mock-alpha', async (run) => {
    const names = f.models.tools.list(run.bot, run.model, undefined, run).map((tool) => tool.name);
    expect(names).toContain('project_memory_read');
    expect(names).not.toContain('project_memory_accept');
    const proposal = {
      requestId: 'mock-proposal',
      content: 'SYNTHETIC REMEMBERED FACT',
      reason: 'Synthetic reference',
      sources: [{ id: f.document.id, revision: 1 }],
    };
    expect((await f.models.tools.invoke(run, 'project_memory_propose', proposal)).isError).toBe(
      true,
    );
    const read = output<ProjectDocument>(
      await f.models.tools.invoke(run, 'project_memory_read', { id: f.document.id, revision: 1 }),
    );
    expect(read.content).toBe(f.document.content);
    candidate = output<MemoryCandidate>(
      await f.models.tools.invoke(run, 'project_memory_propose', proposal),
    );
    expect(candidate).toMatchObject({ proposer: 'mock-alpha', state: 'pending', scopeRevision: 1 });
    const replay = output<MemoryCandidate>(
      await f.models.tools.invoke(run, 'project_memory_propose', {
        ...proposal,
        requestId: 'mock-proposal-retry',
      }),
    );
    expect(replay.id).toBe(candidate.id);
    expect(
      (
        await f.models.tools.invoke(run, 'project_memory_propose', {
          ...proposal,
          proposer: 'mock-beta',
        })
      ).isError,
    ).toBe(true);
  });
  expect((await f.models.journal.read('mock-alpha', firstJob.id))?.projectDocuments).toStrictEqual([
    { id: f.document.id, revision: 1 },
  ]);
  const saved = await f.models.journal.read('mock-alpha', firstJob.id);
  expect(saved?.budget).toEqual(firstJob.budget);
  expect(saved?.attemptSummary?.[0].attemptId).toBe(firstJob.attemptId);
  expect(firstJob.executionId).toBe(executionAttemptId(firstJob.id, firstJob.attemptId!));
  expect(
    f.executionCalls.find(
      (call) => call.method === 'tools.open' && call.params.taskRunId === firstJob.id,
    )?.params,
  ).toMatchObject({
    id: firstJob.executionId,
    taskRunId: firstJob.id,
  });
  await expect(
    f.models.tools.invoke(firstJob, 'project_memory_read', {
      id: f.document.id,
      revision: 1,
    }),
  ).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
  expect(candidate).toBeDefined();
  await f.run('mock-beta', async (run) => {
    const own = output<{ candidates: MemoryCandidate[] }>(
      await f.models.tools.invoke(run, 'project_memory_candidates', {}),
    );
    expect(own.candidates).toStrictEqual([]);
    expect(
      (await f.models.tools.invoke(run, 'project_memory_candidate', { id: candidate!.id })).isError,
    ).toBe(true);
  });
  expect(f.inputs.at(-1)).toContain(f.document.id);
  expect(f.inputs.at(-1)).toContain('Project reference catalog');
  await f.run('mock-alpha', async () => undefined);
  const duplicate = await f.models.start('mock-alpha', {
    requestId: firstJob.requestId,
    prompt: 'SYNTHETIC TASK',
    project: scope,
  });
  expect(duplicate).not.toHaveProperty('projectDocuments');
  await expect(
    f.models.start('mock-outsider', {
      requestId: 'mock-denied',
      prompt: 'SYNTHETIC TASK',
      project: scope,
    }),
  ).rejects.toThrow('PROJECT_ACCESS_DENIED');
});

test('a scoped group request cannot publish project text to an otherwise available nonmember', async (t) => {
  const f = await fixture(t);
  await f.run('mock-alpha', async (run) => {
    const result = await f.models.tools.invoke(run, 'group_create', {
      name: 'Synthetic scoped group',
      members: ['mock-outsider'],
      message: f.document.content,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('PROJECT_ACCESS_DENIED');
  });
  expect(f.dispatches).toStrictEqual([]);
  expect((await f.groups.status()).items).toStrictEqual([]);
});

test('revocation after asynchronous catalog capture fences the model send', async (t) => {
  const f = await fixture(t);
  const capture = f.models.knowledge.project.context.bind(f.models.knowledge.project);
  vi.spyOn(f.models.knowledge.project, 'context').mockImplementation(async (project, bot) => {
    const context = await capture(project, bot);
    await f.models.projects.write({
      requestId: 'mock-revoke-before-send',
      projectId: scope.projectId,
      expectedRevision: 1,
      action: 'update',
      value: { name: 'Synthetic revoked scope', grants: [{ bot: 'mock-beta' }] },
    });
    return context;
  });
  const job = await f.run('mock-alpha', async () => undefined, scope, true);
  expect(f.inputs).toStrictEqual([]);
  expect(job.phase).toBe('failed');
  expect(job.error).toBe('PROJECT_SCOPE_STALE');
});

test('revocation during an asynchronous document read prevents its body from reaching the model', async (t) => {
  const f = await fixture(t);
  const read = f.models.knowledge.project.read.bind(f.models.knowledge.project);
  vi.spyOn(f.models.knowledge.project, 'read').mockImplementation(
    async (project, reference, bot) => {
      const document = await read(project, reference, bot);
      await f.models.projects.write({
        requestId: 'mock-revoke-during-read',
        projectId: scope.projectId,
        expectedRevision: 1,
        action: 'update',
        value: { name: 'Synthetic revoked scope', grants: [{ bot: 'mock-beta' }] },
      });
      return document;
    },
  );
  let result: ToolResult | undefined;
  await f.run(
    'mock-alpha',
    async (run) => {
      result = await f.models.tools.invoke(run, 'project_memory_read', {
        id: f.document.id,
        revision: 1,
      });
    },
    scope,
    true,
  );
  expect(result?.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('PROJECT_SCOPE_STALE');
  expect(JSON.stringify(result)).not.toContain(f.document.content);
});

test('memory model coverage does not start the POSIX guest service on its host', async (t) => {
  const start = vi
    .spyOn(guest, 'startExecutor')
    .mockRejectedValue(new Error('MOCK_POSIX_GUEST_UNAVAILABLE'));
  const f = await fixture(t);
  await f.run('mock-alpha', async (run) => {
    const document = output<ProjectDocument>(
      await f.models.tools.invoke(run, 'project_memory_read', { id: f.document.id, revision: 1 }),
    );
    expect(document.content).toBe(f.document.content);
  });
  expect(start).not.toHaveBeenCalled();
});

test('an asynchronous project catalog cannot send through a retired physical attempt', async (t) => {
  const f = await fixture(t);
  const context = f.models.knowledge.project.context.bind(f.models.knowledge.project);
  f.models.knowledge.project.context = async (project, bot) => {
    const value = await context(project, bot);
    const job = f.models.jobs.get(bot)!;
    job.attemptActive = false;
    return value;
  };
  const job = await f.run('mock-alpha', async () => undefined, scope, true);
  expect(f.inputs).toStrictEqual([]);
  expect(job.error).toBe('MODEL_CANCELLED');
  expect(job.attemptSummary).toHaveLength(1);
});

test('a revoked project cannot obtain a physical send permit after its budget reservation', async (t) => {
  const f = await fixture(t);
  let denied: string | undefined;
  let sends = 0;
  let budgetRoot: string | undefined;
  let reservedPhase: string | undefined;
  let auth = '';
  const job = await f.run(
    'mock-alpha',
    async () => {
      const current = f.models.jobs.get('mock-alpha')!;
      const budget = current.budget!;
      budgetRoot = f.models.budgets.view(budget.budgetId).rootId;
      auth = `Bearer ${current.token}`;
      const rpc = (method: string, params: Record<string, unknown>) =>
        f.models.rpc(current.bot, auth, { id: 'mock-memory-wire', method, params });
      const reservation = {
        scope: budget,
        modelAttemptId: current.attemptId,
        attemptId: 'mock-physical-send',
        requestHash: 'a'.repeat(64),
        rootSessionId: current.sessionId,
        sessionId: current.sessionId,
        purpose: 'main',
      };
      await rpc('budget.reserve', { ...reservation, attemptId: 'mock-original-send' });
      expect(
        await rpc('budget.dispatched', {
          scope: budget,
          modelAttemptId: current.attemptId,
          attemptId: 'mock-original-send',
        }),
      ).toMatchObject({ result: { send: true } });
      await rpc('budget.reserve', reservation);
      await f.models.projects.write({
        requestId: 'mock-revoke-before-dispatch',
        projectId: scope.projectId,
        expectedRevision: 1,
        action: 'update',
        value: { name: 'Synthetic revoked project', grants: [{ bot: 'mock-beta' }] },
      });
      try {
        const result = (await rpc('budget.dispatched', {
          scope: budget,
          modelAttemptId: current.attemptId,
          attemptId: 'mock-physical-send',
        })) as { result: { send: boolean } };
        if (result.result.send) sends++;
      } catch (error) {
        denied = error instanceof Error ? error.message : String(error);
      }
      reservedPhase = f.models.budgets
        .view(budget.budgetId)
        .receipts.find((receipt) => receipt.attemptId === reservation.attemptId)?.phase;
    },
    scope,
    true,
  );
  expect(denied).toBe('PROJECT_SCOPE_STALE');
  expect(sends).toBe(0);
  expect(reservedPhase).toBe('reserved');
  expect(
    await f.models.rpc(job.bot, auth, {
      id: 'mock-late-original-usage',
      method: 'budget.report',
      params: {
        scope: job.budget,
        runId: job.id,
        attemptId: 'mock-original-send',
        usage: {
          state: 'reported',
          inputTokens: 8,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    }),
  ).toMatchObject({ result: { accepted: true } });
  const ledger = f.models.budgets.view(job.budget!.budgetId);
  expect(ledger.rootId).toBe(budgetRoot);
  expect(ledger.receipts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: job.id,
        modelAttemptId: job.attemptId,
        rootSessionId: job.sessionId,
        attemptId: 'mock-physical-send',
      }),
    ]),
  );
  expect(ledger.reported.inputTokens).toBe(8);
  const saved = await f.models.journal.read(job.bot, job.id);
  expect(saved?.budget).toEqual(job.budget);
  expect(saved?.intentId).toBe(job.intentId);
  expect(saved?.requestId).toBe(job.requestId);
});

test('a Goal reconciliation replay keeps budget identity without exposing internal project read evidence', async (t) => {
  const f = await fixture(t);
  const first = await f.run('mock-alpha', async (run) => {
    await f.models.tools.invoke(run, 'project_memory_read', { id: f.document.id, revision: 1 });
  });
  const owner = { bot: first.bot, chatRevision: first.chatRevision!, project: scope };
  f.models.budgets.goals.observe(
    owner,
    first.sessionId!,
    { id: 'mock-memory-goal', revision: 1 },
    first.budget!,
    true,
  );
  const target = await f.models.goalTarget(owner);
  const request = {
    requestId: 'mock-memory-goal-resume',
    prompt: '/goal resume',
    project: scope,
    goalResume: target,
  };
  await f.models.startHuman(first.bot, request);
  const winner = f.models.jobs.get(first.bot)!;
  await winner.done;
  // This synthetic Harness does not execute native Goal resume; the recorded failed result must stay failed.
  expect(winner.error).toBe('GOAL_INCOMPLETE');
  expect(winner.phase).toBe('failed');
  const saved = await f.models.journal.read(winner.bot, winner.id);
  expect(saved?.projectDocuments).toStrictEqual([{ id: f.document.id, revision: 1 }]);
  f.models.jobs.delete(first.bot);
  const find = f.models.journal.findRequest.bind(f.models.journal);
  let lookups = 0;
  // A concurrent winner can become visible while Goal reconciliation awaits journal I/O.
  const replay = vi
    .spyOn(f.models.journal, 'findRequest')
    .mockImplementation((bot, id) =>
      id === request.requestId && lookups++ === 0 ? undefined : find(bot, id),
    );
  try {
    const receipt = await f.models.startHuman(first.bot, request);
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(receipt).not.toHaveProperty('projectDocuments');
    expect(receipt).toMatchObject({
      runId: winner.id,
      budget: winner.budget,
      attemptSummary: winner.attemptSummary,
    });
    expect((await f.models.journal.read(winner.bot, winner.id))?.projectDocuments).toEqual(
      saved?.projectDocuments,
    );
  } finally {
    replay.mockRestore();
  }
});
