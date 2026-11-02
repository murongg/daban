import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { turnLimit } from '@daban/protocol';
import { Fault } from './control.js';
import { editorShowsFile, ModelRuns, sdkPatch, verifyOutput, verifyTask } from './model.js';
import { RemoteWorkspace } from './remote-workspace.js';
import { ModelSettings } from './settings.js';
import { TaskJournal, type TaskRecord } from './tasks.js';

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
      assert.ok(snapshot, 'SDK startup must receive a private diagnostic checkpoint');
      assert.ok(this.options.env.NODE_OPTIONS?.includes('dsh-preload.js'));
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
    assert.equal(job.phase, 'failed');
    const text = await readFile(path.join(root, 'model/dsh-startup.log'), 'utf8');
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('SYNTHETIC PRIVATE CHAT'), false);
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.stage === 'sdk-loading'));
    const failure = records.find((record) => record.stage === 'initialize-failed');
    assert.ok(failure);
    assert.equal(failure.runId, job.id);
    assert.ok(failure.snapshot.stderr.includes('[credential redacted]'));
    await assert.rejects(readFile(snapshot), { code: 'ENOENT' });
    initializeFails = false;
    closeFails = true;
    await models.start('mock-bot', {
      requestId: 'mock-after-startup',
      prompt: 'SYNTHETIC PRIVATE CHAT',
    });
    await models.jobs.get('mock-bot')!.done;
    assert.equal(
      (await readFile(path.join(root, 'model/dsh-startup.log'), 'utf8')).includes(
        'SYNTHETIC SHUTDOWN CHAT',
      ),
      false,
    );
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
    assert.ok(profiles[key], api);
    assert.equal(profiles[key].api, expectedApi, api);
    assert.equal(profiles[key].apiKeyEnv, 'DABAN_MODEL_KEY');
    assert.equal(profiles[key].baseURL, route.baseURL);
    assert.equal(route.provider, 'mock-native');
    assert.equal(JSON.stringify(patch).includes(route.apiKey), false);
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
  assert.equal(config.providers['mock-supplier']?.apiKeyEnv, 'DABAN_MODEL_KEY');
  assert.equal(config.providers['mock-supplier']?.baseURL, route.baseURL);
  assert.deepEqual(config.providers['mock-supplier']?.models, [
    {
      id: 'mock-chat',
      input: ['text'],
      contextWindow: 64000,
      maxTokens: 4096,
      reasoningEfforts: false,
    },
  ]);
  assert.equal(
    plugins.some((entry) => entry.id === 'web-deepseek-api'),
    false,
  );
  const web = plugins.find((entry) => entry.id === 'tool-web')!;
  assert.equal((web as unknown as { config: { search: boolean } }).config.search, false);
  assert.equal(JSON.stringify(patch).includes(route.apiKey), false);
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
    await assert.rejects(
      models.insert('mock-insert', {
        id: 'mock-insert-stale',
        text: 'Synthetic stale message.',
        runId: 'mock-insert-other-run',
        chatRevision: 0,
      }),
      { code: 'TASK_INSERT_STALE' },
    );
    assert.deepEqual(
      await models.insert('mock-insert', {
        id: 'mock-insert-one',
        text: 'Synthetic inserted message.',
        ...target,
      }),
      { ok: true, id: 'mock-insert-one' },
    );
    assert.deepEqual(
      await models.insert('mock-insert', {
        id: 'mock-insert-one',
        text: 'Synthetic ignored duplicate.',
        ...target,
      }),
      { ok: true, id: 'mock-insert-one' },
    );
    release();
    await models.jobs.get('mock-insert')!.done;
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Synthetic original request\./);
    assert.equal(prompts[1], 'Synthetic inserted message.');
    assert.equal(models.jobs.get('mock-insert')!.result, 'Synthetic inserted reply.');
    assert.equal(models.jobs.get('mock-insert')!.phase, 'completed');
    assert.deepEqual(models.jobs.get('mock-insert')!.turns, [
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
    assert.deepEqual(
      await models.insert('mock-insert', {
        id: 'mock-insert-one',
        text: 'Synthetic ignored duplicate.',
        ...target,
      }),
      { ok: true, id: 'mock-insert-one' },
    );
    await assert.rejects(
      models.insert('mock-insert', {
        id: 'mock-insert-late',
        text: 'Synthetic late message.',
        ...target,
      }),
      { code: 'MODEL_NOT_RUNNING' },
    );
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
}
function insertHarness(state: InsertState) {
  return class Harness {
    async start() {}
    async close() {}
    session(id = `mock-${state.bot}-session`) {
      return {
        id,
        run: async (input: unknown) => {
          const blocks =
            typeof input === 'string'
              ? []
              : (input as { type: 'text'; text: string }[]).filter(
                  (block) => block.type === 'text',
                );
          const prompt =
            typeof input === 'string' ? input : blocks.map((block) => block.text).join('\n');
          state.prompts.push(prompt);
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
    await assert.rejects(first, { code: 'SYNTHETIC_WRITE_FAILED' });
    await assert.rejects(retry, { code: 'SYNTHETIC_WRITE_FAILED' });
    assert.deepEqual(models.jobs.get(bot)!.inserts, []);
    models.journal.put = realPut;
    assert.deepEqual(await models.insert(bot, message), { ok: true, id: message.id });
    gates.release();
    await models.jobs.get(bot)!.done;
    assert.equal(prompts.length, 2);
    assert.equal(models.jobs.get(bot)!.phase, 'completed');
    assert.deepEqual((await models.journal.read(bot, target.runId))?.inserts, [
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
    await assert.rejects(first, { code: 'SYNTHETIC_WRITE_FAILED' });
    await assert.rejects(retry, { code: 'SYNTHETIC_WRITE_FAILED' });
    assert.deepEqual(models.jobs.get(bot)!.inserts, []);
    models.journal.put = realPut;
    assert.deepEqual(await models.insert(bot, message), { ok: true, id: message.id });
    gates.release();
    await models.jobs.get(bot)!.done;
    assert.equal(prompts.length, 2);
    assert.deepEqual((await models.journal.read(bot, target.runId))?.inserts, [
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
    assert.deepEqual(await models.insert(bot, kept), { ok: true, id: kept.id });
    const failing = { id: 'mock-rollback-failing', text: 'Synthetic failing message.', ...target };
    const realPut = models.journal.put.bind(models.journal);
    models.journal.put = async (value) => {
      if ((value.inserts || []).some((item) => item.id === failing.id))
        throw new Fault('SYNTHETIC_WRITE_FAILED', 500);
      return realPut(value);
    };
    const first = models.insert(bot, failing);
    const retry = models.insert(bot, failing);
    await assert.rejects(first, { code: 'SYNTHETIC_WRITE_FAILED' });
    await assert.rejects(retry, { code: 'SYNTHETIC_WRITE_FAILED' });
    // A missing index must never make rollback pop the last accepted message.
    assert.deepEqual(
      models.jobs.get(bot)!.inserts.map((item) => item.id),
      [kept.id],
    );
    models.journal.put = realPut;
    gates.release();
    await models.jobs.get(bot)!.done;
    assert.deepEqual(
      models.jobs.get(bot)!.turns?.map((turn) => turn.prompt),
      ['Synthetic original request.', kept.text],
    );
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
    assert.deepEqual(await before.insert(bot, { ...pending, runId, chatRevision: 0 }), {
      ok: true,
      id: pending.id,
    });
  } finally {
    // Abort before the held turn returns, so the accepted insert is never processed.
    const stopping = before.stop(bot);
    gates.release();
    await stopping;
  }
  assert.deepEqual((await before.journal.read(bot, runId))?.inserts, [{ ...pending, done: false }]);
  await before.close();
  const restarted = await insertFixture(root, { bot, prompts, ...gates });
  try {
    // The saved text is what a requeue can rely on; an unprocessed insert is never an acceptance.
    assert.deepEqual((await restarted.journal.read(bot, runId))?.inserts, [
      { ...pending, done: false },
    ]);
    await assert.rejects(restarted.insert(bot, { ...pending, runId, chatRevision: 0 }), {
      code: 'MODEL_NOT_RUNNING',
    });
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
    assert.deepEqual(await before.insert(bot, { ...message, runId, chatRevision: 0 }), {
      ok: true,
      id: message.id,
    });
    gates.release();
    await gates.gateReached;
    await before.jobs.get(bot)!.done;
    assert.equal(before.jobs.get(bot)!.phase, 'failed');
    // The start marker is durable: a reconnect may have produced files or tool effects already.
    assert.deepEqual((await before.journal.read(bot, runId))?.inserts, [
      { ...message, done: false, started: true },
    ]);
    await assert.rejects(before.insert(bot, { ...message, runId, chatRevision: 0 }), {
      code: 'MODEL_INSERT_UNCERTAIN',
    });
  } finally {
    await before.close();
  }
  const restarted = await insertFixture(root, { bot, prompts: [], ...insertGates() });
  try {
    await assert.rejects(restarted.insert(bot, { ...message, runId, chatRevision: 0 }), {
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
      assert.deepEqual(await send(index), { ok: true, id: id(index) });
    await assert.rejects(send(turnLimit), { code: 'MODEL_INSERT_FULL' });
    gates.release();
    await gates.gateReached;
    // Two turns are already stored while the second insert runs, so the bound still counts them.
    assert.equal(models.jobs.get(bot)!.turns?.length, 3);
    await assert.rejects(send(turnLimit), { code: 'MODEL_INSERT_FULL' });
    gates.gate();
    await models.jobs.get(bot)!.done;
    assert.equal(models.jobs.get(bot)!.turns?.length, turnLimit);
    const page = await models.chatHistory(bot, 0);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].turns?.length, turnLimit);
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
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Synthetic inserted requirement\./);
    assert.match(prompts[0], /Synthetic inserted reply\./);
    assert.match(prompts[0], /Synthetic first reply\./);
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
      assert.equal(models.jobs.get(bot)!.phase, 'completed');
    };
    await run('mock-a', 'mock-one-first');
    await run('mock-b', 'mock-two-first');
    assert.deepEqual(
      captured.map(({ provider, model }) => [provider, model]),
      [
        ['mock-one', 'mock-chat'],
        ['mock-two', 'mock-chat'],
      ],
    );
    assert.equal(captured[0].env.DABAN_MODEL_KEY, 'synthetic-key-mock-one');
    assert.equal(captured[1].env.DABAN_MODEL_KEY, 'synthetic-key-mock-two');
    assert.equal(captured[0].env.DEEPSEEK_API_KEY, undefined);
    assert.equal(models.jobs.get('mock-a')!.vision, false);
    assert.equal(models.jobs.get('mock-b')!.vision, true);
    await run('mock-a', 'mock-one-same-route');
    assert.equal(resumed.length, 1);
    await settings.configure({
      revision: 2,
      requestId: 'mock-one-edit',
      model: 'provider:mock-one:mock-chat',
      apiKey: 'synthetic-rotated-key',
      connection: { ...connection('mock-one', true), baseURL: 'https://new-route.example.test/v1' },
    });
    await run('mock-a', 'mock-one-changed-route');
    assert.equal(
      resumed.length,
      1,
      'a changed endpoint or credential must retire the native session',
    );
    assert.equal(captured.at(-1)!.env.DABAN_MODEL_KEY, 'synthetic-rotated-key');
    assert.equal(captured[0].env.DABAN_MODEL_KEY, 'synthetic-key-mock-one');
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
    assert.equal(
      (plugin as unknown as { config: { socketPath: string } }).config.socketPath,
      '/mock/private/agent.sock',
    );
  }
  const mcp = (
    plugins.find((entry) => entry.id === 'computer-tools')! as unknown as {
      config: Record<string, unknown>;
    }
  ).config;
  assert.equal(mcp.transport, 'stdio');
  assert.equal(mcp.command, process.execPath);
  assert.deepEqual(mcp.args, ['/mock/owned/mcp-stdio.js']);
  assert.deepEqual(
    Object.keys(mcp.env as object)
      .filter((key) => key !== 'ELECTRON_RUN_AS_NODE')
      .sort(),
    ['DABAN_AGENT_BOT', 'DABAN_AGENT_CAPABILITY', 'DABAN_AGENT_SOCKET'],
  );
  assert.equal('url' in mcp, false);
  assert.equal('headers' in mcp, false);
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
    await assert.rejects(models.start('mock-bot', task), { code: 'COMPUTER_CHANGING' });
    assert.equal(models.jobs.size, 0);
    admitted = true;
    await models.start('mock-bot', task);
    await entered;
    const job = models.jobs.get('mock-bot')!;
    await assert.rejects(
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
      { code: 'INVALID_INTERACTION' },
    );
    assert.deepEqual(await models.interactions.list(), []);
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model preparation and output collection use guest workspace references while DSH evidence stays local', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-remote-model-'));
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
    assert.equal(job.phase, 'completed');
    assert.ok(job.workdir.startsWith('/mock-guest/shared/'));
    assert.ok(configuredCwd.startsWith(path.join(root, 'model', 'runs')));
    assert.match(
      await readFile(path.join(configuredCwd, 'result.json'), 'utf8'),
      /mock-remote-session/,
    );
    assert.equal(job.files[0].name, 'mock-output.txt');
    assert.equal(calls.filter((call) => call.method === 'workspace.write').length, 1);
    assert.ok(
      calls.some((call) => call.method === 'workspace.list' && call.params.root === job.workdir),
    );
    failDrain = true;
    await models.start('mock-other-bot', {
      requestId: 'mock-drain-failure',
      prompt: 'Mock daemon failure.',
    });
    const failed = models.jobs.get('mock-other-bot')!;
    const outcome = await Promise.allSettled([failed.done]);
    assert.equal(outcome[0].status, 'fulfilled');
    assert.equal(failed.running, false);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.error, 'EXECUTOR_DRAIN_UNAVAILABLE');
    failDrain = false;
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
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
    assert.equal(completed.executedCount, 55, 'the bounded trace is not the total count');
    assert.equal(completed.toolCount, 60);
    assert.deepEqual(
      completed.trace,
      trace.slice(-8).map(({ name, surface, phase, at, code }) => ({
        name,
        surface,
        phase,
        at,
        ...(code ? { code } : {}),
      })),
    );
    assert.ok(!JSON.stringify(completed.trace).includes('MOCK-PRIVATE'));
    const originalTrace = structuredClone(completed.trace);
    models.status().bots[base.bot].trace![0].name = 'MOCK-CALLER-CHANGE';
    assert.deepEqual(models.status().bots[base.bot].trace, originalTrace);
    const interrupted = models.status().bots['mock-interrupted'];
    assert.equal(interrupted.phase, 'interrupted');
    assert.equal(interrupted.running, false);
    assert.equal(interrupted.executedCount, 4);
    assert.equal(interrupted.trace?.at(-1)?.phase, 'running');
    assert.equal(models.status().bots['mock-legacy'].executedCount, 1);
    assert.equal(models.status().bots['mock-legacy'].trace?.length, 2);
    assert.equal(models.status().bots['mock-group-bot'].executedCount, 14);
    assert.equal(models.status().bots['mock-group-bot'].conversationId, 'mock-group');
    assert.equal(models.status().bots['mock-corrupt'].executedCount, 0);
    assert.deepEqual(models.status().bots['mock-corrupt'].trace, []);
    assert.equal(starts, 0, 'reading restored summaries must not start the harness');
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    assert.deepEqual(models.status().bots[base.bot], completed);
    assert.deepEqual(await readFile(file), original, 'restoration must not rewrite the receipt');
    await models.chats.renew({ bot: base.bot, id: 'mock-fresh-context', revision: 0 });
    assert.equal(models.status().bots[base.bot].executedCount, 0);
    assert.equal(models.status().bots[base.bot].trace, undefined);
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
    assert.equal(models.status().bots[base.bot].executedCount, 0);
    assert.deepEqual(models.status().bots[base.bot].trace, []);
    assert.equal(starts, 1);
  } finally {
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH profile disables unscoped native tools and registers a scoped tool server', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'a', 'synthetic-capability');
  const compaction = patch.find((row) => 'id' in row && row.id === 'compaction-basic');
  assert.ok(compaction && 'config' in compaction);
  assert.equal((compaction.config as { thresholdRatio: number }).thresholdRatio, 0.8);
  const disabled = patch.filter((row) => 'disabled' in row);
  for (const id of ['persistent-bash', 'persistent-pwsh', 'tool-fs', 'tool-working-directory'])
    assert.equal(disabled.find((row) => row.id === id)!.disabled, true);
  assert.equal(disabled.find((row) => row.id === 'llm-deepseek')!.disabled, true);
  const provider = patch
    .find((row) => 'insert' in row)!
    .insert.find((row) => row.id === 'desktop-model-provider')!;
  assert.ok('config' in provider && 'providers' in provider.config);
  assert.equal(provider.config.providers['deepseek-official'].api, 'openai-completions');
  assert.equal(
    provider.config.providers['deepseek-official'].baseURL,
    'https://api.deepseek.com/v1',
  );
  const entry = patch
    .find((row) => 'insert' in row)!
    .insert.find((row) => row.id === 'computer-tools')!;
  assert.ok('config' in entry && 'toolCallTimeoutMs' in entry.config && 'url' in entry.config);
  assert.ok(
    entry.config.toolCallTimeoutMs >= 60 * 60 * 1000,
    'human takeover must not inherit a short tool timeout',
  );
  assert.equal(entry.config.url, 'http://127.0.0.1:12345/mcp/a');
  assert.equal(provider.config.providers['deepseek-official'].apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(Object.hasOwn(provider.config.providers['deepseek-official'], 'apiKey'), false);
});

test('general DSH tasks enable the stock anonymous fetch provider and a shared tool budget', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'chief', 'synthetic-capability', {
    requestId: 'mock-web',
    prompt: '读取 https://example.test/',
  });
  const plugins = patch.find((row) => 'insert' in row)!.insert;
  assert.ok(plugins.some((row) => row.name === '@deepseek-ai/dsh-web'));
  assert.ok(plugins.some((row) => row.id === 'web-fetch-http' && row.name.endsWith('/web.js')));
  const web = plugins.find((row) => row.id === 'tool-web');
  assert.ok(web && 'config' in web);
  assert.deepEqual(web.config, {
    search: true,
    fetch: false,
    searchMaxResults: 5,
    searchMaxQueries: 4,
    searchTimeoutMs: 30000,
  });
  assert.ok(plugins.some((row) => row.id === 'web-read' && row.name.endsWith('/web-read.js')));
  const search = plugins.find((row) => row.id === 'web-deepseek-api');
  assert.ok(search && 'config' in search);
  assert.deepEqual(search.config, {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1/tools',
    count: 5,
    sendOriginalQuestion: false,
  });
  assert.ok(plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-call-timeout-policy'));
  const budget = plugins.find((row) => row.id === 'daban-budget');
  assert.ok(budget && 'config' in budget);
  assert.deepEqual(budget.config, {
    limit: 60,
    urls: ['https://example.test/'],
  });
  const diagnostic = sdkPatch('http://127.0.0.1:12345', 'a', 'synthetic-capability');
  assert.ok(diagnostic.find((row) => 'insert' in row)!.insert.some((row) => row.id === 'approval'));
  assert.equal(
    diagnostic.find((row) => 'insert' in row)!.insert.some((row) => row.id === 'tool-web'),
    false,
  );
});

test('task verification requires actual correct files and rejects symlink escapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-model-result-'));
  try {
    const file = path.join(dir, 'report-a.txt');
    await assert.rejects(verifyOutput('a', dir));
    await writeFile(file, 'paid_count=4\npaid_total=999\nshared_login=true\n');
    assert.equal((await verifyOutput('a', dir)).passed, false);
    await writeFile(file, 'paid_count=4\npaid_total=550\nshared_login=true\n');
    assert.equal((await verifyOutput('a', dir)).passed, true);
    const runtime = {
      screens: { windows: async (): Promise<{ class: string; title: string }[]> => [] },
    };
    assert.equal(
      (await verifyTask('a', dir, runtime)).passed,
      false,
      'a file alone does not prove the GUI task finished',
    );
    runtime.screens.windows = async () => [
      { class: 'mousepad.Mousepad', title: `${file} - Mousepad` },
    ];
    assert.equal((await verifyTask('a', dir, runtime)).passed, true);
    await rm(file);
    await symlink('/etc/hosts', file);
    await assert.rejects(verifyOutput('a', dir), { code: 'FILE_NOT_READABLE' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native editor title verification accepts home abbreviation for the same exact file', () => {
  const file = '/home/synthetic-user/tasks/run-123/report-a.txt';
  assert.equal(
    editorShowsFile(
      [{ class: 'mousepad.Mousepad', title: '~/tasks/run-123/report-a.txt - Mousepad' }],
      file,
      '/home/synthetic-user',
    ),
    true,
  );
  assert.equal(
    editorShowsFile(
      [{ class: 'mousepad.Mousepad', title: '~/tasks/other-run/report-a.txt - Mousepad' }],
      file,
      '/home/synthetic-user',
    ),
    false,
  );
});

test('report verification cannot return private bytes when a checked public file is replaced by a link', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = await mkdtemp(path.join(tmpdir(), 'mock-report-link-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report-a.txt'),
    secret = path.join(tmpdir(), `mock-private-report-${path.basename(root)}.txt`);
  t.after(() => rm(secret, { force: true }));
  await writeFile(report, 'paid_count=4\npaid_total=550\nshared_login=true');
  await writeFile(secret, 'SYNTHETIC-PRIVATE-47');
  const canonicalReport = await fs.realpath(report);
  const original = fs.realpath;
  let replaced = false;
  t.mock.method(fs, 'realpath', async (file: Parameters<typeof original>[0]) => {
    const result = await original(file);
    if ((file === report || result === canonicalReport) && !replaced) {
      replaced = true;
      await fs.rm(report);
      await fs.symlink(secret, report);
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(verifyOutput('a', root));
  assert.equal(replaced, true);
});
