import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { editorShowsFile, ModelRuns, sdkPatch, verifyOutput, verifyTask } from './model.js';
import { RemoteWorkspace } from './remote-workspace.js';
import { ModelSettings } from './settings.js';
import { TaskJournal, type TaskRecord } from './tasks.js';

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
  assert.equal((compaction.config as { retainTokens: number }).retainTokens, 4096);
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
    fetch: true,
    searchMaxResults: 5,
    searchMaxQueries: 4,
    searchTimeoutMs: 30000,
    fetchTimeoutMs: 30000,
    fetchMaxOutputChars: 50000,
  });
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
