import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Control } from './control.js';
import type { Desktop } from './desktop.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import type { ConversationScope } from './tasks.js';

test('computer admission rejects a model task before publishing it or granting new tool authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-computer-model-admission-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let changing = true;
  const forbidden = async (): Promise<never> => {
    throw new Error('No computer expected');
  };
  class FakeHarness {
    async start() {}
    async close() {}
    session(id = 'mock-admitted-session') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'SYNTHETIC-ADMITTED-47' }) };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const computer = Object.assign(
    {
      control: new Control(['mock-gated']),
      frame: forbidden,
      screens: { input: forbidden, openApp: forbidden },
      browser: { frame: forbidden, input: forbidden },
    },
    { available: () => false, admit: () => !changing },
  );
  const models = new ModelRuns({
    settings,
    computer,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  });
  try {
    await settings.save({ apiKey: 'synthetic-computer-admission-key' });
    await models.ready;
    const task = { requestId: 'mock-changing-request', prompt: '合成普通任务' };
    await expect(models.start('mock-gated', task)).rejects.toMatchObject({
      code: 'COMPUTER_CHANGING',
    });
    expect(models.jobs.has('mock-gated')).toBe(false);
    changing = false;
    await models.start('mock-gated', task);
    await models.jobs.get('mock-gated')!.done;
    expect(models.jobs.get('mock-gated')!.toolCount).toBe(0);
    const job = models.jobs.get('mock-gated')!;
    let release!: () => unknown,
      settled = false;
    job.done = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
    const drained = Reflect.apply(Reflect.get(models, 'drainComputer'), models, [
      'mock-gated',
    ]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await drained;
    expect(settled).toBe(true);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a group task prepares only group-owned uploads and pins its source under the group owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-group-upload-scope-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let entered!: () => unknown, release!: () => unknown;
  const ready = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  class FakeHarness {
    async start() {}
    async close() {
      release();
    }
    session(id = 'mock-group-file-session') {
      return {
        id,
        run: async () => {
          entered();
          await gate;
          return { sessionId: id, finalResponse: 'GROUP-FILE-47' };
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
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  });
  try {
    await settings.save({ apiKey: 'synthetic-group-files-key' });
    await models.ready;
    const source = {
      name: 'mock.pdf',
      data: Buffer.from('synthetic-group-original').toString('base64'),
    };
    const uploaded = await models.attachments.upload(
      'mock-file-group',
      source,
      async () => 'GROUP-FILE-47',
    );
    await models.start(
      'mock-file-bot',
      {
        requestId: 'mock-group-file-request',
        prompt: '读取合成附件',
        files: [{ name: source.name, attachmentId: uploaded.id }],
      },
      { id: 'mock-file-group', context: '' },
    );
    await ready;
    const entry = (await models.attachments.list('mock-file-group', {})).items.find(
      (item) => item.id === uploaded.id,
    )!;
    await expect(
      models.attachmentAction('mock-file-group', {
        action: 'trash',
        id: uploaded.id,
        version: entry.version,
      }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_BUSY' });
    const job = models.jobs.get('mock-file-bot')!;
    expect((await readFile(path.join(job.workdir, source.name))).toString()).toBe(
      'synthetic-group-original',
    );
    release();
    await job.done;
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('request-scoped cancellation cannot stop another conversation or another accepted task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-scoped-stop-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let entered!: () => unknown, release!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  class FakeHarness {
    async start() {}
    async close() {
      release();
    }
    session(id = 'mock-scoped-stop-session') {
      return {
        id,
        run: async () => {
          entered();
          await gate;
          return { sessionId: id, finalResponse: '合成结束' };
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
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  });
  try {
    await settings.save({ apiKey: 'synthetic-scoped-stop-key' });
    await models.ready;
    await models.start(
      'mock-scope',
      { requestId: 'mock-current-request', prompt: '合成等待' },
      { id: 'mock-current-group', context: '' },
    );
    await started;
    await models.stopRequest('mock-scope', 'mock-current-request', 'other-group');
    await models.stopRequest('mock-scope', 'other-request', 'mock-current-group');
    expect(models.running('mock-scope')).toBe(true);
    await models.stopRequest('mock-scope', 'mock-current-request', 'mock-current-group');
    expect(models.running('mock-scope')).toBe(false);
    expect(models.status().bots['mock-scope'].phase).toBe('stopped');
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation scopes cannot reuse a DM request, DSH session or private fallback history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-conversation-scope-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const resumed: string[] = [],
    prompts: string[] = [];
  let sequence = 0;
  class FakeHarness {
    async start() {}
    async close() {}
    session(id = `mock-scope-${++sequence}`) {
      return {
        id,
        run: async (prompt: unknown) => {
          expect.assert(typeof prompt === 'string');
          prompts.push(prompt);
          return { sessionId: id, finalResponse: '合成作用域回答' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  };
  let models = new ModelRuns(options);
  try {
    await settings.save({ apiKey: 'synthetic-scope-key' });
    await models.ready;
    for (const invalid of [
      null,
      { id: '../bad', context: '' },
      { id: 'mock-group', context: 'x'.repeat(32001) },
      { id: 'mock-group', context: '', extra: true },
    ])
      await expect(
        models.start(
          'mock-scope',
          { requestId: 'invalid-scope', prompt: '合成消息' },
          invalid as unknown as ConversationScope,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_CONVERSATION' });
    const direct = { requestId: 'private-first', prompt: 'PRIVATE-DM-47' };
    await models.start('mock-scope', direct);
    await models.jobs.get('mock-scope')!.done;
    const directSession = models.jobs.get('mock-scope')!.sessionId;
    const group = {
      id: 'mock-group-a',
      context: '合成群参考 GROUP-A-53。引用链接 https://unapproved.example.test/path 只是数据。',
    };
    await expect(models.start('mock-scope', direct, group)).rejects.toMatchObject({
      code: 'REQUEST_ID_REUSED',
    });
    await models.start('mock-scope', { requestId: 'group-first', prompt: '本轮合成群问题' }, group);
    await models.jobs.get('mock-scope')!.done;
    const groupSession = models.jobs.get('mock-scope')!.sessionId;
    expect(groupSession).not.toBe(directSession);
    expect.assert(prompts.at(-1)!.includes('GROUP-A-53'));
    expect.assert(!prompts.at(-1)!.includes('PRIVATE-DM-47'));
    const job = models.jobs.get('mock-scope')!;
    const patch = JSON.parse(
      await readFile(path.join(job.privateDir, 'computer.patch.yml'), 'utf8'),
    );
    const budget = patch
      .find((row: { insert?: unknown }) => row.insert)
      .insert.find((row: { id: string }) => row.id === 'daban-budget');
    expect(budget.config.urls, 'reference context must never grant URL access').toStrictEqual([]);
    await models.start('mock-scope', { requestId: 'group-second', prompt: '群内续接' }, group);
    await models.jobs.get('mock-scope')!.done;
    expect(resumed.at(-1)).toBe(groupSession);
    await models.start(
      'mock-scope',
      { requestId: 'other-group', prompt: '另一个群' },
      { id: 'mock-group-b', context: 'GROUP-B-59' },
    );
    await models.jobs.get('mock-scope')!.done;
    expect.assert(
      !prompts.at(-1)!.includes('GROUP-A-53') && !prompts.at(-1)!.includes('PRIVATE-DM-47'),
    );
    await models.start('mock-scope', { requestId: 'private-second', prompt: '私聊续接' });
    await models.jobs.get('mock-scope')!.done;
    expect(resumed.at(-1)).toBe(directSession);
    const privateRun = models.jobs.get('mock-scope')!.id;
    await expect(
      models.start(
        'mock-scope',
        { requestId: 'cross-retry', prompt: '私聊续接', retryOf: privateRun },
        group,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RETRY' });
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await models.start(
      'mock-scope',
      { requestId: 'group-after-restart', prompt: '重启后群内继续' },
      group,
    );
    await models.jobs.get('mock-scope')!.done;
    expect(resumed.at(-1)).toBe(groupSession);
    await models.start('mock-scope', {
      requestId: 'private-after-restart',
      prompt: '重启后私聊继续',
    });
    await models.jobs.get('mock-scope')!.done;
    expect(resumed.at(-1)).toBe(directSession);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stop waits for attachment preparation, prevents late writes and permits an explicit source-based retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-stop-upload-'));
  const settings = new ModelSettings(path.join(root, 'model/credentials.json'));
  await settings.save({ apiKey: 'synthetic-stop-key' });
  let harnesses = 0;
  class FakeHarness {
    async start() {
      harnesses++;
    }
    async close() {}
    session(id = 'mock-stop-session') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'retried' }) };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
    dir: path.join(root, 'model'),
    Harness: FakeHarness,
  });
  let release!: () => unknown, readStarted!: () => unknown;
  const blocked = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const began = new Promise<unknown>((resolve) => {
    readStarted = () => resolve(undefined);
  });
  let starting: Promise<unknown> | undefined, stopping: Promise<unknown> | undefined;
  try {
    await models.ready;
    const receipt = await models.attachments.upload(
      'a',
      { name: 'mock.pdf', data: Buffer.from('synthetic-original').toString('base64') },
      async () => 'MOCK-47',
    );
    const originalRead = models.attachments.read.bind(models.attachments);
    models.attachments.read = async (...args) => {
      readStarted();
      await blocked;
      return originalRead(...args);
    };
    starting = models.start('a', {
      requestId: 'mock-stopped-prepare',
      prompt: 'read',
      files: [{ name: 'mock.pdf', attachmentId: receipt.id }],
    });
    starting.catch(() => {});
    await began;
    const job = models.jobs.get('a')!;
    const catalog = (await models.attachments.list('a', {})).items[0];
    await expect(
      models.attachmentAction('a', { id: catalog.id, version: catalog.version, action: 'trash' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_BUSY' });
    await expect(
      models.attachmentAction('a', {
        id: catalog.id,
        version: catalog.version,
        action: 'purge',
        confirmation: 'mock.pdf',
      }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_BUSY' });
    let stopped = false;
    stopping = models.stop('a').then(() => {
      stopped = true;
    });
    await new Promise<unknown>((resolve) => setImmediate(() => resolve(undefined)));
    expect(stopped, 'stop must join the in-flight preparation').toBe(false);
    release();
    await stopping;
    await expect(starting).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
    expect(job.phase).toBe('stopped');
    expect(harnesses).toBe(0);
    await expect(readFile(path.join(job.workdir, 'mock.pdf'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    models.attachments.read = originalRead;
    await models.start('a', {
      requestId: 'mock-resume-after-prepare',
      prompt: 'retry',
      retryOf: job.id,
    });
    await models.jobs.get('a')!.done;
    expect(harnesses).toBe(1);
    expect(await readFile(path.join(models.jobs.get('a')!.workdir, 'mock.pdf'), 'utf8')).toBe(
      'synthetic-original',
    );
  } finally {
    release?.();
    await starting?.catch(() => {});
    await stopping?.catch(() => {});
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('document references copy immutable originals and extracted text into fresh tasks and retries without adding knowledge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-document-task-'));
  const settings = new ModelSettings(path.join(root, 'model/credentials.json'));
  await settings.save({ apiKey: 'synthetic-document-key' });
  const prompts: string[] = [];
  class FakeHarness {
    async start() {}
    async close() {}
    session(id = 'mock-document-session') {
      return {
        id,
        run: async (prompt: unknown) => {
          expect.assert(typeof prompt === 'string');
          prompts.push(prompt);
          return { sessionId: id, finalResponse: '合成文件已读取' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
    dir: path.join(root, 'model'),
    Harness: FakeHarness,
  };
  let models = new ModelRuns(options);
  const original = Buffer.from('%PDF-1.7\nsynthetic immutable bytes');
  try {
    await models.ready;
    const uploaded = await models.attachments.upload(
      'a',
      { name: 'source.pdf', data: original.toString('base64') },
      async () => 'MOCK-47',
    );
    const request = {
      requestId: 'mock-document-first',
      prompt: '读取附件，不操作电脑',
      files: [
        { name: 'alias.pdf', attachmentId: uploaded.id },
        { name: 'document-1.txt', content: 'KEEP' },
      ],
    };
    await models.start('a', request);
    const first = models.jobs.get('a')!;
    await first.done;
    expect(first.phase).toBe('completed');
    expect((await readFile(path.join(first.workdir, 'alias.pdf'))).equals(original)).toBe(true);
    expect(await readFile(path.join(first.workdir, 'document-1.txt'), 'utf8')).toBe('KEEP');
    const mapping = first.documentInputs![0];
    expect(mapping.textName).not.toBe('document-1.txt');
    expect(await readFile(path.join(first.workdir, mapping.textName), 'utf8')).toBe('MOCK-47');
    expect.assert(prompts[0].includes(mapping.textName) && prompts[0].includes('extracted text'));
    expect((await models.knowledge.list('a')).length).toBe(0);
    expect((await models.start('a', request)).runId).toBe(first.id);
    expect(prompts.length).toBe(1);
    await writeFile(path.join(first.workdir, 'alias.pdf'), 'model-modified-copy');
    await writeFile(path.join(first.workdir, mapping.textName), 'model-modified-text');
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await models.start('a', {
      requestId: 'mock-document-retry',
      prompt: '重试读取原输入',
      retryOf: first.id,
    });
    const retried = models.jobs.get('a')!;
    await retried.done;
    expect(retried.workdir).not.toBe(first.workdir);
    expect((await readFile(path.join(retried.workdir, 'alias.pdf'))).equals(original)).toBe(true);
    expect(
      await readFile(path.join(retried.workdir, retried.documentInputs![0].textName), 'utf8'),
    ).toBe('MOCK-47');
    await expect(
      models.start('b', {
        requestId: 'mock-cross-document',
        prompt: '不能读取另一位 Bot 的附件',
        files: [{ name: 'foreign.pdf', attachmentId: uploaded.id }],
      }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('user tasks reach DSH, return real files, deduplicate requests and preserve per-Bot sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-freeform-'));
  try {
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'model', 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-private-model-key' });
    const prompts: string[] = [],
      resumed: string[] = [];
    let models: ModelRuns;
    class FakeHarness {
      constructor(readonly options: { processCwd: string; env: NodeJS.ProcessEnv }) {}
      async start() {}
      async close() {}
      session(id = 'synthetic-session-a') {
        return {
          id,
          run: async (prompt: unknown) => {
            expect.assert(typeof prompt === 'string');
            prompts.push(prompt);
            expect(this.options.processCwd).toBe(models.jobs.get('a')!.privateDir);
            if (!prompt.includes('不生成新文件'))
              await writeFile(
                path.join(models.jobs.get('a')!.workdir, 'summary.md'),
                '# 合成摘要\n总数=3',
              );
            const job = models.jobs.get('a')!;
            job.trace.push({
              name: 'act',
              surface: 'desktop',
              phase: 'settled',
              at: '2026-01-01T00:00:00Z',
            });
            return { sessionId: id, finalResponse: '已生成 summary.md，合成总数为 3。' };
          },
        };
      }
      async resumeSession(id: string) {
        resumed.push(id);
        return this.session(id);
      }
    }
    const fake = {
      page: () => ({}),
      stopWorker: async () => {},
      control: new Control(['a', 'b']),
      screens: {
        screen: () => ({ workspace: path.join(root, 'workspace') }),
        windows: async () => [],
        input: async () => {},
        openApp: async () => {},
      },
      frame: async () => Buffer.from('synthetic'),
      browser: { frame: async () => Buffer.from('synthetic'), input: async () => {} },
      snapshot: async () => ({ sharedLogin: true }),
    };
    const options = {
      runtime: fake as unknown as Desktop,
      settings,
      origin: 'http://127.0.0.1:12345',
      dir: path.join(root, 'model'),
      Harness: FakeHarness,
    };
    models = new ModelRuns(options);
    await models.ready;
    const request = {
      requestId: 'mock-request-1',
      prompt: '根据实际文件计算合成总数，输出 summary.md',
      files: [{ name: 'input.csv', content: 'item,count\nmock,3' }],
    };
    const first = await models.start('a', request);
    expect(models.findRequest('a', request.requestId)?.runId).toBe(first.runId);
    await models.jobs.get('a')!.done;
    expect.assert(prompts[0].includes(request.prompt));
    expect.assert(!prompts[0].includes('paid_count'));
    expect(models.status().bots.a.phase).toBe('completed');
    expect.assert(models.status().bots.a.files.some((file) => file.path.endsWith('/summary.md')));
    expect(models.status().bots.a.requestId).toBe(request.requestId);
    expect.assert(
      (await readFile(path.join(models.jobs.get('a')!.workdir, 'summary.md'), 'utf8')).includes(
        '总数=3',
      ),
    );
    expect((await models.start('a', request)).runId).toBe(first.runId);
    expect(prompts.length).toBe(1);
    await expect(models.start('a', { ...request, prompt: '另一个合成请求' })).rejects.toMatchObject(
      {
        code: 'REQUEST_ID_REUSED',
      },
    );
    await models.start('a', { requestId: 'mock-request-2', prompt: '继续核对刚才的合成摘要' });
    await models.jobs.get('a')!.done;
    expect(resumed).toStrictEqual(['synthetic-session-a']);
    expect(models.findRequest('a', request.requestId)?.phase).toBe('completed');
    expect(models.findRequest('b', request.requestId)).toBe(undefined);
    await models.start('a', {
      requestId: 'mock-request-3',
      prompt: '不生成新文件，只核对数据',
      files: [],
    });
    await models.jobs.get('a')!.done;
    expect(models.status().bots.a.files).toStrictEqual([]);
    await expect(
      readFile(path.join(models.jobs.get('a')!.workdir, 'input.csv')),
      'a normal turn must not invent business input',
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(models.status().bots.a.verified).toBe(false);
    const cachedInput = 'item,count\nmock,3';
    await models.start('a', {
      requestId: 'mock-retry-request',
      prompt: '重试合成任务，读取原输入',
      retryOf: first.runId,
    });
    await models.jobs.get('a')!.done;
    expect(
      await readFile(path.join(models.jobs.get('a')!.workdir, 'input.csv'), 'utf8'),
      'retry must reuse the actual original input instead of reseeding demo data',
    ).toBe(cachedInput);
    expect(models.jobs.get('a')!.intentId).toBe(first.runId);
    const continuedRun = models.jobs.get('a')!.id;
    await models.start('a', {
      requestId: 'mock-retry-again',
      prompt: '再次继续合成任务',
      retryOf: continuedRun,
    });
    await models.jobs.get('a')!.done;
    expect(models.jobs.get('a')!.intentId).toBe(first.runId);
    await expect(
      models.start('b', {
        requestId: 'mock-cross-bot-retry',
        prompt: '合成请求',
        retryOf: first.runId,
      }),
    ).rejects.toMatchObject({ code: 'RETRY_NOT_FOUND' });
    const recovered = new ModelRuns(options);
    await recovered.ready;
    expect(recovered.status().bots.a.history.length).toBe(5);
    expect(recovered.jobs.get('a')!.intentId).toBe(first.runId);
    expect(JSON.stringify(recovered.status()).includes('synthetic-private-model-key')).toBe(false);
    await models.close();
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary dialogue can finish with zero tools and no files while the screen is human-owned', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-dialogue-'));
  try {
    const control = new Control(['a', 'b']);
    await control.transfer('a', 0, 'human');
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'model', 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-dialogue-key' });
    let system = '',
      prompt = '';
    class FakeHarness {
      constructor(options: { env: NodeJS.ProcessEnv }) {
        system = options.env.DSH_SYSTEM_PROMPT || '';
      }
      async start() {}
      async close() {}
      session() {
        return {
          id: 'mock-dialogue-session',
          run: async (text: unknown) => {
            expect.assert(typeof text === 'string');
            prompt = text;
            expect(
              models.status().bots.a.phase,
              'a human-owned screen must not label ordinary reasoning as paused',
            ).toBe('running');
            return { sessionId: 'mock-dialogue-session', finalResponse: '你好，有什么可以帮你？' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    const runtime = {
      page: () => ({}),
      stopWorker: async () => {},
      control,
      screens: {
        screen: () => ({ workspace: path.join(root, 'workspace') }),
        windows: async () => [],
        input: async () => {
          throw new Error('unexpected desktop input');
        },
        openApp: async () => {
          throw new Error('unexpected app');
        },
      },
      frame: async () => {
        throw new Error('unexpected screenshot');
      },
      browser: {
        frame: async () => {
          throw new Error('unexpected browser');
        },
        input: async () => {
          throw new Error('unexpected browser input');
        },
      },
      snapshot: async () => ({ sharedLogin: true }),
    } as unknown as Desktop;
    const models = new ModelRuns({
      runtime,
      settings,
      origin: 'http://127.0.0.1:12345',
      dir: path.join(root, 'model'),
      Harness: FakeHarness,
    });
    await models.start('a', { requestId: 'mock-hello', prompt: '你好' });
    await models.jobs.get('a')!.done;
    const status = models.status().bots.a;
    expect(status.phase).toBe('completed');
    expect(status.toolCount).toBe(0);
    expect(status.files).toStrictEqual([]);
    expect(status.result).toBe('你好，有什么可以帮你？');
    expect(system).toMatch(/general.purpose/i);
    expect.assert(!system.includes('Your only tools are the computer'));
    expect.assert(!prompt.includes('Take a screenshot first'));
    expect.assert(!prompt.includes('Input file:'));
    await models.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('the general agent core exposes workspace and preference tools without an attached computer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-headless-agent-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-headless-key' });
    let models: ModelRuns,
      names: string[] = [];
    class FakeHarness {
      async start() {}
      async close() {}
      session() {
        return {
          id: 'mock-headless-session',
          run: async () => {
            const job = models.jobs.get('a')!;
            const result = (await models.rpc('a', `Bearer ${job.token}`, {
              id: 1,
              method: 'tools/list',
            })) as { result: { tools: { name: string }[] } };
            names = result.result.tools.map((tool) => tool.name);
            return { sessionId: 'mock-headless-session', finalResponse: '你好，可以直接聊天。' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    models = new ModelRuns({
      settings,
      workspace,
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness: FakeHarness,
    });
    await models.start('a', { requestId: 'mock-headless-turn', prompt: '你好' });
    await models.jobs.get('a')!.done;
    expect(models.status().bots.a.phase).toBe('completed');
    expect(models.status().bots.a.toolCount).toBe(0);
    expect.assert(names.includes('read_file') && names.includes('shell'));
    expect.assert(names.includes('bot_memory_read') && names.includes('bot_memory_write'));
    expect.assert(names.includes('bot_history_search') && names.includes('bot_history_read'));
    expect.assert(names.includes('bot_knowledge_search') && names.includes('bot_knowledge_export'));
    expect.assert(!names.includes('screenshot') && !names.includes('act'));
    await models.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('retiring a computer-only session preserves its conversation context and starts a general session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-agent-migration-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-migration-key' });
    const { TaskJournal } = await import('./tasks.js');
    const journal = new TaskJournal(path.join(root, 'model', 'task-journal'));
    await journal.load();
    await journal.put({
      bot: 'a',
      runId: 'old-run',
      requestId: 'old-request',
      kind: 'chat',
      prompt: '请记住合成项目 Mock Alpha',
      phase: 'completed',
      running: false,
      result: '已记录合成背景',
      error: '',
      sessionId: 'old-computer-session',
      trace: [],
    });
    const resumed: string[] = [];
    let observed = '';
    class FakeHarness {
      async start() {}
      async close() {}
      session() {
        return {
          id: 'new-general-session',
          run: async (prompt: unknown) => {
            expect.assert(typeof prompt === 'string');
            observed = prompt;
            return { sessionId: 'new-general-session', finalResponse: '我是通用助手。' };
          },
        };
      }
      async resumeSession(id: string) {
        resumed.push(id);
        return this.session();
      }
    }
    const models = new ModelRuns({
      settings,
      workspace,
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness: FakeHarness,
    });
    await models.start('a', { requestId: 'new-general-request', prompt: '你能做什么' });
    await models.jobs.get('a')!.done;
    expect(
      resumed,
      'the old computer-only system context must not silently survive the mode migration',
    ).toStrictEqual([]);
    expect.assert(observed.includes('Mock Alpha'));
    expect.assert(models.status().bots.a.history.some((item) => item.runId === 'old-run'));
    const record = models.journal.findRequest('a', 'new-general-request');
    expect((record as unknown as Record<string, unknown>).sessionProfile).toBe(
      'general-v12-local-files',
    );
    await models.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('an unbound Bot can persist an independent DSH conversation without touching computer routing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-unbound-agent-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-unbound-key' });
    const control = new Control(['a', 'b']);
    let models: ModelRuns;
    let names: string[] = [];
    const fail = () => {
      throw new Error('unbound agent must not touch computer');
    };
    const runtime = {
      control,
      page: fail,
      stopWorker: fail,
      screens: { screen: () => ({ workspace }), input: fail, openApp: fail },
      frame: fail,
      browser: { frame: fail, input: fail },
    } as unknown as Desktop;
    class FakeHarness {
      async start() {}
      async close() {}
      session() {
        return {
          id: 'mock-unbound-session',
          run: async () => {
            const job = models.jobs.get('chief')!;
            const response = (await models.rpc('chief', `Bearer ${job.token}`, {
              id: 1,
              method: 'tools/list',
            })) as { result: { tools: { name: string }[] } };
            names = response.result.tools.map((tool) => tool.name);
            return { sessionId: 'mock-unbound-session', finalResponse: '你好' };
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    models = new ModelRuns({
      runtime,
      workspace,
      settings,
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness: FakeHarness,
    });
    await models.start('chief', { requestId: 'mock-chief-turn', prompt: '你好' });
    await models.jobs.get('chief')!.done;
    expect(models.status().bots.chief.phase).toBe('completed');
    expect(models.status().bots.chief.toolCount).toBe(0);
    expect.assert(!names.includes('screenshot'));
    await models.close();
    const recovered = new ModelRuns({
      runtime,
      workspace,
      settings,
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness: FakeHarness,
    });
    await recovered.ready;
    expect(recovered.status().bots.chief.result).toBe('你好');
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('durable Bot persona reaches DSH, preferences survive restart, and changed persona starts a fresh system context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-persona-model-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-persona-key' });
    let system = '',
      prompt = '';
    const resumed: string[] = [];
    let sequence = 0;
    class FakeHarness {
      constructor(options: { env: NodeJS.ProcessEnv }) {
        system = options.env.DSH_SYSTEM_PROMPT || '';
      }
      async start() {}
      async close() {}
      session(id = `synthetic-persona-${++sequence}`) {
        return {
          id,
          run: async (text: unknown) => {
            expect.assert(typeof text === 'string');
            prompt = text;
            return { sessionId: id, finalResponse: '合成回复' };
          },
        };
      }
      async resumeSession(id: string) {
        resumed.push(id);
        return this.session(id);
      }
    }
    const options = {
      settings,
      workspace,
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness: FakeHarness,
    };
    const models = new ModelRuns(options);
    await models.ready;
    await models.profiles.register({
      id: 'mock-persona',
      name: '合成研究助理',
      instructions: '总是先给两条依据。',
      memory: '合成偏好：使用编号。',
      color: 'mint',
    });
    await models.start('mock-persona', { requestId: 'mock-persona-first', prompt: '你叫什么' });
    await models.jobs.get('mock-persona')!.done;
    expect.assert(system.includes('合成研究助理') && system.includes('先给两条依据'));
    expect.assert(prompt.includes('使用编号'));
    await models.start('mock-persona', { requestId: 'mock-persona-second', prompt: '接着聊' });
    await models.jobs.get('mock-persona')!.done;
    expect(resumed.length).toBe(1);
    await models.profiles.update('mock-persona', 1, {
      name: '合成写作助理',
      instructions: '先给一句简短结论。',
    });
    await models.start('mock-persona', { requestId: 'mock-persona-third', prompt: '你现在叫什么' });
    await models.jobs.get('mock-persona')!.done;
    expect(resumed.length, 'a changed persona must not reuse a frozen old system prompt').toBe(1);
    expect.assert(system.includes('合成写作助理'));
    await models.close();
    const recovered = new ModelRuns(options);
    await recovered.ready;
    expect((await recovered.profiles.get('mock-persona'))?.memory).toBe('合成偏好：使用编号。');
    expect(recovered.status().bots['mock-persona'].history.length).toBe(3);
    await recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a selected model reaches DSH and only matching model sessions resume, including after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-selected-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const configured: string[] = [],
    resumed: string[] = [],
    prompts: string[] = [];
  let sequence = 0;
  class FakeHarness {
    constructor(options: { model: string }) {
      configured.push(options.model);
    }
    async start() {}
    async close() {}
    session(id = `mock-model-session-${++sequence}`) {
      return {
        id,
        run: async (prompt: unknown) => {
          expect.assert(typeof prompt === 'string');
          prompts.push(prompt);
          return { sessionId: id, finalResponse: '合成模型回复 MODEL-47' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  };
  let models = new ModelRuns(options);
  try {
    await settings.save({ apiKey: 'synthetic-selected-key' });
    await models.ready;
    for (const id of ['one', 'two']) {
      await models.start('mock-model', { requestId: id, prompt: '合成上下文 MODEL-47' });
      await models.jobs.get('mock-model')!.done;
    }
    expect(resumed.length).toBe(1);
    await settings.save({ apiKey: 'synthetic-selected-key', model: 'deepseek-v4-pro' });
    await models.start('mock-model', { requestId: 'three', prompt: '继续合成任务' });
    await models.jobs.get('mock-model')!.done;
    expect(configured.at(-1)).toBe('deepseek-v4-pro');
    expect(resumed.length, 'a changed model must not resume the frozen route').toBe(1);
    expect.assert(
      prompts.at(-1)!.includes('MODEL-47'),
      'preserve bounded history when changing models',
    );
    const job = models.jobs.get('mock-model')!;
    const patch = JSON.parse(
      await readFile(path.join(job.privateDir, 'computer.patch.yml'), 'utf8'),
    );
    const provider = patch
      .find((row: { insert?: unknown }) => row.insert)
      .insert.find((row: { id: string }) => row.id === 'desktop-model-provider').config.providers[
      'deepseek-official'
    ];
    expect(provider.models[0].id).toBe('deepseek-v4-pro');
    expect(provider.models[0].input).toStrictEqual(['text']);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await models.start('mock-model', { requestId: 'four', prompt: '再次继续' });
    await models.jobs.get('mock-model')!.done;
    expect(resumed.length, 'same-model sessions survive a service reconstruction').toBe(2);
    expect(models.status().bots['mock-model'].history.length).toBe(4);
    const last = models.jobs.get('mock-model')!;
    await models.close();
    const file = path.join(root, 'model/task-journal', `${last.id}.json`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.task.sessionModel = 'unknown-model';
    await writeFile(file, JSON.stringify(saved));
    await settings.save({ apiKey: 'synthetic-selected-key', model: 'deepseek-flash' });
    models = new ModelRuns(options);
    await models.ready;
    await models.start('mock-model', { requestId: 'five', prompt: '重新开始合成任务' });
    await models.jobs.get('mock-model')!.done;
    expect(
      resumed.length,
      'unknown saved model metadata must not be treated as the legacy Flash route',
    ).toBe(2);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent Bots capture independent model overrides and current tasks survive later profile/default changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-bot-models-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const routes: { bot: string; model: string }[] = [];
  let release!: () => unknown;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  let hold = true;
  let sequence = 0;
  const resumed: string[] = [];
  class FakeHarness {
    constructor(options: { cwd: string; model: string }) {
      routes.push({ bot: path.basename(options.cwd), model: options.model });
    }
    async start() {}
    async close() {}
    session(id = `mock-independent-${++sequence}`) {
      return {
        id,
        run: async () => {
          if (hold) await gate;
          return { sessionId: id, finalResponse: '合成独立模型结果' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  };
  let models = new ModelRuns(options);
  try {
    await settings.save({ apiKey: 'synthetic-shared-account' });
    await models.ready;
    await models.profiles.register({
      id: 'mock-alpha',
      name: '合成甲',
      instructions: '',
      memory: '合成偏好甲',
      color: 'mint',
    });
    await models.profiles.register({
      id: 'mock-beta',
      name: '合成乙',
      instructions: '',
      memory: '合成偏好乙',
      color: 'violet',
      model: 'deepseek-v4-pro',
    });
    await Promise.all(
      ['mock-alpha', 'mock-beta'].map((bot) =>
        models.start(bot, { requestId: `first-${bot}`, prompt: '只回复合成标记' }),
      ),
    );
    const deadline = Date.now() + 5000;
    while (routes.length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(
      routes.length,
      'both accepted jobs must initialize their harness before this check',
    ).toBe(2);
    expect(routes.slice().sort((a, b) => a.bot.localeCompare(b.bot))).toStrictEqual([
      { bot: 'mock-alpha', model: 'deepseek-flash' },
      { bot: 'mock-beta', model: 'deepseek-v4-pro' },
    ]);
    await models.profiles.update('mock-beta', 1, { model: 'deepseek-flash' });
    await settings.save({ apiKey: 'synthetic-shared-account', model: 'deepseek-v4-pro' });
    expect(models.running('mock-alpha')).toBe(true);
    expect(models.running('mock-beta')).toBe(true);
    const alpha = models.status().bots['mock-alpha'];
    const beta = models.status().bots['mock-beta'];
    expect.assert('model' in alpha && 'model' in beta);
    expect(alpha.model).toBe('deepseek-flash');
    expect(beta.model).toBe('deepseek-v4-pro');
    hold = false;
    release();
    await Promise.all(['mock-alpha', 'mock-beta'].map((bot) => models.jobs.get(bot)!.done));
    await Promise.all(
      ['mock-alpha', 'mock-beta'].map((bot) =>
        models.start(bot, { requestId: `second-${bot}`, prompt: '下一轮合成任务' }),
      ),
    );
    await Promise.all(['mock-alpha', 'mock-beta'].map((bot) => models.jobs.get(bot)!.done));
    expect(routes.slice(-2).sort((a, b) => a.bot.localeCompare(b.bot))).toStrictEqual([
      { bot: 'mock-alpha', model: 'deepseek-v4-pro' },
      { bot: 'mock-beta', model: 'deepseek-flash' },
    ]);
    expect((await models.profiles.get('mock-beta'))?.memory).toBe('合成偏好乙');
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await models.start('mock-beta', { requestId: 'after-restart', prompt: '重启续接' });
    await models.jobs.get('mock-beta')!.done;
    expect(routes.at(-1)?.model).toBe('deepseek-flash');
    expect(resumed.length).toBe(1);
    await models.profiles.update('mock-beta', 2, { model: null });
    await models.start('mock-beta', { requestId: 'inherit-again', prompt: '恢复跟随' });
    await models.jobs.get('mock-beta')!.done;
    expect(routes.at(-1)?.model).toBe('deepseek-v4-pro');
    const evidence = JSON.parse(
      await readFile(path.join(models.jobs.get('mock-beta')!.privateDir, 'result.json'), 'utf8'),
    );
    expect(evidence.model).toBe('deepseek-v4-pro');
  } finally {
    hold = false;
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed or empty DSH turns retire only their own conversation session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-failed-conversation-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'synthetic-failure-key' });
  let sequence = 0,
    failure: 'throw' | 'empty' | undefined;
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-session-${++sequence}`) {
      return {
        id,
        run: async () => {
          const mode = failure;
          failure = undefined;
          if (mode === 'throw') throw new Error('SYNTHETIC-FAILED-TURN');
          return { sessionId: id, finalResponse: mode === 'empty' ? '' : 'SYNTHETIC-OK' };
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
    Harness,
  });
  let count = 0;
  const scope = { id: 'mock-failed-group', context: '' };
  async function turn(conversation?: ConversationScope) {
    await models.start(
      'a',
      { requestId: `mock-turn-${++count}`, prompt: '合成会话验收' },
      conversation,
    );
    await models.jobs.get('a')!.done;
    return models.status().bots.a;
  }
  try {
    await models.ready;
    const dm = await turn(),
      group = await turn(scope);
    failure = 'throw';
    expect((await turn(scope)).phase).toBe('failed');
    expect((await turn()).sessionId).toBe(dm.sessionId);
    const freshGroup = await turn(scope);
    expect(freshGroup.sessionId).not.toBe(group.sessionId);
    failure = 'empty';
    expect((await turn()).phase).toBe('failed');
    expect((await turn(scope)).sessionId).toBe(freshGroup.sessionId);
    expect((await turn()).sessionId).not.toBe(dm.sessionId);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh and resumed DSH sessions move to the private working directory before any prompt without replacing history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-session-directory-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const settings = new ModelSettings(path.join(root, 'model/credentials.json'));
  await settings.save({ apiKey: 'synthetic-session-directory-key' });
  const events: string[] = [],
    resumed: string[] = [];
  class Harness {
    constructor(readonly options: { cwd: string }) {}
    async start() {}
    async close() {}
    session(id = 'mock-retained-session') {
      let directory = path.join(root, 'legacy-public-task');
      return {
        id,
        setWorkingDirectory: async (value: string) => {
          directory = value;
          events.push('directory');
          return value;
        },
        run: async () => {
          events.push('prompt');
          expect(directory).toBe(this.options.cwd);
          return { sessionId: id, finalResponse: 'SYNTHETIC-CONTEXT-RETAINED' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    workspace: path.join(root, 'shared'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  t.onTestFinished(async () => {
    await models.close();
  });
  await models.ready;
  for (const index of [1, 2]) {
    await models.start('mock-directory-agent', {
      requestId: `mock-directory-${index}`,
      prompt: '合成会话续接检查',
    });
    const job = models.jobs.get('mock-directory-agent')!;
    await job.done;
    expect(job.phase).toBe('completed');
    expect(job.sessionId).toBe('mock-retained-session');
  }
  expect(events).toStrictEqual(['directory', 'prompt', 'directory', 'prompt']);
  expect(resumed).toStrictEqual(['mock-retained-session']);
});
