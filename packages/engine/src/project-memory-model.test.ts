import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryCandidate, ProjectDocument, ProjectScope } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import type { AgentToolRun } from './agent-tools.js';
import type { ToolResult } from './computer-tools.js';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

function output<T>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  const block = result.content[0];
  if (block.type !== 'text') throw Error('MOCK EXPECTED TEXT');
  return JSON.parse(block.text) as T;
}
const scope = { projectId: 'mock-project', revision: 1 };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-memory-model-'));
  const service = await startExecutor({
    directory: path.join(root, 'guest'),
    port: 0,
    boot: 'mock-boot',
  });
  const execution = new RemoteExecutor({
    url: `${service.origin}/exec`,
    token: (await readFile(path.join(root, 'guest/token'), 'utf8')).trim(),
  });
  await execution.ready;
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
    origin: service.origin,
    Harness,
  });
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
    async close() {
      await groups.close();
      await models.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('project tools require an accepted scope and real reads; proposal authorship stays bound to its run', async (t) => {
  const f = await fixture();
  t.onTestFinished(() => f.close());
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
  expect(
    (
      await f.models.tools.invoke(firstJob, 'project_memory_read', {
        id: f.document.id,
        revision: 1,
      })
    ).isError,
  ).toBe(true);
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
  const f = await fixture();
  t.onTestFinished(() => f.close());
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
  const f = await fixture();
  t.onTestFinished(() => f.close());
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
  const f = await fixture();
  t.onTestFinished(() => f.close());
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
