import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Group } from '@daban/protocol';
import { expect, test } from 'vitest';
import type { ToolResult } from './computer-tools.js';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

function result<T>(value: unknown): T {
  expect.assert(value && typeof value === 'object' && 'result' in value);
  const reply = value.result as ToolResult;
  expect(reply.isError, JSON.stringify(reply)).toBeUndefined();
  const block = reply.content[0];
  return JSON.parse(block.type === 'text' ? block.text : '') as T;
}

test('group completion waits for artifact collection and the final model receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-group-finalization-'));
  let scanned = () => {};
  let release = () => {};
  const scanning = new Promise<unknown>((resolve) => {
    scanned = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  class DelayedWorkspace extends WorkspaceFiles {
    scope(directory: string, canonical?: string) {
      const files = super.scope(directory, canonical);
      const list = files.list.bind(files);
      files.list = async () => {
        scanned();
        await gate;
        return list();
      };
      return files;
    }
  }
  let models: ModelRuns;
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-finalization-session') {
      return {
        id,
        run: async () => {
          await writeFile(
            path.join(models.jobs.get('mock-alpha')!.workdir, 'mock-result.md'),
            'SYNTHETIC GROUP ARTIFACT',
          );
          return { sessionId: id, finalResponse: 'SYNTHETIC FINAL ANSWER' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  models = new ModelRuns({
    settings,
    Harness,
    workspace: new DelayedWorkspace(path.join(root, 'shared')),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  });
  const groups = new Groups(path.join(root, 'groups.sqlite'), {
    member: (id) => models.profiles.get(id),
    source: (bot, runId, group) => models.groupSource(bot, runId, group),
    running: (id) => models.running(id),
    findRequest: (bot, id) => models.findRequest(bot, id),
    start: (bot, task, scope) => models.start(bot, task, scope),
    stopRequest: (bot, id, group) => models.stopRequest(bot, id, group),
  });
  let pending: Promise<unknown> | undefined;
  let stopping: Promise<unknown> | undefined;
  try {
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.ready;
    for (const id of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({ id, name: id, instructions: '', memory: '', color: 'mint' });
    await groups.register({
      id: 'mock-finalization-group',
      name: 'Mock group',
      members: ['mock-alpha', 'mock-beta'],
    });
    await groups.send({
      id: 'mock-finalization-turn',
      group: 'mock-finalization-group',
      prompt: 'SYNTHETIC TASK',
      recipients: ['mock-alpha'],
    });
    await groups.tick();
    const job = models.jobs.get('mock-alpha')!;
    pending = job.done;
    await scanning;
    expect(job.phase).toBe('completed');
    expect(models.running('mock-alpha')).toBe(true);
    expect(models.groupRunning('mock-finalization-group')).toBe(true);
    await expect(
      models.start('mock-alpha', { requestId: 'mock-too-early', prompt: 'SYNTHETIC OTHER TASK' }),
    ).rejects.toMatchObject({ code: 'MODEL_ALREADY_RUNNING' });
    expect(models.findRequest('mock-alpha', job.requestId)!.phase).toBe('running');
    await expect(
      groups.history({ bot: 'mock-alpha', runId: job.id, group: 'mock-finalization-group' }, {}),
    ).rejects.toMatchObject({ code: 'GROUP_SOURCE_CLOSED' });
    await groups.tick();
    expect((await groups.read('mock-finalization-group')).deliveries[0].state).toBe('running');
    let stopFinished = false;
    stopping = models.stop('mock-alpha').then(() => {
      stopFinished = true;
    });
    await Promise.resolve();
    expect(stopFinished).toBe(false);
    release();
    await pending;
    await stopping;
    await groups.tick();
    const page = await groups.read('mock-finalization-group');
    expect(page.deliveries[0].state).toBe('completed');
    expect(page.messages.find((message) => message.role === 'bot')!.files).toEqual([
      expect.objectContaining({ name: 'mock-result.md' }),
    ]);
    expect(models.running('mock-alpha')).toBe(false);
  } finally {
    release();
    await pending;
    await stopping;
    await groups.close();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model RPC forms a group for the authoritative task intent, resumes its receipt, and keeps private sessions out of group execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-groups-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let models: ModelRuns;
  let sequence = 0;
  let act: (bot: string, prompt: string, context: string) => Promise<unknown> = async () => {};
  const sessions: { id: string; bot: string; group?: string; prompt: string; context: string }[] =
    [];
  class Harness {
    constructor(readonly options: { cwd: string }) {}
    async start() {}
    async close() {}
    session(id = `mock-group-session-${++sequence}`) {
      return {
        id,
        run: async (input: unknown) => {
          const job = [...models.jobs.values()].find((job) => job.running && job.sessionId === id)!;
          const prompt = String(input);
          const context = await readFile(path.join(this.options.cwd, 'task-context.json'), 'utf8');
          sessions.push({ id, bot: job.bot, group: job.conversationId, prompt, context });
          await act(job.bot, prompt, context);
          return { sessionId: id, finalResponse: 'SYNTHETIC SCOPED RESULT' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  models = new ModelRuns({
    settings,
    Harness,
    workspace: path.join(root, 'shared'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  });
  const groups = new Groups(path.join(root, 'groups.sqlite'), {
    member: (id) => models.profiles.get(id),
    directory: () => models.profiles.list(),
    source: (bot, runId, group) => models.groupSource(bot, runId, group),
    running: (id) => models.running(id),
    groupRunning: (id) => models.groupRunning(id),
    admit: (id) => models.admit(id),
    findRequest: (bot, requestId) => models.findRequest(bot, requestId),
    start: (bot, task, scope) => models.start(bot, task, scope),
    stopRequest: (bot, requestId, scope) => models.stopRequest(bot, requestId, scope),
  });
  const rpc = (bot: string, method: string, params?: Record<string, unknown>) => {
    const job = models.jobs.get(bot)!;
    return models.rpc(bot, `Bearer ${job.token}`, {
      id: `mock-wire-${++sequence}`,
      method,
      params,
    });
  };
  const call = (bot: string, name: string, args: Record<string, unknown> = {}) =>
    rpc(bot, 'tools/call', { name, arguments: args });
  const request = {
    name: '合成角色协作',
    members: ['mock-beta'],
    message: 'SYNTHETIC SHARED TASK: beta checks, alpha summarizes.',
  };
  let created!: { group: Group; reused: boolean };
  try {
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.ready;
    await groups.ready;
    models.tools.groups = new GroupTools(groups);
    for (const id of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id,
        name: id,
        instructions: 'SYNTHETIC ROLE',
        memory: '',
        color: 'mint',
      });
    await models.start('mock-beta', {
      requestId: 'mock-beta-private',
      prompt: 'SYNTHETIC-BETA-DM-SECRET',
    });
    await models.jobs.get('mock-beta')!.done;
    const betaDM = models.jobs.get('mock-beta')!.sessionId;
    const betaPrivateRun = models.jobs.get('mock-beta')!.id;
    act = async (bot, _prompt, context) => {
      expect(context).toContain('group_directory');
      expect(context).toContain('group_create');
      const directory = result<{ items: { id: string }[] }>(await call(bot, 'group_directory'));
      expect(directory.items.map((item) => item.id)).toStrictEqual(['mock-beta']);
      created = result(await call(bot, 'group_create', request));
      expect(created.reused).toBe(false);
      expect(result(await call(bot, 'group_create', request))).toMatchObject({
        group: created.group,
        reused: true,
      });
    };
    await models.start('mock-alpha', {
      requestId: 'mock-current-task',
      prompt: 'SYNTHETIC-ALPHA-DM-SECRET; collaborate on the shared task.',
      files: [{ name: 'private.txt', content: 'SYNTHETIC-INPUT-SECRET' }],
    });
    const source = models.jobs.get('mock-alpha')!;
    await source.done;
    expect(source.phase, source.error).toBe('completed');
    expect(models.groupSource('mock-alpha', source.id)).toBeUndefined();
    expect(created.group.members).toStrictEqual(['mock-alpha', 'mock-beta']);
    act = async (bot) => {
      created = result(await call(bot, 'group_create', request));
      expect(created.reused).toBe(true);
    };
    await models.start('mock-alpha', {
      requestId: 'mock-retry-task',
      prompt: source.task!.prompt,
      retryOf: source.id,
    });
    await models.jobs.get('mock-alpha')!.done;
    expect(models.jobs.get('mock-alpha')!.phase).toBe('completed');
    expect((await groups.status()).items).toHaveLength(1);
    act = async (bot, prompt, context) => {
      expect(context).toContain('The current task message is a group handoff');
      const list = await rpc(bot, 'tools/list');
      expect.assert(list && 'result' in list);
      const offered = list.result as { tools: { name: string }[] };
      expect(offered.tools.some((tool) => tool.name === 'group_create')).toBe(false);
      expect(offered.tools.some((tool) => tool.name === 'group_handoff')).toBe(true);
      expect(prompt).toContain(request.message);
      expect(prompt).not.toMatch(/DM-SECRET|INPUT-SECRET/);
      expect(
        result<{ messages: unknown[] }>(await call(bot, 'group_history')).messages,
      ).toHaveLength(1);
      expect(
        result<{ matches: unknown[] }>(await call(bot, 'bot_history_search')).matches,
      ).toStrictEqual([]);
      const privateHistory = await call(bot, 'bot_history_read', {
        runId: betaPrivateRun,
        field: 'prompt',
      });
      expect.assert(privateHistory && 'result' in privateHistory);
      expect((privateHistory.result as ToolResult).isError).toBe(true);
      const nested = await call(bot, 'group_create', request);
      expect.assert(nested && 'result' in nested);
      expect((nested.result as ToolResult).isError).toBe(true);
      expect(models.groupSource(bot, models.jobs.get(bot)!.id)).toBeUndefined();
    };
    await groups.tick();
    await models.jobs.get('mock-beta')!.done;
    expect(models.jobs.get('mock-beta')!.phase, models.jobs.get('mock-beta')!.error).toBe(
      'completed',
    );
    expect(models.jobs.get('mock-beta')!.sessionId).not.toBe(betaDM);
    act = async (_bot, prompt) => {
      expect(prompt).not.toMatch(/DM-SECRET|INPUT-SECRET/);
      expect(prompt).toContain(request.message);
    };
    await groups.tick();
    await models.jobs.get('mock-alpha')!.done;
    await groups.tick();
    expect((await groups.read(created.group.id)).deliveries.map((row) => row.state)).toStrictEqual([
      'completed',
      'completed',
    ]);
    expect(sessions.filter((item) => item.group)).toHaveLength(2);
    expect(JSON.stringify(sessions.filter((item) => item.group))).not.toMatch(
      /DM-SECRET|INPUT-SECRET/,
    );
  } finally {
    await groups.close();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
