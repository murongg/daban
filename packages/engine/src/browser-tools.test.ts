import { watch } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { documentLimit } from '@daban/protocol';
import type { Download } from 'playwright';
import { expect, test, vi } from 'vitest';
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
    expect.unreachable('DOM tools must not take a screenshot or send native input');
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
  expect.assert(!result.isError, JSON.stringify(result));
  const part = result.content[0];
  expect(part.type).toBe('text');
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
      expect.assert(names.includes(name), `Missing ${name}`);
    expect.assert(!names.includes('screenshot'));
    expect(data(await tools.invoke(run, 'browser_navigate', { url: observation.url })).id).toBe(
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
    expect(run.toolCount).toBe(4);
    expect.assert(
      run.trace.every(
        (trace) => trace.surface === 'browser' && trace.phase === 'settled' && !trace.args,
      ),
    );
    expect((fake.calls[0] as unknown[]).slice(0, 5)).toStrictEqual([
      'navigate',
      'a',
      'agent',
      0,
      observation.url,
    ]);
    expect((fake.calls[0] as unknown[]).at(-1)).toBe('mock-run-a');
    const count = fake.calls.length;
    expect(
      (await tools.invoke(run, 'browser_navigate', { url: observation.url, bot: 'b' })).isError,
    ).toBe(true);
    expect(fake.calls.length).toBe(count);
    run.limit = run.toolCount;
    expect((await tools.invoke(run, 'browser_snapshot', {})).isError).toBe(true);
    expect(fake.calls.length).toBe(count);
    expect.assert(
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
    expect(fake.calls.length).toBe(0);
    expect(run.waitingForComputer).toBe(true);
    const other: AgentToolRun = {
      ...run,
      bot: 'b',
      id: 'mock-run-b',
      trace: [],
      abort: new AbortController(),
    };
    data(await tools.invoke(other, 'browser_snapshot', {}));
    run.abort.abort();
    expect((await pending).isError).toBe(true);
    expect(run.waitingForComputer).toBe(false);
    const anonymous = {
      ...run,
      bot: 'b',
      abort: new AbortController(),
      task: undefined,
      trace: [],
    };
    expect((await tools.invoke(anonymous, 'browser_snapshot', {})).isError).toBe(true);
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
    expect(file.name).toBe('source.csv');
    expect(file.buffer.toString()).toBe('item,count\nmock,47');
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
      expect(
        (
          await tools.invoke(run, 'browser_upload', {
            observation: observation.id,
            ref: 'f1e2',
            sourcePath,
          })
        ).isError,
        sourcePath,
      ).toBe(true);
    expect(fake.calls.length).toBe(before);
    const saved = data(
      await tools.invoke(run, 'browser_download', {
        observation: observation.id,
        ref: 'f1e2',
        name: 'result.txt',
      }),
    );
    expect.assert(saved.file);
    expect(await readFile(path.join(workdir, 'result.txt'), 'utf8')).toBe('SYNTHETIC-DOWNLOAD-71');
    const collision = await tools.invoke(run, 'browser_download', {
      observation: observation.id,
      ref: 'f1e2',
      name: 'source.csv',
    });
    expect(collision.isError).toBe(true);
    expect(await readFile(path.join(workdir, 'source.csv'), 'utf8')).toBe('item,count\nmock,47');
    fake.setDownload(Buffer.alloc(documentLimit + 1, 65));
    expect(
      (
        await tools.invoke(run, 'browser_download', {
          observation: observation.id,
          ref: 'f1e2',
          name: 'oversized.txt',
        })
      ).isError,
    ).toBe(true);
    expect.assert(fake.cancelled() > 0);
    await expect(readFile(path.join(workdir, 'oversized.txt'))).rejects.toThrowError();
    expect(
      (
        await tools.invoke(run, 'browser_download', {
          observation: observation.id,
          ref: 'f1e2',
          name: '../escape.txt',
        })
      ).isError,
    ).toBe(true);
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
    expect.assert(
      models.tools.list('a', 'deepseek-v4-pro').some((tool) => tool.name === 'browser_navigate'),
    );
    expect(models.runtime).toBe(undefined);
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
    expect(observed).toBe(true);
    expect(result.isError).toBe(true);
    await expect(readFile(path.join(root, 'atomic-result.bin'))).rejects.toThrowError();
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('human computer ownership does not suspend the budget of an ordinary DSH response that is not waiting for the computer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
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
    expect(models.jobs.get('a')!.waitingForComputer).toBe(undefined);
    now = 300001;
    vi.advanceTimersByTime(1000);
    expect(
      models.jobs.get('a')!.abort.signal.aborted,
      'only an actual computer wait can pause the execution budget',
    ).toBe(true);
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a text-model browser wait excludes human time from the DSH budget and completes after the exact lease is returned', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
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
    expect(models.status().bots.a.phase).toBe('paused');
    now = 600000;
    vi.advanceTimersByTime(1000);
    expect(models.jobs.get('a')!.abort.signal.aborted).toBe(false);
    await fake.value.control.transfer('a', held.epoch, 'agent');
    vi.advanceTimersByTime(80);
    await models.jobs.get('a')!.done;
    expect(models.status().bots.a.phase).toBe('completed');
  } finally {
    models.jobs.get('a')?.abort.abort();
    vi.advanceTimersByTime(80);
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
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/WEB_APPROVAL_PENDING/);
    }
    expect(nativeCalls).toBe(0);
    expect(fake.calls.length).toBe(0);
    await models.interactions.reply('a', run.id!, request.id, { kind: 'decision', allow: false });
    for (const [name, args] of [
      ['browser_snapshot', {}],
      ['open_app', { app: 'browser' }],
    ] as const) {
      const result = await models.tools.invoke(run, name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/WEB_APPROVAL_REJECTED/);
    }
    expect(nativeCalls).toBe(0);
    expect(fake.calls.length).toBe(0);
    for (const other of [
      { ...run, id: 'mock-next-run' },
      { ...run, bot: 'b' },
      { ...run, conversationId: 'mock-other-group' },
    ])
      data(await models.tools.invoke(other, 'browser_snapshot', {}));
    expect(fake.calls.length).toBe(3);
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
    expect(JSON.stringify(await waiting)).toMatch(/WEB_APPROVAL_REJECTED/);
    expect(
      fake.calls.length,
      'returning the lease must not reuse an earlier permission check',
    ).toBe(3);
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
    expect(withheld.isError).toBe(true);
    expect(JSON.stringify(withheld)).toMatch(/WEB_APPROVAL_REJECTED/);
    expect(JSON.stringify(withheld).includes('SYNTHETIC-WITHHELD-PAGE')).toBe(false);
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
          expect.assert(typeof prompt === 'string');
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
      expect(prompt).toMatch(/browser_navigate/);
      expect(prompt).not.toMatch(
        /browser supports only the local demo site|desktop and browser tools are unavailable/,
      );
      expect(models.jobs.get(bot)!.toolCount).toBe(0);
    }
    expect(fake.calls.length).toBe(0);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
