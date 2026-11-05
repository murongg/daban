import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { turnLimit } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { migrate } from './database.js';
import { GoalControls } from './goal-controls.js';
import { editorShowsFile, ModelRuns, sdkPatch, verifyOutput, verifyTask } from './model.js';
import { secureDirectory } from './private-files.js';
import { migrations as projectMigrations } from './projects-migrations.js';
import { projectItems } from './projects-schema.js';
import { RemoteWorkspace } from './remote-workspace.js';
import { ModelSettings } from './settings.js';
import { TaskJournal, type TaskRecord } from './tasks.js';

test('ordinary startup reads retired task history without changing the old project database', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-project-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'model');
  await mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, 'projects.sqlite');
  const client = new DatabaseSync(file);
  try {
    const db = migrate(client, projectMigrations);
    db.insert(projectItems)
      .values({
        id: 'mock-retired-project',
        revision: 1,
        value: JSON.stringify({
          id: 'mock-retired-project',
          name: 'SYNTHETIC RETIRED PROJECT',
          revision: 1,
          status: 'active',
          grants: [],
          environment: { files: 'project', browser: 'private' },
        }),
      })
      .run();
  } finally {
    client.close();
  }
  await chmod(file, 0o600);
  const original = await readFile(file);
  const journal = new TaskJournal(path.join(dir, 'task-journal'));
  await journal.load();
  await journal.put({
    bot: 'mock-bot',
    runId: 'mock-retired-run',
    requestId: 'mock-retired-request',
    project: { projectId: 'mock-retired-project', revision: 1 },
    sessionId: 'mock-retired-goal-session',
    goal: {
      id: 'mock-retired-goal',
      revision: 1,
      objective: 'SYNTHETIC PRIVATE GOAL',
      phase: 'paused',
      activation: 'disarmed',
      rounds: 1,
      limit: 3,
    },
    prompt: 'SYNTHETIC PRIVATE PROJECT HISTORY',
    phase: 'completed',
    running: false,
    result: 'SYNTHETIC HISTORICAL RESULT',
    error: '',
    trace: [],
  });
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, 'ordinary.txt'), 'SYNTHETIC SHARED FILE');
  const models = new ModelRuns({
    settings: new ModelSettings(path.join(root, 'settings.json')),
    dir,
    workspace,
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await models.ready;
    expect(models.goals.prepare({ bot: 'mock-bot', chatRevision: 0 })).toBeUndefined();
    expect((await models.chatHistory('mock-bot', 0)).items).toContainEqual(
      expect.objectContaining({
        runId: 'mock-retired-run',
        project: { projectId: 'mock-retired-project', revision: 1 },
        result: 'SYNTHETIC HISTORICAL RESULT',
      }),
    );
    expect(await models.filesFor({}).read('ordinary.txt')).toMatchObject({
      content: 'SYNTHETIC SHARED FILE',
    });
  } finally {
    await models.close();
  }
  expect(await readFile(file)).toEqual(original);
});

