import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('project tasks capture private staging, request identity and DSH session authority across project switches', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-model-'));
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
  let resumed = 0;
  const inputs: string[] = [];
  const prepared: string[] = [];
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-session') {
      return {
        id,
        run: async (input: unknown) => {
          inputs.push(JSON.stringify(input));
          const result = await models.tools.skills!.invoke(
            models.jobs.get('mock-bot')!,
            'skill_prepare',
            { skill: 'mock-project-skill' },
          );
          const block = result.content[0];
          if (block.type !== 'text') throw Error('MOCK EXPECTED TEXT');
          const staged: unknown = JSON.parse(block.text);
          if (
            !staged ||
            typeof staged !== 'object' ||
            !('directory' in staged) ||
            typeof staged.directory !== 'string'
          )
            throw Error('MOCK INVALID STAGING');
          prepared.push(staged.directory);

          return { sessionId: id, finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed++;
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
  t.onTestFinished(async () => {
    await models.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  await models.ready;
  await settings.save({ apiKey: 'synthetic-model-key' });
  await models.profiles.register({
    id: 'mock-bot',
    name: 'SYNTHETIC',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const skill = await models.skills.importPackage({
    files: [
      {
        path: 'SKILL.md',
        data: Buffer.from(
          '---\nname: mock-project-skill\ndescription: Synthetic project skill\n---\nRead assets/mock.txt.\n',
        ).toString('base64'),
      },
      {
        path: 'assets/mock.txt',
        data: Buffer.from('SYNTHETIC SKILL REFERENCE').toString('base64'),
      },
    ],
  });
  await models.skills.bind('mock-bot', {
    id: skill.id,
    revision: skill.revision,
    bindingRevision: 0,
    enabled: true,
  });
  for (const projectId of ['mock-alpha', 'mock-beta'])
    await models.projects.write({
      action: 'create',
      requestId: `create-${projectId}`,
      projectId,
      expectedRevision: 0,
      value: { name: projectId, grants: [{ bot: 'mock-bot' }] },
    });
  const task = {
    requestId: 'mock-task-alpha',
    prompt: 'SYNTHETIC ALPHA PRIVATE NOTE',
    project: { projectId: 'mock-alpha', revision: 1 },
  };
  const originalCall = execution.call.bind(execution);
  let release: (() => unknown) | undefined, arrived: (() => unknown) | undefined;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const binding = new Promise<unknown>((resolve) => {
    arrived = () => resolve(undefined);
  });
  let firstBind = true;
  vi.spyOn(execution, 'call').mockImplementation(async (method, params, signal) => {
    if (method === 'projects.bind' && firstBind) {
      firstBind = false;
      arrived?.();
      await gate;
    }
    return originalCall(method, params, signal);
  });
  const accepted = models.start('mock-bot', task);
  accepted.catch(() => undefined);
  await binding;
  let duplicate: unknown, result: unknown;
  try {
    duplicate = await models.start('mock-bot', task);
  } finally {
    release?.();
    result = await accepted;
  }
  expect(result).not.toHaveProperty('outputDirectory');
  expect(duplicate).toMatchObject({ requestId: task.requestId });

  await models.jobs.get('mock-bot')!.done;
  const first = models.jobs.get('mock-bot')!;
  expect(first.phase, first.error).toBe('completed');
  expect(first.workdir).not.toContain('desktops/shared');
  expect(models.journal.findRequest('mock-bot', task.requestId)).toMatchObject({
    project: task.project,
  });
  await expect(
    models.start('mock-bot', { ...task, project: { projectId: 'mock-beta', revision: 1 } }),
  ).rejects.toMatchObject({ code: 'REQUEST_ID_REUSED' });
  await models.start('mock-bot', {
    ...task,
    requestId: 'mock-task-beta',
    prompt: 'SYNTHETIC BETA REQUEST',
    project: { projectId: 'mock-beta', revision: 1 },
  });
  await models.jobs.get('mock-bot')!.done;
  expect(resumed).toBe(0);
  expect(prepared).toHaveLength(2);
  expect(prepared.every((directory) => !directory.includes('desktops/shared'))).toBe(true);
  expect(prepared[0]).not.toBe(prepared[1]);
  expect(inputs.at(-1)).not.toContain('SYNTHETIC ALPHA PRIVATE NOTE');
});
