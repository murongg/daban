import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { documentLimit } from '@daban/protocol';
import type { Download } from 'playwright';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Control } from './control.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

const observation = {
  id: 'mock-observation',
  tab: 'mock-tab',
  url: 'https://example.test/mock',
  title: 'Synthetic page',
  text: '- button "Synthetic button" [ref=f1e2]',
  offset: 0,
  total: 54,
  truncated: false,
};
function mockRuntime() {
  const calls: unknown[] = [];
  const forbidden = async (): Promise<never> => {
    assert.fail('DOM tools must not take a screenshot or send native input');
  };
  let bytes: Buffer = Buffer.from('SYNTHETIC-DOWNLOAD-71');
  let cancelled = 0;
  const download = {
    suggestedFilename: () => 'download.txt',
    createReadStream: async () => Readable.from([bytes]),
    failure: async () => null,
    cancel: async () => {
      cancelled++;
    },
  } as unknown as Download;
  const tabs = {
    upload: async (...args: unknown[]) => {
      calls.push(['upload', ...args]);
      return { completed: 1, observation };
    },
    download: async (...args: unknown[]) => {
      calls.push(['download', ...args]);
      const consume = args[7] as (
        download: Download,
        signal: AbortSignal,
      ) => Promise<{ path: string; bytes: number }>;
      return { completed: 1, observation, file: await consume(download, args[5] as AbortSignal) };
    },
    navigate: async (...args: unknown[]) => {
      calls.push(['navigate', ...args]);
      return observation;
    },
    snapshot: async (...args: unknown[]) => {
      calls.push(['snapshot', ...args]);
      return observation;
    },
    act: async (...args: unknown[]) => {
      calls.push(['act', ...args]);
      return { completed: 1, observation };
    },
    command: async (...args: unknown[]) => {
      calls.push(['command', ...args]);
      return {
        state: {
          bot: 'a',
          available: true,
          instance: 'mock-browser-instance',
          revision: 1,
          active: 'mock-tab',
          tabs: [{ id: 'mock-tab', url: observation.url, title: observation.title, generation: 0 }],
        },
      };
    },
  };
  return {
    calls,
    setDownload: (value: Buffer) => {
      bytes = value;
    },
    cancelled: () => cancelled,
    value: {
      control: new Control(['a', 'b']),
      frame: forbidden,
      screens: { input: forbidden, openApp: forbidden },
      browser: { frame: forbidden, input: forbidden, tabs },
    },
  };
}
function data(result: Awaited<ReturnType<AgentTools['invoke']>>) {
  assert.ok(!result.isError, JSON.stringify(result));
  const part = result.content[0];
  assert.equal(part.type, 'text');
  return JSON.parse(part.type === 'text' ? part.text : '') as Record<string, unknown>;
}
test('text models receive live DOM tools with exact Bot/run/lease routing through the shared budget and no images', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-tools-'));
  const fake = mockRuntime();
  const tools = new AgentTools(fake.value, new WorkspaceFiles(root));
  const run: AgentToolRun = {
    id: 'mock-run-a',
    bot: 'a',
    model: 'deepseek-v4-pro',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: await realpath(root),
    task: { requestId: 'mock-human-a', prompt: '在合成网站核对表单。' },
  };
  try {
    const names = tools.list('a', 'deepseek-v4-pro').map((tool) => tool.name);
    for (const name of [
      'browser_navigate',
      'browser_snapshot',
      'browser_act',
      'browser_tabs',
      'browser_upload',
      'browser_download',
    ])
      assert.ok(names.includes(name), `Missing ${name}`);
    assert.ok(!names.includes('screenshot'));
    assert.equal(
      data(await tools.invoke(run, 'browser_navigate', { url: observation.url })).id,
      observation.id,
    );
    data(await tools.invoke(run, 'browser_snapshot', {}));
    data(
      await tools.invoke(run, 'browser_act', {
        observation: observation.id,
        actions: [{ kind: 'click', ref: 'f1e2' }],
      }),
    );
    data(await tools.invoke(run, 'browser_tabs', { action: 'list' }));
    assert.equal(run.toolCount, 4);
    assert.ok(
      run.trace.every(
        (trace) => trace.surface === 'browser' && trace.phase === 'settled' && !trace.args,
      ),
    );
    assert.deepEqual((fake.calls[0] as unknown[]).slice(0, 5), [
      'navigate',
      'a',
      'agent',
      0,
      observation.url,
    ]);
    assert.equal((fake.calls[0] as unknown[]).at(-1), 'mock-run-a');
    const count = fake.calls.length;
    assert.equal(
      (await tools.invoke(run, 'browser_navigate', { url: observation.url, bot: 'b' })).isError,
      true,
    );
    assert.equal(fake.calls.length, count);
    run.limit = run.toolCount;
    assert.equal((await tools.invoke(run, 'browser_snapshot', {})).isError, true);
    assert.equal(fake.calls.length, count);
    assert.ok(
      !tools
        .list('mock-unbound', 'deepseek-flash')
        .some((tool) => tool.name.startsWith('browser_')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DOM calls wait only for their Bot, can cancel a human wait and reject anonymous legacy runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-wait-'));
  await mkdir(path.join(root, 'work'));
  const fake = mockRuntime();
  const tools = new AgentTools(fake.value, new WorkspaceFiles(root));
  const run: AgentToolRun = {
    id: 'mock-run',
    bot: 'a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: await realpath(root),
    task: { requestId: 'mock-human', prompt: '读取合成页面。' },
  };
  try {
    await fake.value.control.transfer('a', 0, 'human');
    const pending = tools.invoke(run, 'browser_snapshot', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.calls.length, 0);
    assert.equal(run.waitingForComputer, true);
    const other: AgentToolRun = {
      ...run,
      bot: 'b',
      id: 'mock-run-b',
      trace: [],
      abort: new AbortController(),
    };
    data(await tools.invoke(other, 'browser_snapshot', {}));
    run.abort.abort();
    assert.equal((await pending).isError, true);
    assert.equal(run.waitingForComputer, false);
    const anonymous = {
      ...run,
      bot: 'b',
      abort: new AbortController(),
      task: undefined,
      trace: [],
    };
    assert.equal((await tools.invoke(anonymous, 'browser_snapshot', {})).isError, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser transfers reuse owned workspace bytes, preserve inputs and never overwrite an existing output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-files-'));
  const shared = path.join(root, 'shared'),
    workdir = path.join(shared, 'current');
  await mkdir(workdir, { recursive: true });
  const fake = mockRuntime();
  const tools = new AgentTools(fake.value, new WorkspaceFiles(shared));
  const run: AgentToolRun = {
    id: 'mock-file-run',
    bot: 'a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 30,
    seen: {},
    trace: [],
    workdir,
    canonicalRoot: await realpath(workdir),
    task: { requestId: 'mock-file-task', prompt: '上传合成文件并下载合成结果。' },
  };
  try {
    await writeFile(path.join(workdir, 'source.csv'), 'item,count\nmock,47');
    data(
      await tools.invoke(run, 'browser_upload', {
        observation: observation.id,
        ref: 'f1e2',
        path: 'source.csv',
      }),
    );
    const uploaded = fake.calls.find((call) => (call as unknown[])[0] === 'upload') as unknown[];
    const file = uploaded[6] as { name: string; buffer: Buffer };
    assert.equal(file.name, 'source.csv');
    assert.equal(file.buffer.toString(), 'item,count\nmock,47');
    await writeFile(path.join(root, 'private.txt'), 'SYNTHETIC-PRIVATE-NOT-FOR-UPLOAD');
    await symlink(path.join(root, 'private.txt'), path.join(workdir, 'link.txt'));
    await link(path.join(root, 'private.txt'), path.join(workdir, 'hardlink.txt'));
    const before = fake.calls.length;
    for (const sourcePath of [
      '../../private.txt',
      path.join(root, 'private.txt'),
      'link.txt',
      'hardlink.txt',
    ])
      assert.equal(
        (
          await tools.invoke(run, 'browser_upload', {
            observation: observation.id,
            ref: 'f1e2',
            sourcePath,
          })
        ).isError,
        true,
        sourcePath,
      );
    assert.equal(fake.calls.length, before);
    const saved = data(
      await tools.invoke(run, 'browser_download', {
        observation: observation.id,
        ref: 'f1e2',
        name: 'result.txt',
      }),
    );
    assert.ok(saved.file);
    assert.equal(await readFile(path.join(workdir, 'result.txt'), 'utf8'), 'SYNTHETIC-DOWNLOAD-71');
    const collision = await tools.invoke(run, 'browser_download', {
      observation: observation.id,
      ref: 'f1e2',
      name: 'source.csv',
    });
    assert.equal(collision.isError, true);
    assert.equal(await readFile(path.join(workdir, 'source.csv'), 'utf8'), 'item,count\nmock,47');
    fake.setDownload(Buffer.alloc(documentLimit + 1, 65));
    assert.equal(
      (
        await tools.invoke(run, 'browser_download', {
          observation: observation.id,
          ref: 'f1e2',
          name: 'oversized.txt',
        })
      ).isError,
      true,
    );
    assert.ok(fake.cancelled() > 0);
    await assert.rejects(readFile(path.join(workdir, 'oversized.txt')));
    assert.equal(
      (
        await tools.invoke(run, 'browser_download', {
          observation: observation.id,
          ref: 'f1e2',
          name: '../escape.txt',
        })
      ).isError,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the normal DSH model core accepts browser computer capability without requiring a full Linux desktop object', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-model-core-'));
  const fake = mockRuntime();
  const options = {
    computer: fake.value,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    settings: new ModelSettings(path.join(root, 'settings.json')),
    origin: 'http://127.0.0.1:18766',
  };
  const models = new ModelRuns(options);
  try {
    await models.ready;
    assert.ok(
      models.tools.list('a', 'deepseek-v4-pro').some((tool) => tool.name === 'browser_navigate'),
    );
    assert.equal(models.runtime, undefined);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelling while download output is being created never leaves a partial visible artifact', {
  skip: process.platform !== 'linux',
  timeout: 5000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-atomic-browser-output-'));
  const fake = mockRuntime();
  fake.setDownload(Buffer.alloc(4 * 1024 * 1024, 71));
  const tools = new AgentTools(fake.value, new WorkspaceFiles(root));
  const run: AgentToolRun = {
    id: 'mock-atomic-run',
    bot: 'a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: await realpath(root),
    task: { requestId: 'mock-atomic-request', prompt: '下载合成文件。' },
  };
  let observed = false;
  const watcher = watch(root, (_event, name) => {
    if (name === 'atomic-result.bin' || String(name).startsWith('.browser-download-')) {
      observed = true;
      run.abort.abort();
    }
  });
  try {
    const result = await tools.invoke(run, 'browser_download', {
      observation: observation.id,
      ref: 'f1e2',
      name: 'atomic-result.bin',
    });
    assert.equal(observed, true);
    assert.equal(result.isError, true);
    await assert.rejects(readFile(path.join(root, 'atomic-result.bin')));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('human computer ownership does not suspend the budget of an ordinary DSH response that is not waiting for the computer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-ordinary-budget-'));
  const fake = mockRuntime();
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'synthetic-budget-key' });
  let entered!: () => unknown, release!: () => unknown;
  const ready = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session(id = 'mock-budget-session') {
      return {
        id,
        run: async () => {
          entered();
          await gate;
          return { sessionId: id, finalResponse: '合成完成' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:18766',
    computer: fake.value,
    Harness,
  });
  try {
    await models.ready;
    await fake.value.control.transfer('a', 0, 'human');
    await models.start('a', {
      requestId: 'mock-ordinary-budget',
      prompt: '合成普通对话，不使用电脑或工具。',
    });
    await ready;
    assert.equal(models.jobs.get('a')!.waitingForComputer, undefined);
    now = 300001;
    t.mock.timers.tick(1000);
    assert.equal(
      models.jobs.get('a')!.abort.signal.aborted,
      true,
      'only an actual computer wait can pause the execution budget',
    );
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a text-model browser wait excludes human time from the DSH budget and completes after the exact lease is returned', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-budget-'));
  const fake = mockRuntime();
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'synthetic-browser-budget-key' });
  let models: ModelRuns;
  let entered!: () => unknown;
  const ready = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-browser-budget-session') {
      return {
        id,
        run: async () => {
          const job = models.jobs.get('a')!;
          entered();
          await models.rpc('a', `Bearer ${job.token}`, {
            id: 'mock-browser-read',
            method: 'tools/call',
            params: { name: 'browser_snapshot', arguments: {} },
          });
          return { sessionId: id, finalResponse: 'BROWSER-BUDGET-OK' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  models = new ModelRuns({
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:18766',
    computer: fake.value,
    Harness,
  });
  try {
    await models.ready;
    await models.profiles.register({
      id: 'a',
      name: '合成文本模型',
      instructions: '合成验收',
      memory: '',
      color: 'mint',
      model: 'deepseek-v4-pro',
    });
    const held = await fake.value.control.transfer('a', 0, 'human');
    await models.start('a', { requestId: 'mock-browser-budget', prompt: '读取当前合成网页。' });
    await ready;
    for (let i = 0; i < 10 && !models.jobs.get('a')!.waitingForComputer; i++)
      await new Promise(setImmediate);
    assert.equal(models.status().bots.a.phase, 'paused');
    now = 600000;
    t.mock.timers.tick(1000);
    assert.equal(models.jobs.get('a')!.abort.signal.aborted, false);
    await fake.value.control.transfer('a', held.epoch, 'agent');
    t.mock.timers.tick(80);
    await models.jobs.get('a')!.done;
    assert.equal(models.status().bots.a.phase, 'completed');
  } finally {
    models.jobs.get('a')?.abort.abort();
    t.mock.timers.tick(80);
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('pending or rejected web permission cannot be bypassed with DOM or computer tools and remains scoped to the accepted run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-approval-'));
  const fake = mockRuntime();
  let nativeCalls = 0;
  Object.assign(fake.value, {
    frame: async () => {
      nativeCalls++;
      return Buffer.from('synthetic-frame');
    },
  });
  Object.assign(fake.value.screens, {
    openApp: async () => {
      nativeCalls++;
    },
    input: async () => {
      nativeCalls++;
    },
  });
  const workspace = path.join(root, 'workspace');
  const models = new ModelRuns({
    computer: fake.value,
    workspace,
    dir: path.join(root, 'model'),
    settings: new ModelSettings(path.join(root, 'credentials.json')),
    origin: 'http://127.0.0.1:18766',
  });
  try {
    await models.ready;
    const run: AgentToolRun = {
      id: 'mock-guard-run',
      bot: 'a',
      abort: new AbortController(),
      toolCount: 0,
      limit: 30,
      seen: { desktop: 0 },
      trace: [],
      workdir: workspace,
      canonicalRoot: await realpath(workspace),
      task: { requestId: 'mock-guard-request', prompt: '核对合成网页；需要许可时等待确认。' },
    };
    const request = await models.interactions.open('a', run.id!, {
      id: 'mock-web-permission',
      sessionId: 'mock-guard-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/mock',
    });
    for (const [name, args] of [
      ['browser_navigate', { url: 'https://example.test/mock' }],
      ['screenshot', { surface: 'desktop' }],
    ] as const) {
      const result = await models.tools.invoke(run, name, args);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /WEB_APPROVAL_PENDING/);
    }
    assert.equal(nativeCalls, 0);
    assert.equal(fake.calls.length, 0);
    await models.interactions.reply('a', run.id!, request.id, { kind: 'decision', allow: false });
    for (const [name, args] of [
      ['browser_snapshot', {}],
      ['open_app', { app: 'browser' }],
    ] as const) {
      const result = await models.tools.invoke(run, name, args);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /WEB_APPROVAL_REJECTED/);
    }
    assert.equal(nativeCalls, 0);
    assert.equal(fake.calls.length, 0);
    for (const other of [
      { ...run, id: 'mock-next-run' },
      { ...run, bot: 'b' },
      { ...run, conversationId: 'mock-other-group' },
    ])
      data(await models.tools.invoke(other, 'browser_snapshot', {}));
    assert.equal(fake.calls.length, 3);
    const held = await fake.value.control.transfer('a', 0, 'human');
    const late: AgentToolRun = { ...run, id: 'mock-late-permission', abort: new AbortController() };
    const waiting = models.tools.invoke(late, 'browser_snapshot', {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const requestLate = await models.interactions.open('a', late.id!, {
      id: 'mock-late-web-permission',
      sessionId: 'mock-late-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/late',
    });
    await models.interactions.reply('a', late.id!, requestLate.id, {
      kind: 'decision',
      allow: false,
    });
    await fake.value.control.transfer('a', held.epoch, 'agent');
    assert.match(JSON.stringify(await waiting), /WEB_APPROVAL_REJECTED/);
    assert.equal(
      fake.calls.length,
      3,
      'returning the lease must not reuse an earlier permission check',
    );
    let entered!: () => unknown, release!: () => unknown;
    const started = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    Object.assign(fake.value.browser.tabs, {
      snapshot: async () => {
        entered();
        await gate;
        return { ...observation, text: 'SYNTHETIC-WITHHELD-PAGE' };
      },
    });
    const inflight: AgentToolRun = {
      ...run,
      id: 'mock-inflight-permission',
      abort: new AbortController(),
    };
    const reading = models.tools.invoke(inflight, 'browser_snapshot', {});
    await started;
    const requestDuring = await models.interactions.open('a', inflight.id!, {
      id: 'mock-inflight-web-permission',
      sessionId: 'mock-inflight-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/inflight',
    });
    await models.interactions.reply('a', inflight.id!, requestDuring.id, {
      kind: 'decision',
      allow: false,
    });
    release();
    const withheld = await reading;
    assert.equal(withheld.isError, true);
    assert.match(JSON.stringify(withheld), /WEB_APPROVAL_REJECTED/);
    assert.equal(JSON.stringify(withheld).includes('SYNTHETIC-WITHHELD-PAGE'), false);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH receives truthful DOM browser capabilities for both text and vision routes without calling the browser for a greeting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-capability-prompt-'));
  const fake = mockRuntime();
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'synthetic-capability-key' });
  const prompts: string[] = [];
  class Harness {
    async start() {}
    async close() {}
    session(id = 'mock-capability-session') {
      return {
        id,
        run: async (prompt: unknown) => {
          assert.ok(typeof prompt === 'string');
          prompts.push(prompt);
          return { sessionId: id, finalResponse: 'SYNTHETIC-CAPABILITY' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    computer: fake.value,
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:18766',
    Harness,
  });
  try {
    await models.ready;
    await models.profiles.register({
      id: 'a',
      name: '合成文本路线',
      instructions: '合成职责',
      memory: '',
      color: 'mint',
      model: 'deepseek-v4-pro',
    });
    for (const bot of ['a', 'b']) {
      await models.start(bot, {
        requestId: `mock-capability-${bot}`,
        prompt: '普通合成问候，不使用工具。',
      });
      await models.jobs.get(bot)!.done;
      const prompt = prompts.at(-1)!;
      assert.match(prompt, /browser_navigate/);
      assert.doesNotMatch(prompt, /仅支持本地演示站|没有桌面或浏览器工具/);
      assert.equal(models.jobs.get(bot)!.toolCount, 0);
    }
    assert.equal(fake.calls.length, 0);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