test('retired file locators never fall through to the ordinary shared workspace', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-file-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const models = new ModelRuns({
    settings: new ModelSettings(path.join(root, 'settings.json')),
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await models.ready;
    expect(() =>
      models.filesFor({
        project: { projectId: 'mock-retired-project', revision: 1 },
        task: { bot: 'mock-bot', runId: 'mock-retired-run' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_RETIRED' }));
  } finally {
    await models.close();
  }
});
test.each(['unknown-effect', 'newer-authority'] as const)(
  'historical Goal recovery preserves %s without financial bookkeeping',
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-goal-unknown-'));
    const dir = path.join(root, 'model');
    const journal = new TaskJournal(path.join(dir, 'task-journal'));
    await journal.put({
      bot: 'a',
      runId: 'synthetic-prior-run',
      requestId: 'synthetic-prior-request',
      prompt: 'SYNTHETIC TASK',
      kind: 'chat',
      phase: 'interrupted',
      running: false,
      result: '',
      error: 'TASK_INTERRUPTED',
      sessionId: 'synthetic-goal-session',
      createdAt: '2026-01-01T00:00:00Z',
      chatRevision: 0,
      goalSession: true,
      goal: {
        id: 'synthetic-goal',
        revision: 1,
        objective: 'SYNTHETIC GOAL',
        phase: 'paused',
        activation: 'disarmed',
        rounds: 1,
        limit: 3,
      },
      trace: [
        {
          name: 'shell',
          surface: 'workspace',
          phase: 'running',
          at: '2026-01-01T00:00:00Z',
          code: 'EXECUTION_OUTCOME_UNKNOWN',
        },
      ],
    });
    if (mode === 'newer-authority') {
      const controls = new GoalControls(path.join(dir, 'goals.sqlite'));
      await controls.ready;
      controls.observe(
        { bot: 'a', chatRevision: 0 },
        'synthetic-newer-session',
        { id: 'synthetic-newer-goal', revision: 2 },
        true,
      );
      controls.close();
    }
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'synthetic-model' }] }),
    );
    await settings.save({ apiKey: 'synthetic-provider-key' });
    let starts = 0;
    class Harness {
      async start() {
        starts++;
      }
      async close() {}
      session(id = 'synthetic-goal-session') {
        return { id, run: async () => ({ sessionId: id, finalResponse: 'SYNTHETIC RESUME' }) };
      }
      async resumeSession(id: string) {
        return this.session(id);
      }
    }
    const models = new ModelRuns({
      settings,
      Harness,
      dir,
      workspace: path.join(root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    });
    try {
      const target = await models.goalTarget({ bot: 'a', chatRevision: 0 });
      if (mode === 'newer-authority') {
        expect(target.goalId).toBe('synthetic-newer-goal');
        expect(starts).toBe(0);
        return;
      }
      await expect(
        models.startHuman('a', {
          requestId: 'synthetic-resume',
          prompt: '/goal resume',
          chatRevision: 0,
          goalResume: target,
        }),
      ).rejects.toMatchObject({ code: 'TASK_OUTCOME_UNKNOWN' });
      expect(starts).toBe(0);
      expect(models.goals.epoch(target.owner)).toBe(target.humanEpoch);
    } finally {
      await models.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(['corrupt', 'legacy'] as const)(
  'an obsolete %s financial sidecar cannot block an ordinary task or be rewritten by execution',
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-obsolete-sidecar-'));
    const dir = path.join(root, 'model');
    await secureDirectory(dir);
    const sidecar = path.join(dir, 'budgets.sqlite');
    const snapshot = JSON.stringify({ currency: 'USD', input: 1000000 });
    if (kind === 'legacy') {
      const legacy = new DatabaseSync(sidecar);
      try {
        for (const name of ['20261104160300_initial', '20261104163747_goal-grants'])
          legacy.exec(
            await readFile(
              new URL(`../drizzle/budgets/${name}/migration.sql`, import.meta.url),
              'utf8',
            ),
          );
        legacy
          .prepare('INSERT INTO budget_prices(id,snapshot) VALUES(?,?)')
          .run('synthetic-price', snapshot);
      } finally {
        legacy.close();
      }
    } else await writeFile(sidecar, 'SYNTHETIC OBSOLETE FINANCIAL SIDECAR', { mode: 0o600 });
    const original = await readFile(sidecar);
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'synthetic-model' }] }),
    );
    await settings.save({ apiKey: 'synthetic-provider-key' });
    class Harness {
      async start() {}
      async close() {}
      session(id = 'synthetic-session') {
        return { id, run: async () => ({ sessionId: id, finalResponse: 'SYNTHETIC COMPLETE' }) };
      }
      async resumeSession(id: string) {
        return this.session(id);
      }
    }
    const models = new ModelRuns({
      settings,
      Harness,
      dir,
      workspace: path.join(root, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    });
    try {
      await models.start('a', { requestId: 'synthetic-ordinary-task', prompt: 'SYNTHETIC TASK' });
      const job = models.jobs.get('a')!;
      await job.done;
      expect(job.phase, job.error).toBe('completed');
      expect(job.result).toBe('SYNTHETIC COMPLETE');
      expect(await readFile(sidecar)).toEqual(original);
      if (kind === 'legacy') {
        const legacy = new DatabaseSync(sidecar, { readOnly: true });
        try {
          expect(
            legacy.prepare('SELECT snapshot FROM budget_prices WHERE id=?').get('synthetic-price')
              ?.snapshot,
          ).toBe(snapshot);
        } finally {
          legacy.close();
        }
      }
    } finally {
      await models.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('initialization failures preserve redacted startup diagnostics and reclaim the private checkpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-model-startup-log-'));
  const secret = 'synthetic-startup-api-key';
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-model' }] }),
  );
  let snapshot = '';
  let initializeFails = true;
  let closeFails = false;
  class Harness {
    constructor(readonly options: { env: NodeJS.ProcessEnv }) {}
    async start() {
      snapshot = this.options.env.DABAN_DSH_STARTUP_FILE ?? '';
      expect.assert(snapshot, 'SDK startup must receive a private diagnostic checkpoint');
      expect.assert(this.options.env.NODE_OPTIONS?.includes('dsh-preload.js'));
      await writeFile(
        snapshot,
        JSON.stringify({
          stage: 'waiting-initialize',
          stderr: `SYNTHETIC PARTIAL ${secret}`,
          entry: 'mock-runtime/lib/index.js',
        }),
        { mode: 0o600 },
      );
      if (initializeFails) throw new Error(`initialize timed out: ${secret}`);
    }
    async close() {
      if (closeFails) throw new Error('SYNTHETIC SHUTDOWN CHAT');
    }
    session(id = 'mock-session') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'unused' }) };
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
    await settings.configure({
      revision: 0,
      requestId: 'mock-log-config',
      apiKey: secret,
      model: 'provider:mock-provider:mock-model',
      connection: {
        id: 'mock-provider',
        name: 'Synthetic',
        baseURL: 'https://models.example.test/v1',
        models: [
          {
            id: 'mock-model',
            name: 'Synthetic',
            vision: false,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    });
    await models.start('mock-bot', {
      requestId: 'mock-startup-request',
      prompt: 'SYNTHETIC PRIVATE CHAT',
    });
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase).toBe('failed');
    const text = await readFile(path.join(root, 'model/dsh-startup.log'), 'utf8');
    expect(text.includes(secret)).toBe(false);
    expect(text.includes('SYNTHETIC PRIVATE CHAT')).toBe(false);
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect.assert(records.some((record) => record.stage === 'sdk-loading'));
    const failure = records.find((record) => record.stage === 'initialize-failed');
    expect.assert(failure);
    expect(failure.runId).toBe(job.id);
    expect.assert(failure.snapshot.stderr.includes('[credential redacted]'));
    await expect(readFile(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
    initializeFails = false;
    closeFails = true;
    await models.start('mock-bot', {
      requestId: 'mock-after-startup',
      prompt: 'SYNTHETIC PRIVATE CHAT',
    });
    await models.jobs.get('mock-bot')!.done;
    expect(
      (await readFile(path.join(root, 'model/dsh-startup.log'), 'utf8')).includes(
        'SYNTHETIC SHUTDOWN CHAT',
      ),
    ).toBe(false);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('native model routes select their actual DSH wire protocol without changing domain connection identity', () => {
  for (const [api, key, expectedApi] of [
    ['anthropic-messages', 'mock-native', 'anthropic-messages'],
    ['google-generative-ai', 'google', undefined],
    ['openai-responses', 'mock-native', 'openai-responses'],
  ] as const) {
    const route = {
      api,
      provider: 'mock-native',
      model: 'provider:mock-native:mock-model',
      apiModel: 'mock-model',
      baseURL: 'https://native.example.test',
      apiKey: 'synthetic-native-key',
      vision: true,
      contextWindow: 128000,
      maxTokens: 8192,
      binding: 'a'.repeat(64),
      secrets: ['synthetic-native-key'],
    };
    const patch = Reflect.apply(sdkPatch, undefined, [
      'http://127.0.0.1:8766',
      'mock-bot',
      'mock-token',
      undefined,
      60,
      route.model,
      { available: true, key: '', skills: [] },
      undefined,
      route,
    ]) as ReturnType<typeof sdkPatch>;
    const plugin = patch
      .flatMap((entry) => ('insert' in entry ? entry.insert : []))
      .find((entry) => entry.id === 'desktop-model-provider');
    const profiles = (
      plugin as unknown as {
        config: { providers: Record<string, { api?: string; apiKeyEnv: string; baseURL: string }> };
      }
    ).config.providers;
    expect.assert(profiles[key], api);
    expect(profiles[key].api, api).toBe(expectedApi);
    expect(profiles[key].apiKeyEnv).toBe('DABAN_MODEL_KEY');
    expect(profiles[key].baseURL).toBe(route.baseURL);
    expect(route.provider).toBe('mock-native');
    expect(JSON.stringify(patch).includes(route.apiKey)).toBe(false);
  }
});

test('a captured supplier route controls DSH endpoint, model capabilities and independent key environment', () => {
  const route = {
    model: 'provider:mock-supplier:mock-chat',
    apiModel: 'mock-chat',
    provider: 'mock-supplier',
    baseURL: 'https://models.example.test/v1',
    apiKey: 'synthetic-route-secret',
    vision: false,
    contextWindow: 64000,
    maxTokens: 4096,
    binding: 'a'.repeat(64),
    secrets: ['synthetic-route-secret'],
  };
  const patch = Reflect.apply(sdkPatch, undefined, [
    'http://127.0.0.1:8766',
    'mock-bot',
    'mock-token',
    { requestId: 'mock-route-patch', prompt: 'Mock task.' },
    60,
    'deepseek-flash',
    { available: true, key: '', skills: [] },
    undefined,
    route,
  ]) as ReturnType<typeof sdkPatch>;
  const plugins = patch.flatMap((entry) => ('insert' in entry ? entry.insert : []));
  const provider = plugins.find((entry) => entry.id === 'desktop-model-provider')!;
  const config = (
    provider as unknown as {
      config: {
        providers: Record<
          string,
          {
            apiKeyEnv: string;
            baseURL: string;
            models: { id: string; input: string[]; contextWindow: number; maxTokens: number }[];
          }
        >;
      };
    }
  ).config;
  expect(config.providers['mock-supplier']?.apiKeyEnv).toBe('DABAN_MODEL_KEY');
  expect(config.providers['mock-supplier']?.baseURL).toBe(route.baseURL);
  expect(config.providers['mock-supplier']?.models).toStrictEqual([
    {
      id: 'mock-chat',
      input: ['text'],
      contextWindow: 64000,
      maxTokens: 4096,
      reasoningEfforts: false,
    },
  ]);
  expect(plugins.some((entry) => entry.id === 'web-deepseek-api')).toBe(false);
  const web = plugins.find((entry) => entry.id === 'tool-web')!;
  expect((web as unknown as { config: { search: boolean } }).config.search).toBe(false);
  expect(JSON.stringify(patch).includes(route.apiKey)).toBe(false);
});

test('an inserted queued message runs as a follow-up turn in the same session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-task-insert-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-chat' }] }),
  );
  const prompts: string[] = [];
  let entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release!: () => unknown;
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session(id = 'mock-insert-session') {
      return {
        id,
        run: async (input: unknown) => {
          const blocks =
            typeof input === 'string'
              ? []
              : (input as { type: 'text'; text: string }[]).filter(
                  (block) => block.type === 'text',
                );
          prompts.push(
            typeof input === 'string' ? input : blocks.map((block) => block.text).join('\n'),
          );
          if (prompts.length === 1) {
            entered();
            await held;
            return { sessionId: id, finalResponse: 'Synthetic first reply.' };
          }
          return { sessionId: id, finalResponse: 'Synthetic inserted reply.' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    Harness,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.configure({
      revision: 0,
      requestId: 'mock-insert-config',
      model: 'provider:mock-insert:mock-chat',
      apiKey: 'synthetic-insert-key',
      connection: {
        id: 'mock-insert',
        name: 'mock-insert',
        baseURL: 'https://mock-insert.example.test/v1',
        models: [
          {
            id: 'mock-chat',
            name: 'Synthetic chat',
            vision: false,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    });
    await models.profiles.register({
      id: 'mock-insert',
      name: 'mock-insert',
      color: 'mint',
      instructions: '',
      memory: '',
      model: 'provider:mock-insert:mock-chat',
    });
    await models.start('mock-insert', {
      requestId: 'mock-insert-first',
      prompt: 'Synthetic original request.',
    });
    await started;
    const runId = models.jobs.get('mock-insert')!.id;
    const target = { runId, chatRevision: 0 };
    await expect(
      models.insert('mock-insert', {
        id: 'mock-insert-stale',
        text: 'Synthetic stale message.',
        runId: 'mock-insert-other-run',
        chatRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'TASK_INSERT_STALE' });
    expect(
      await models.insert('mock-insert', {
        id: 'mock-insert-one',
        text: 'Synthetic inserted message.',
        ...target,
      }),
    ).toStrictEqual({ ok: true, id: 'mock-insert-one' });
    expect(
      await models.insert('mock-insert', {
        id: 'mock-insert-one',
        text: 'Synthetic ignored duplicate.',
        ...target,
      }),
    ).toStrictEqual({ ok: true, id: 'mock-insert-one' });
    release();
    await models.jobs.get('mock-insert')!.done;
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toMatch(/Synthetic original request\./);
    expect(prompts[1]).toBe('Synthetic inserted message.');
    expect(models.jobs.get('mock-insert')!.result).toBe('Synthetic inserted reply.');
    expect(models.jobs.get('mock-insert')!.phase).toBe('completed');
    expect(models.jobs.get('mock-insert')!.turns).toStrictEqual([
      {
        id: 'mock-insert-first',
        prompt: 'Synthetic original request.',
        result: 'Synthetic first reply.',
      },
      {
        id: 'mock-insert-one',
        prompt: 'Synthetic inserted message.',
        result: 'Synthetic inserted reply.',
      },
    ]);
    // Losing the acknowledgement must not execute the same turn again after the task ends.
    expect(
      await models.insert('mock-insert', {
        id: 'mock-insert-one',
        text: 'Synthetic ignored duplicate.',
        ...target,
      }),
    ).toStrictEqual({ ok: true, id: 'mock-insert-one' });
    await expect(
      models.insert('mock-insert', {
        id: 'mock-insert-late',
        text: 'Synthetic late message.',
        ...target,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_RUNNING' });
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface InsertState {
  bot: string;
  prompts: string[];
  entered: () => unknown;
  held: Promise<unknown>;
  release?: () => unknown;
  gate?: () => unknown;
  gateReached?: Promise<unknown>;
  gateOn?: (prompt: string) => boolean;
  failOn?: (prompt: string) => boolean;
  observe?: (observer: { onNotification: (note: unknown) => unknown }, turn: number) => unknown;
}
function insertHarness(state: InsertState) {
  return class Harness {
    async start() {}
    async close() {}
    session(id = `mock-${state.bot}-session`) {
      return {
        id,
        run: async (input: unknown, observer: { onNotification: (note: unknown) => unknown }) => {
          const blocks =
            typeof input === 'string'
              ? []
              : (input as { type: 'text'; text: string }[]).filter(
                  (block) => block.type === 'text',
                );
          const prompt =
            typeof input === 'string' ? input : blocks.map((block) => block.text).join('\n');
          state.prompts.push(prompt);
          state.observe?.(observer, state.prompts.length);
          if (state.prompts.length === 1) {
            state.entered();
            await state.held;
            return { sessionId: id, finalResponse: 'Synthetic first reply.' };
          }
          if (state.gateOn?.(prompt)) {
            state.gate?.();
            await state.gateReached;
          }
          if (state.failOn?.(prompt)) throw new Error('SYNTHETIC_MODEL_DISCONNECTED');
          return { sessionId: id, finalResponse: `Synthetic reply to ${prompt.slice(0, 40)}` };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  };
}
function insertGates() {
  let entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  let release!: () => unknown;
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  let gate!: () => unknown;
  const gateReached = new Promise<unknown>((resolve) => {
    gate = () => resolve(undefined);
  });
  return { started, entered, held, release, gate, gateReached };
}
async function insertFixture(root: string, state: InsertState) {
  const bot = state.bot;
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-chat' }] }),
  );
  const models = new ModelRuns({
    settings,
    Harness: insertHarness(state),
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  });
  await settings.configure({
    revision: 0,
    requestId: `mock-${bot}-config`,
    model: `provider:${bot}:mock-chat`,
    apiKey: `synthetic-${bot}-key`,
    connection: {
      id: bot,
      name: bot,
      baseURL: `https://${bot}.example.test/v1`,
      models: [
        {
          id: 'mock-chat',
          name: 'Synthetic chat',
          vision: false,
          contextWindow: 64000,
          maxTokens: 4096,
        },
      ],
    },
  });
  await models.profiles.register({
    id: bot,
    name: bot,
    color: 'mint',
    instructions: '',
    memory: '',
    model: `provider:${bot}:mock-chat`,
  });
  // Store reads stay empty until the restored journal has loaded.
  await models.ready;
  return models;
}

test.each([true, false])(
  'unfinished plans receive bounded continuation (finishes=%s)',
  async (finishes) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-completion-'));
    const bot = 'mock-completion';
    const prompts: string[] = [];
    const models = await insertFixture(root, {
      bot,
      prompts,
      entered: () => undefined,
      held: Promise.resolve(),
      observe: (observer, turn) =>
        observer.onNotification({
          method: 'session.event',
          params: {
            sessionId: `mock-${bot}-session`,
            event: {
              type: 'todo/write',
              data: {
                todos: [
                  {
                    content: 'Save eight synthetic rounds',
                    status: finishes && turn > 1 ? 'completed' : 'in_progress',
                  },
                ],
              },
            },
          },
        }),
    });
    try {
      await models.start(bot, {
        requestId: 'mock-completion-task',
        prompt: 'Save eight synthetic rounds.',
      });
      const job = models.jobs.get(bot)!;
      await job.done;
      expect(prompts).toHaveLength(finishes ? 2 : 3);
      expect(prompts[1]).toContain('unfinished');
      expect(job.phase).toBe(finishes ? 'completed' : 'failed');
      expect(job.error).toBe(finishes ? '' : 'TASK_INCOMPLETE');
      expect(job.turns).toHaveLength(1);
      expect(job.turns?.[0].result).toBe(job.result);
    } finally {
      await models.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a continuation durably owns all unstarted inserts independently of client acknowledgements', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-continue-handoff-'));
  const bot = 'mock-handoff';
  const prompts: string[] = [];
  const gates = insertGates();
  let fail = true;
  const models = await insertFixture(root, {
    bot,
    prompts,
    ...gates,
    failOn: (prompt) => fail && prompt === 'SYNTHETIC FAILED INSERT',
  });
  try {
    await models.start(bot, { requestId: 'mock-handoff-original', prompt: 'SYNTHETIC ORIGINAL' });
    await gates.started;
    const original = models.jobs.get(bot)!;
    for (const [id, text] of [
      ['mock-handoff-failed', 'SYNTHETIC FAILED INSERT'],
      ['mock-handoff-waiting', 'SYNTHETIC WAITING INSERT'],
    ]) {
      await models.insert(bot, { id, text, runId: original.id, chatRevision: 0 });
    }
    gates.release();
    await original.done;
    expect(original.phase).toBe('failed');
    fail = false;
    const retry = {
      requestId: 'mock-handoff-retry',
      prompt: 'SYNTHETIC FAILED INSERT',
      retryOf: original.id,
      retryTurn: 'mock-handoff-failed',
      chatRevision: 0,
    };
    // Drop the first acknowledgement and reconcile only after the entire continuation completes.
    await models.start(bot, retry);
    await models.jobs.get(bot)!.done;
    const count = prompts.length;
    const receipt = await models.start(bot, retry);
    expect(receipt.phase).toBe('completed');
    expect(prompts.length).toBe(count);
    expect(models.jobs.get(bot)!.turns?.map((turn) => turn.prompt)).toStrictEqual([
      retry.prompt,
      'SYNTHETIC WAITING INSERT',
    ]);
    expect(models.jobs.get(bot)!.inserts[0].done).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(models.jobs.get(bot)!.privateDir, 'turn.json'), 'utf8')),
    ).toStrictEqual({
      id: 'mock-handoff-waiting',
    });
    await expect(
      models.start(bot, { ...retry, requestId: 'mock-foreign-turn', retryTurn: 'mock-not-owned' }),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY' });
    await expect(
      models.start(bot, { ...retry, requestId: 'mock-altered-turn', prompt: 'SYNTHETIC ALTERED' }),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY' });
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a retried insert shares the first durable write instead of reporting an unpersisted acceptance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-write-'));
  const bot = 'mock-write';
  const prompts: string[] = [];
  const gates = insertGates();
  const models = await insertFixture(root, { bot, prompts, ...gates });
  try {
    await models.start(bot, {
      requestId: 'mock-write-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    const target = { runId: models.jobs.get(bot)!.id, chatRevision: 0 };
    const message = { id: 'mock-write-one', text: 'Synthetic inserted message.', ...target };
    const realPut = models.journal.put.bind(models.journal);
    models.journal.put = async (value) => {
      if ((value.inserts || []).some((item) => item.id === message.id))
        throw new Fault('SYNTHETIC_WRITE_FAILED', 500);
      return realPut(value);
    };
    const first = models.insert(bot, message);
    const retry = models.insert(bot, message);
    await expect(first).rejects.toMatchObject({ code: 'SYNTHETIC_WRITE_FAILED' });
    await expect(retry).rejects.toMatchObject({ code: 'SYNTHETIC_WRITE_FAILED' });
    expect(models.jobs.get(bot)!.inserts).toStrictEqual([]);
    models.journal.put = realPut;
    expect(await models.insert(bot, message)).toStrictEqual({ ok: true, id: message.id });
    gates.release();
    await models.jobs.get(bot)!.done;
    expect(prompts.length).toBe(2);
    expect(models.jobs.get(bot)!.phase).toBe('completed');
    expect((await models.journal.read(bot, target.runId))?.inserts).toStrictEqual([
      { id: message.id, text: message.text, done: true, started: true },
    ]);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent retries share one write so a transient failure cannot be half-applied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-shared-'));
  const bot = 'mock-shared';
  const prompts: string[] = [];
  const gates = insertGates();
  const models = await insertFixture(root, { bot, prompts, ...gates });
  try {
    await models.start(bot, {
      requestId: 'mock-shared-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    const target = { runId: models.jobs.get(bot)!.id, chatRevision: 0 };
    const message = { id: 'mock-shared-one', text: 'Synthetic inserted message.', ...target };
    const realPut = models.journal.put.bind(models.journal);
    let failed = false;
    models.journal.put = async (value) => {
      if ((value.inserts || []).some((item) => item.id === message.id) && !failed) {
        failed = true;
        throw new Fault('SYNTHETIC_WRITE_FAILED', 500);
      }
      return realPut(value);
    };
    const first = models.insert(bot, message);
    const retry = models.insert(bot, message);
    // Both requests observe the same failed write; neither can answer from an intent the journal rejected.
    await expect(first).rejects.toMatchObject({ code: 'SYNTHETIC_WRITE_FAILED' });
    await expect(retry).rejects.toMatchObject({ code: 'SYNTHETIC_WRITE_FAILED' });
    expect(models.jobs.get(bot)!.inserts).toStrictEqual([]);
    models.journal.put = realPut;
    expect(await models.insert(bot, message)).toStrictEqual({ ok: true, id: message.id });
    gates.release();
    await models.jobs.get(bot)!.done;
    expect(prompts.length).toBe(2);
    expect((await models.journal.read(bot, target.runId))?.inserts).toStrictEqual([
      { id: message.id, text: message.text, done: true, started: true },
    ]);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed write removes only its own insert instead of a neighbouring queued message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-rollback-'));
  const bot = 'mock-rollback';
  const prompts: string[] = [];
  const gates = insertGates();
  const models = await insertFixture(root, { bot, prompts, ...gates });
  try {
    await models.start(bot, {
      requestId: 'mock-rollback-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    const target = { runId: models.jobs.get(bot)!.id, chatRevision: 0 };
    const kept = { id: 'mock-rollback-kept', text: 'Synthetic kept message.', ...target };
    expect(await models.insert(bot, kept)).toStrictEqual({ ok: true, id: kept.id });
    const failing = { id: 'mock-rollback-failing', text: 'Synthetic failing message.', ...target };
    const realPut = models.journal.put.bind(models.journal);
    models.journal.put = async (value) => {
      if ((value.inserts || []).some((item) => item.id === failing.id))
        throw new Fault('SYNTHETIC_WRITE_FAILED', 500);
      return realPut(value);
    };
    const first = models.insert(bot, failing);
    const retry = models.insert(bot, failing);
    await expect(first).rejects.toMatchObject({ code: 'SYNTHETIC_WRITE_FAILED' });
    await expect(retry).rejects.toMatchObject({ code: 'SYNTHETIC_WRITE_FAILED' });
    // A missing index must never make rollback pop the last accepted message.
    expect(models.jobs.get(bot)!.inserts.map((item) => item.id)).toStrictEqual([kept.id]);
    models.journal.put = realPut;
    gates.release();
    await models.jobs.get(bot)!.done;
    expect(models.jobs.get(bot)!.turns?.map((turn) => turn.prompt)).toStrictEqual([
      'Synthetic original request.',
      kept.text,
    ]);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an accepted insert keeps its text after a restart and is not reported as processed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-restart-'));
  const bot = 'mock-restart';
  const prompts: string[] = [];
  const gates = insertGates();
  const before = await insertFixture(root, { bot, prompts, ...gates });
  const pending = {
    id: 'mock-restart-pending',
    text: 'Synthetic inserted message.',
  };
  let runId = '';
  try {
    await before.start(bot, {
      requestId: 'mock-restart-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    runId = before.jobs.get(bot)!.id;
    expect(await before.insert(bot, { ...pending, runId, chatRevision: 0 })).toStrictEqual({
      ok: true,
      id: pending.id,
    });
  } finally {
    // Abort before the held turn returns, so the accepted insert is never processed.
    const stopping = before.stop(bot);
    gates.release();
    await stopping;
  }
  expect((await before.journal.read(bot, runId))?.inserts).toStrictEqual([
    { ...pending, done: false },
  ]);
  await before.close();
  const restarted = await insertFixture(root, { bot, prompts, ...gates });
  try {
    // The saved text is what a requeue can rely on; an unprocessed insert is never an acceptance.
    expect((await restarted.journal.read(bot, runId))?.inserts).toStrictEqual([
      { ...pending, done: false },
    ]);
    await expect(
      restarted.insert(bot, { ...pending, runId, chatRevision: 0 }),
    ).rejects.toMatchObject({
      code: 'MODEL_NOT_RUNNING',
    });
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a restored task keeps its turns and unstarted inserts so continuing resumes the failed insert', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-continue-'));
  const bot = 'mock-continue';
  const prompts: string[] = [];
  const gates = insertGates();
  const failed = { id: 'mock-continue-failed', text: 'Synthetic failed insert.' };
  const waiting = { id: 'mock-continue-waiting', text: 'Synthetic waiting insert.' };
  const before = await insertFixture(root, {
    bot,
    prompts,
    ...gates,
    failOn: (prompt) => prompt === failed.text,
  });
  let runId = '';
  try {
    await before.start(bot, {
      requestId: 'mock-continue-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    runId = before.jobs.get(bot)!.id;
    // Both inserts are accepted before the original turn returns, so the second is still unstarted when the first fails.
    for (const insert of [failed, waiting])
      expect(await before.insert(bot, { ...insert, runId, chatRevision: 0 })).toStrictEqual({
        ok: true,
        id: insert.id,
      });
    gates.release();
    await before.jobs.get(bot)!.done;
    expect(before.jobs.get(bot)!.phase).toBe('failed');
  } finally {
    await before.close();
  }
  const restarted = await insertFixture(root, { bot, prompts: [], ...insertGates() });
  try {
    const job = restarted.jobs.get(bot)!;
    expect(job.turns?.map((turn) => [turn.id, turn.prompt, turn.result])).toStrictEqual([
      ['mock-continue-first', 'Synthetic original request.', 'Synthetic first reply.'],
      [failed.id, failed.text, ''],
    ]);
    expect(job.inserts).toStrictEqual([
      { ...failed, done: false, started: true },
      { ...waiting, done: false },
    ]);
    const exposed = restarted.status().bots[bot];
    expect(exposed.turns).toStrictEqual(job.turns);
    expect(exposed.inserts).toStrictEqual(job.inserts);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an insert that began before the model failed is never reported as unattempted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-begun-'));
  const bot = 'mock-begun';
  const prompts: string[] = [];
  const gates = insertGates();
  const message = { id: 'mock-begun-one', text: 'Synthetic insert that begins.' };
  const before = await insertFixture(root, {
    bot,
    prompts,
    ...gates,
    gateOn: (prompt) => prompt === message.text,
    failOn: (prompt) => prompt === message.text,
  });
  let runId = '';
  try {
    await before.start(bot, {
      requestId: 'mock-begun-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    runId = before.jobs.get(bot)!.id;
    expect(await before.insert(bot, { ...message, runId, chatRevision: 0 })).toStrictEqual({
      ok: true,
      id: message.id,
    });
    gates.release();
    await gates.gateReached;
    await before.jobs.get(bot)!.done;
    expect(before.jobs.get(bot)!.phase).toBe('failed');
    // The start marker is durable: a reconnect may have produced files or tool effects already.
    expect((await before.journal.read(bot, runId))?.inserts).toStrictEqual([
      { ...message, done: false, started: true },
    ]);
    await expect(before.insert(bot, { ...message, runId, chatRevision: 0 })).rejects.toMatchObject({
      code: 'MODEL_INSERT_UNCERTAIN',
    });
  } finally {
    await before.close();
  }
  const restarted = await insertFixture(root, { bot, prompts: [], ...insertGates() });
  try {
    await expect(
      restarted.insert(bot, { ...message, runId, chatRevision: 0 }),
    ).rejects.toMatchObject({
      code: 'MODEL_INSERT_UNCERTAIN',
    });
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('insert acceptance counts every turn so stored history stays within the turn bound', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-bound-'));
  const bot = 'mock-bound';
  const prompts: string[] = [];
  const gates = insertGates();
  const models = await insertFixture(root, {
    bot,
    prompts,
    ...gates,
    gateOn: (prompt) => prompt === 'Synthetic insert 2.',
  });
  try {
    await models.start(bot, {
      requestId: 'mock-bound-first',
      prompt: 'Synthetic original request.',
    });
    await gates.started;
    const target = { runId: models.jobs.get(bot)!.id, chatRevision: 0 };
    const id = (index: number) => `mock-bound-${String(index).padStart(2, '0')}`;
    const send = (index: number) =>
      models.insert(bot, { id: id(index), text: `Synthetic insert ${index}.`, ...target });
    for (let index = 1; index < turnLimit; index++)
      expect(await send(index)).toStrictEqual({ ok: true, id: id(index) });
    await expect(send(turnLimit)).rejects.toMatchObject({ code: 'MODEL_INSERT_FULL' });
    gates.release();
    await gates.gateReached;
    // Two turns are already stored while the second insert runs, so the bound still counts them.
    expect(models.jobs.get(bot)!.turns?.length).toBe(3);
    await expect(send(turnLimit)).rejects.toMatchObject({ code: 'MODEL_INSERT_FULL' });
    gates.gate();
    await models.jobs.get(bot)!.done;
    expect(models.jobs.get(bot)!.turns?.length).toBe(turnLimit);
    const page = await models.chatHistory(bot, 0);
    expect(page.items.length).toBe(1);
    expect(page.items[0].turns?.length).toBe(turnLimit);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a rebuilt context keeps every saved turn instead of only the original request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-insert-context-'));
  const bot = 'mock-context';
  const prompts: string[] = [];
  const journal = new TaskJournal(path.join(root, 'model', 'task-journal'));
  await journal.load();
  await journal.put({
    bot,
    runId: 'mock-context-saved',
    requestId: 'mock-context-saved-request',
    chatRevision: 0,
    kind: 'chat',
    prompt: 'Synthetic original request.',
    phase: 'completed',
    running: false,
    result: 'Synthetic final reply.',
    error: '',
    trace: [],
    turns: [
      {
        id: 'mock-context-saved-request',
        prompt: 'Synthetic original request.',
        result: 'Synthetic first reply.',
      },
      {
        id: 'mock-context-insert',
        prompt: 'Synthetic inserted requirement.',
        result: 'Synthetic inserted reply.',
      },
    ],
  });
  const models = await insertFixture(root, {
    bot,
    prompts,
    ...insertGates(),
    entered: () => {},
    held: Promise.resolve(),
  });
  try {
    await models.start(bot, {
      requestId: 'mock-context-next',
      prompt: 'Synthetic next request.',
    });
    await models.jobs.get(bot)!.done;
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toMatch(/Synthetic inserted requirement\./);
    expect(prompts[0]).toMatch(/Synthetic inserted reply\./);
    expect(prompts[0]).toMatch(/Synthetic first reply\./);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('two suppliers with the same API model keep separate keys, capabilities and native session bindings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-supplier-routes-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-chat' }] }),
  );
  const captured: { provider: string; model: string; env: NodeJS.ProcessEnv }[] = [];
  const resumed: string[] = [];
  let session = 0;
  class Harness {
    constructor(options: { provider: string; model: string; env: NodeJS.ProcessEnv }) {
      captured.push(options);
    }
    async start() {}
    async close() {}
    session(id = `mock-session-${++session}`) {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'Synthetic completed.' }) };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    Harness,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  });
  const connection = (id: string, vision: boolean) => ({
    id,
    name: id,
    baseURL: `https://${id}.example.test/v1`,
    models: [
      { id: 'mock-chat', name: 'Synthetic chat', vision, contextWindow: 64000, maxTokens: 4096 },
    ],
  });
  try {
    for (const [index, id] of ['mock-one', 'mock-two'].entries())
      await settings.configure({
        revision: index,
        requestId: `mock-config-${index}`,
        model: 'provider:mock-one:mock-chat',
        apiKey: `synthetic-key-${id}`,
        connection: connection(id, index === 1),
      });
    for (const [id, supplier] of [
      ['mock-a', 'mock-one'],
      ['mock-b', 'mock-two'],
    ])
      await models.profiles.register({
        id,
        name: id,
        color: 'mint',
        instructions: '',
        memory: '',
        model: `provider:${supplier}:mock-chat`,
      });
    const run = async (bot: string, requestId: string) => {
      await models.start(bot, { requestId, prompt: 'Synthetic request.' });
      await models.jobs.get(bot)!.done;
      expect(models.jobs.get(bot)!.phase).toBe('completed');
    };
    await run('mock-a', 'mock-one-first');
    await run('mock-b', 'mock-two-first');
    expect(captured.map(({ provider, model }) => [provider, model])).toStrictEqual([
      ['mock-one', 'mock-chat'],
      ['mock-two', 'mock-chat'],
    ]);
    expect(captured[0].env.DABAN_MODEL_KEY).toBe('synthetic-key-mock-one');
    expect(captured[1].env.DABAN_MODEL_KEY).toBe('synthetic-key-mock-two');
    expect(captured[0].env.DEEPSEEK_API_KEY).toBe(undefined);
    expect(models.jobs.get('mock-a')!.vision).toBe(false);
    expect(models.jobs.get('mock-b')!.vision).toBe(true);
    await run('mock-a', 'mock-one-same-route');
    expect(resumed.length).toBe(1);
    await settings.configure({
      revision: 2,
      requestId: 'mock-one-edit',
      model: 'provider:mock-one:mock-chat',
      apiKey: 'synthetic-rotated-key',
      connection: { ...connection('mock-one', true), baseURL: 'https://new-route.example.test/v1' },
    });
    await run('mock-a', 'mock-one-changed-route');
    expect(resumed.length, 'a changed endpoint or credential must retire the native session').toBe(
      1,
    );
    expect(captured.at(-1)!.env.DABAN_MODEL_KEY).toBe('synthetic-rotated-key');
    expect(captured[0].env.DABAN_MODEL_KEY).toBe('synthetic-key-mock-one');
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host DSH callbacks and MCP stdio use only the private agent socket', () => {
  const patch = sdkPatch(
    'http://127.0.0.1:8766',
    'mock-bot',
    'mock-capability',
    { requestId: 'mock-host-patch', prompt: 'Mock request.' },
    60,
    'deepseek-flash',
    { available: true, key: '', skills: [] },
    { socketPath: '/mock/private/agent.sock', stdioEntry: '/mock/owned/mcp-stdio.js' },
  );
  const plugins = patch.flatMap((entry) => ('insert' in entry ? entry.insert : []));
  for (const id of ['human-bridge', 'response-stream']) {
    const plugin = plugins.find((entry) => entry.id === id)!;
    expect((plugin as unknown as { config: { socketPath: string } }).config.socketPath).toBe(
      '/mock/private/agent.sock',
    );
  }
  const mcp = (
    plugins.find((entry) => entry.id === 'computer-tools')! as unknown as {
      config: Record<string, unknown>;
    }
  ).config;
  expect(mcp.transport).toBe('stdio');
  expect(mcp.command).toBe(process.execPath);
  expect(mcp.args).toStrictEqual(['/mock/owned/mcp-stdio.js']);
  expect(
    Object.keys(mcp.env as object)
      .filter((key) => key !== 'ELECTRON_RUN_AS_NODE')
      .sort(),
  ).toStrictEqual(['DABAN_AGENT_BOT', 'DABAN_AGENT_CAPABILITY', 'DABAN_AGENT_SOCKET']);
  expect('url' in mcp).toBe(false);
  expect('headers' in mcp).toBe(false);
});

test('host model admission fences computer changes and RPC cannot forge VM command approvals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-host-command-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let admitted = false;
  let enter!: () => unknown;
  let release!: () => unknown;
  const entered = new Promise<unknown>((resolve) => {
    enter = () => resolve(undefined);
  });
  const held = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session() {
      return {
        id: 'mock-private-session',
        run: async () => {
          enter();
          await held;
          return { sessionId: 'mock-private-session', finalResponse: 'Mock completed' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const models = new ModelRuns({
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:8766',
    Harness,
    admitBot: () => admitted,
  });
  try {
    await settings.save({ apiKey: 'synthetic-host-command-key' });
    const task = { requestId: 'mock-command-model', prompt: 'Mock command task' };
    await expect(models.start('mock-bot', task)).rejects.toMatchObject({
      code: 'COMPUTER_CHANGING',
    });
    expect(models.jobs.size).toBe(0);
    admitted = true;
    await models.start('mock-bot', task);
    await entered;
    const job = models.jobs.get('mock-bot')!;
    await expect(
      models.rpc('mock-bot', `Bearer ${job.token}`, {
        id: 1,
        method: 'interaction.open',
        params: {
          id: 'mock-forged-command',
          sessionId: job.sessionId,
          kind: 'approval',
          tool: 'vm_command',
          command: 'echo mock',
          cwd: job.workdir,
          purpose: 'Mock request',
          target: 'linux-vm',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
    expect(await models.interactions.list()).toStrictEqual([]);
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model preparation and output collection use guest workspace references while DSH evidence stays local', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-remote-model-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let configuredCwd = '';
  let failDrain = false;
  class Harness {
    constructor(options: { cwd: string }) {
      configuredCwd = options.cwd;
    }
    async start() {}
    async close() {}
    session(id = 'mock-remote-session') {
      return {
        id,
        run: async () => ({ sessionId: id, finalResponse: 'Mock remote task complete.' }),
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const execution = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'tools.open') return { tools: [] };
      if (method === 'tools.drain' && failDrain) throw new Error('MOCK_GUEST_DRAIN_OFFLINE');
      if (method === 'workspace.base') return params.root || '/mock-guest/shared';
      if (method === 'workspace.create') {
        const directory = `/mock-guest/shared/${(params.parts as string[]).join('/')}`;
        return {
          root: '/mock-guest/shared',
          path: directory,
          canonical: directory,
          handleId: 'mock-task-handle',
        };
      }
      if (method === 'workspace.list')
        return [
          { path: 'mock-output.txt', name: 'mock-output.txt', size: 4, modified: 'mock-time' },
        ];
      if (method === 'workspace.read')
        return {
          path: params.path,
          name: 'mock-input.txt',
          content: 'SYNTHETIC INPUT',
          size: 15,
          modified: 'mock-time',
        };
      return { ok: true };
    },
  };
  const workspace = new RemoteWorkspace(execution);
  const models = new ModelRuns({
    settings,
    workspace,
    execution,
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  try {
    await settings.save({ apiKey: 'synthetic-remote-model-key' });
    await models.start('mock-bot', {
      requestId: 'mock-remote-request',
      prompt: 'Create mock output.',
      files: [{ name: 'mock-input.txt', content: 'mock input' }],
    });
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase).toBe('completed');
    expect.assert(job.workdir.startsWith('/mock-guest/shared/'));
    expect.assert(configuredCwd.startsWith(path.join(root, 'model', 'runs')));
    expect(await readFile(path.join(configuredCwd, 'result.json'), 'utf8')).toMatch(
      /mock-remote-session/,
    );
    expect(job.files[0].name).toBe('mock-output.txt');
    expect(job.files[0].path).toBe(
      path.posix.relative('/mock-guest/shared', path.posix.join(job.workdir, 'mock-output.txt')),
    );
    expect(calls.filter((call) => call.method === 'workspace.write').length).toBe(1);
    expect.assert(
      calls.some((call) => call.method === 'workspace.list' && call.params.root === job.workdir),
    );
    await models.start('mock-bot', {
      requestId: 'mock-remote-retry',
      prompt: 'Retry the synthetic task.',
      retryOf: job.id,
    });
    const retry = models.jobs.get('mock-bot')!;
    await retry.done;
    expect(retry.phase, retry.error).toBe('completed');
    expect.assert(
      calls.some(
        (call) =>
          call.method === 'workspace.read' &&
          call.params.path ===
            path.posix.relative(
              '/mock-guest/shared',
              path.posix.join(job.workdir, 'mock-input.txt'),
            ),
      ),
    );
    failDrain = true;
    await models.start('mock-other-bot', {
      requestId: 'mock-drain-failure',
      prompt: 'Mock daemon failure.',
    });
    const failed = models.jobs.get('mock-other-bot')!;
    const outcome = await Promise.allSettled([failed.done]);
    expect(outcome[0].status).toBe('fulfilled');
    expect(failed.running).toBe(false);
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe('EXECUTOR_DRAIN_UNAVAILABLE');
    failDrain = false;
  } finally {
    await models.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('restarted task summaries retain durable counts and safe short traces without replaying tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-restored-activity-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const directory = path.join(root, 'model');
  const journal = new TaskJournal(path.join(directory, 'task-journal'));
  let starts = 0;
  class Harness {
    async start() {
      starts++;
    }
    async close() {}
    session(id = 'mock-fresh-session') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'MOCK-FRESH-REPLY' }) };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const options = {
    settings,
    dir: directory,
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  };
  const trace = Array.from({ length: 20 }, (_, i) => ({
    name: `mock-tool-${i}`,
    surface: 'workspace',
    phase: i === 17 ? 'rejected' : 'settled',
    at: new Date(1800000000000 + i * 1000).toISOString(),
    ...(i === 17 ? { code: 'MOCK_REJECTED' } : {}),
    args: { private: 'MOCK-PRIVATE-ARGUMENT' },
    token: 'MOCK-PRIVATE-CAPABILITY',
  }));
  const base: TaskRecord = {
    bot: 'mock-completed',
    runId: 'mock-restored-run',
    requestId: 'mock-restored-request',
    chatRevision: 0,
    kind: 'chat',
    prompt: '合成任务',
    phase: 'completed',
    running: false,
    result: 'MOCK-SAVED-REPLY',
    error: '',
    toolCount: 60,
    executedCount: 55,
    trace,
  };
  let models: ModelRuns | undefined;
  try {
    await journal.load();
    await journal.put(base);
    await journal.put({
      ...base,
      bot: 'mock-interrupted',
      runId: 'mock-interrupted-run',
      requestId: 'mock-interrupted-request',
      phase: 'running',
      running: true,
      executedCount: 4,
      trace: [...trace.slice(0, 2), { ...trace[2], phase: 'running' }],
    });
    await journal.put({
      ...base,
      bot: 'mock-legacy',
      runId: 'mock-legacy-run',
      executedCount: undefined,
      trace: [trace[0], trace[17], null, { name: 7, phase: 'settled' }],
    });
    await journal.put({
      ...base,
      bot: 'mock-group-bot',
      runId: 'mock-group-run',
      conversationId: 'mock-group',
      executedCount: 14,
      trace: trace.slice(0, 2),
    });
    await writeFile(
      path.join(journal.dir, 'mock-corrupt-run.json'),
      JSON.stringify({
        version: 1,
        task: {
          ...base,
          bot: 'mock-corrupt',
          runId: 'mock-corrupt-run',
          executedCount: 'MOCK-NOT-A-COUNT',
          trace: { untrusted: true },
        },
      }),
    );
    const file = path.join(journal.dir, `${base.runId}.json`);
    const original = await readFile(file);
    models = new ModelRuns(options);
    await models.ready;
    const completed = models.status().bots[base.bot];
    expect(completed.executedCount, 'the bounded trace is not the total count').toBe(55);
    expect(completed.toolCount).toBe(60);
    expect(completed.trace).toStrictEqual(
      trace.slice(-8).map(({ name, surface, phase, at, code }) => ({
        name,
        surface,
        phase,
        at,
        ...(code ? { code } : {}),
      })),
    );
    expect.assert(!JSON.stringify(completed.trace).includes('MOCK-PRIVATE'));
    const originalTrace = structuredClone(completed.trace);
    models.status().bots[base.bot].trace![0].name = 'MOCK-CALLER-CHANGE';
    expect(models.status().bots[base.bot].trace).toStrictEqual(originalTrace);
    const interrupted = models.status().bots['mock-interrupted'];
    expect(interrupted.phase).toBe('interrupted');
    expect(interrupted.running).toBe(false);
    expect(interrupted.executedCount).toBe(4);
    expect(interrupted.trace?.at(-1)?.phase).toBe('running');
    expect(models.status().bots['mock-legacy'].executedCount).toBe(1);
    expect(models.status().bots['mock-legacy'].trace?.length).toBe(2);
    expect(models.status().bots['mock-group-bot'].executedCount).toBe(14);
    expect(models.status().bots['mock-group-bot'].conversationId).toBe('mock-group');
    expect(models.status().bots['mock-corrupt'].executedCount).toBe(0);
    expect(models.status().bots['mock-corrupt'].trace).toStrictEqual([]);
    expect(starts, 'reading restored summaries must not start the harness').toBe(0);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    expect(models.status().bots[base.bot]).toStrictEqual(completed);
    expect(await readFile(file), 'restoration must not rewrite the receipt').toStrictEqual(
      original,
    );
    await models.chats.renew({ bot: base.bot, id: 'mock-fresh-context', revision: 0 });
    expect(models.status().bots[base.bot].executedCount).toBe(0);
    expect(models.status().bots[base.bot].trace).toBe(undefined);
    await models.profiles.register({
      id: base.bot,
      name: '合成恢复 Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await settings.save({ apiKey: 'mock-new-turn-key' });
    await models.start(base.bot, {
      requestId: 'mock-fresh-turn',
      prompt: '合成新对话',
      chatRevision: 1,
    });
    await models.jobs.get(base.bot)!.done;
    expect(models.status().bots[base.bot].executedCount).toBe(0);
    expect(models.status().bots[base.bot].trace).toStrictEqual([]);
    expect(starts).toBe(1);
  } finally {
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH profile disables unscoped native tools and registers a scoped tool server', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'a', 'synthetic-capability');
  const compaction = patch.find((row) => 'id' in row && row.id === 'compaction-basic');
  expect.assert(compaction && 'config' in compaction);
  expect((compaction.config as { thresholdRatio: number }).thresholdRatio).toBe(0.8);
  const disabled = patch.filter((row) => 'disabled' in row);
  for (const id of ['persistent-bash', 'persistent-pwsh', 'tool-fs', 'tool-working-directory'])
    expect(disabled.find((row) => row.id === id)!.disabled).toBe(true);
  expect(disabled.find((row) => row.id === 'llm-deepseek')!.disabled).toBe(true);
  const provider = patch
    .find((row) => 'insert' in row)!
    .insert.find((row) => row.id === 'desktop-model-provider')!;
  expect.assert('config' in provider && 'providers' in provider.config);
  expect(provider.config.providers['deepseek-official'].api).toBe('openai-completions');
  expect(provider.config.providers['deepseek-official'].baseURL).toBe(
    'https://api.deepseek.com/v1',
  );
  const entry = patch
    .find((row) => 'insert' in row)!
    .insert.find((row) => row.id === 'computer-tools')!;
  expect.assert('config' in entry && 'toolCallTimeoutMs' in entry.config && 'url' in entry.config);
  expect.assert(
    entry.config.toolCallTimeoutMs >= 60 * 60 * 1000,
    'human takeover must not inherit a short tool timeout',
  );
  expect(entry.config.url).toBe('http://127.0.0.1:12345/mcp/a');
  expect(provider.config.providers['deepseek-official'].apiKeyEnv).toBe('DEEPSEEK_API_KEY');
  expect(Object.hasOwn(provider.config.providers['deepseek-official'], 'apiKey')).toBe(false);
});

test('general DSH tasks enable the stock anonymous fetch provider and a shared tool budget', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'chief', 'synthetic-capability', {
    requestId: 'mock-web',
    prompt: '读取 https://example.test/',
  });
  const plugins = patch.find((row) => 'insert' in row)!.insert;
  expect.assert(plugins.some((row) => row.name === '@deepseek-ai/dsh-web'));
  expect.assert(plugins.some((row) => row.id === 'web-fetch-http' && row.name.endsWith('/web.js')));
  const web = plugins.find((row) => row.id === 'tool-web');
  expect.assert(web && 'config' in web);
  expect(web.config).toStrictEqual({
    search: true,
    fetch: false,
    searchMaxResults: 5,
    searchMaxQueries: 4,
    searchTimeoutMs: 30000,
  });
  expect.assert(plugins.some((row) => row.id === 'web-read' && row.name.endsWith('/web-read.js')));
  const search = plugins.find((row) => row.id === 'web-deepseek-api');
  expect.assert(search && 'config' in search);
  expect(search.config).toStrictEqual({
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1/tools',
    count: 5,
    sendOriginalQuestion: false,
  });
  expect.assert(plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-call-timeout-policy'));
  const budget = plugins.find((row) => row.id === 'daban-policy');
  expect.assert(budget && 'config' in budget);
  expect(budget.config).toStrictEqual({
    limit: 60,
    urls: ['https://example.test/'],
    url: 'http://127.0.0.1:12345/mcp/chief',
    capability: 'synthetic-capability',
  });
  const diagnostic = sdkPatch('http://127.0.0.1:12345', 'a', 'synthetic-capability');
  expect.assert(
    diagnostic.find((row) => 'insert' in row)!.insert.some((row) => row.id === 'approval'),
  );
  expect(
    diagnostic.find((row) => 'insert' in row)!.insert.some((row) => row.id === 'tool-web'),
  ).toBe(false);
});

test('task verification requires actual correct files and rejects symlink escapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-result-'));
  try {
    const file = path.join(dir, 'report-a.txt');
    await expect(verifyOutput('a', dir)).rejects.toThrowError();
    await writeFile(file, 'paid_count=4\npaid_total=999\nshared_login=true\n');
    expect((await verifyOutput('a', dir)).passed).toBe(false);
    await writeFile(file, 'paid_count=4\npaid_total=550\nshared_login=true\n');
    expect((await verifyOutput('a', dir)).passed).toBe(true);
    const runtime = {
      screens: { windows: async (): Promise<{ class: string; title: string }[]> => [] },
    };
    expect(
      (await verifyTask('a', dir, runtime)).passed,
      'a file alone does not prove the GUI task finished',
    ).toBe(false);
    runtime.screens.windows = async () => [
      { class: 'mousepad.Mousepad', title: `${file} - Mousepad` },
    ];
    expect((await verifyTask('a', dir, runtime)).passed).toBe(true);
    await rm(file);
    await symlink('/etc/hosts', file);
    await expect(verifyOutput('a', dir)).rejects.toMatchObject({ code: 'FILE_NOT_READABLE' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native editor title verification accepts home abbreviation for the same exact file', () => {
  const file = '/home/synthetic-user/tasks/run-123/report-a.txt';
  expect(
    editorShowsFile(
      [{ class: 'mousepad.Mousepad', title: '~/tasks/run-123/report-a.txt - Mousepad' }],
      file,
      '/home/synthetic-user',
    ),
  ).toBe(true);
  expect(
    editorShowsFile(
      [{ class: 'mousepad.Mousepad', title: '~/tasks/other-run/report-a.txt - Mousepad' }],
      file,
      '/home/synthetic-user',
    ),
  ).toBe(false);
});

test('report verification cannot return private bytes when a checked public file is replaced by a link', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-report-link-race-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report-a.txt'),
    secret = path.join(tmpdir(), `mock-private-report-${path.basename(root)}.txt`);
  t.onTestFinished(() => rm(secret, { force: true }));
  await writeFile(report, 'paid_count=4\npaid_total=550\nshared_login=true');
  await writeFile(secret, 'SYNTHETIC-PRIVATE-47');
  const canonicalReport = await fs.realpath(report);
  const original = fs.realpath;
  let replaced = false;
  vi.spyOn(fs, 'realpath').mockImplementation(async (file: Parameters<typeof original>[0]) => {
    const result = await original(file);
    if ((file === report || result === canonicalReport) && !replaced) {
      replaced = true;
      await fs.rm(report);
      await fs.symlink(secret, report);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.onTestFinished(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  await expect(verifyOutput('a', root)).rejects.toThrowError();
  expect(replaced).toBe(true);
});

test('enabling Linux retires a native-only SDK context while preserving saved conversation turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-execution-context-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
    Response.json({ data: [{ id: 'mock-chat' }] }),
  );
  const resumed: string[] = [];
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-native-context') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'Synthetic response.' }) };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    Harness,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns({ ...options, nativeOnly: true });
  try {
    await settings.configure({
      revision: 0,
      requestId: 'mock-config',
      model: 'provider:mock:mock-chat',
      apiKey: 'synthetic-key',
      connection: {
        id: 'mock',
        name: 'Synthetic',
        baseURL: 'https://example.test/v1',
        models: [
          {
            id: 'mock-chat',
            name: 'Synthetic',
            vision: false,
            contextWindow: 64000,
            maxTokens: 4096,
          },
        ],
      },
    });
    await models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await models.start('mock-bot', { requestId: 'mock-first', prompt: 'Synthetic first turn.' });
    await models.jobs.get('mock-bot')!.done;
    expect(models.jobs.get('mock-bot')!.phase).toBe('completed');
    await models.close();
    models = new ModelRuns({ ...options, nativeOnly: false });
    await models.start('mock-bot', { requestId: 'mock-second', prompt: 'Synthetic second turn.' });
    await models.jobs.get('mock-bot')!.done;
    expect(models.jobs.get('mock-bot')!.phase).toBe('completed');
    expect(resumed).toStrictEqual([]);
    expect.assert(models.jobs.get('mock-bot')!.prompt?.includes('Synthetic first turn.'));
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
