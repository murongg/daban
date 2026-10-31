import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model proof uses synthetic work and reads the existing provider key only in its original guest.
export async function acceptWork(output = '/tmp/daban-work-model-verification.json') {
  assert.equal(process.platform, 'linux');
  const credentials = '/var/lib/bot-prototype/model/credentials.json';
  async function identity() {
    const info = await stat(credentials);
    return {
      inode: info.ino,
      size: info.size,
      mtime: info.mtimeMs,
      mode: info.mode,
      sha: createHash('sha256')
        .update(await readFile(credentials))
        .digest('hex'),
    };
  }
  const before = await identity();
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-work-model-'));
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = {
    verified: false,
    syntheticOnly: true,
    originalServiceModified: false,
  };
  const previousProxy = process.env.DSH_NETWORK_PROXY;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const bot = request.url?.match(/^\/mcp\/(mock-alpha|mock-beta)$/)?.[1];
      assert.ok(models && bot);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size <= 512 * 1024);
        chunks.push(Buffer.from(chunk));
      }
      const result = await models.rpc(
        bot,
        request.headers.authorization,
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      response.writeHead(result === null ? 202 : 200, { 'content-type': 'application/json' });
      response.end(result === null ? undefined : JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end('{}');
    }
  });
  try {
    try {
      const network: unknown = JSON.parse(
        await readFile('/var/lib/bot-prototype/model/network.json', 'utf8'),
      );
      if (
        network &&
        typeof network === 'object' &&
        'proxy' in network &&
        typeof network.proxy === 'string'
      )
        process.env.DSH_NETWORK_PROXY = network.proxy;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    models = new ModelRuns({
      settings: new ModelSettings(credentials),
      dir: path.join(directory, 'model'),
      workspace: path.join(directory, 'shared'),
      origin: `http://127.0.0.1:${address.port}`,
    });
    await models.ready;
    for (const bot of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id: bot,
        name: bot,
        instructions: 'MOCK ROLE',
        memory: '',
        color: 'mint',
      });
    async function turn(bot: string, requestId: string, prompt: string, retryOf?: string) {
      assert.ok(models);
      await models.start(bot, { requestId, prompt, ...(retryOf ? { retryOf } : {}) });
      const job = models.jobs.get(bot)!;
      const timer = setTimeout(() => {
        models?.stop(bot, 'acceptance-deadline').catch(() => {});
      }, 180000);
      try {
        await job.done;
      } finally {
        clearTimeout(timer);
      }
      evidence[requestId] = {
        runId: job.id,
        phase: job.phase,
        error: job.error,
        toolCount: job.toolCount,
        tools: job.trace.map(({ name, surface, phase }) => ({ name, surface, phase })),
        files: job.files.map(({ path }) => path),
      };
      assert.equal(job.phase, 'completed', job.error);
      assert.equal(
        job.trace.some((row) => ['desktop', 'browser', 'web'].includes(row.surface)),
        false,
      );
      return job;
    }
    assert.equal((await models.work.list()).items.length, 0);
    const first = await turn(
      'mock-alpha',
      'mock-work-create',
      '这是合成验收。请先用 task_catalog 查看实际状态，然后只新建一张共享待办，title 精确为“合成共享待办验收”，description 精确为“只处理合成数字 17 和 25；验证求和结果。”，progress 为空，status 为 todo。调用 work_create 后 work_read 回读核对。现在只登记，不要执行计算、不用电脑、网页或文件，不要建日程和资料。',
    );
    assert.equal(first.files.length, 0);
    let page = await models.work.list();
    assert.equal(page.items.length, 1);
    const original = await models.work.get(page.items[0].id);
    assert.equal(original.title, '合成共享待办验收');
    assert.equal(original.status, 'todo');
    assert.deepEqual(original.createdBy, { kind: 'bot', bot: 'mock-alpha' });
    const second = await turn(
      'mock-beta',
      'mock-work-execute',
      '这是同一合成验收的第二位 Bot。先 task_catalog 查共享待办，再 work_read 读完整的“合成共享待办验收”。本轮明确授权你处理此合成事项：用 shell 执行 Python，将 17+25 的真实计算结果存成当前任务目录 verified.json，内容形如 {"sum":42}；再用 read_file 回读验证。仅在文件正确后 work_update 把该卡片 status 改 done、progress 精确设为“合成计算已验证：17 + 25 = 42”，保留标题与说明，之后 work_read 回读核对。不要新建卡片、日程或资料，不用电脑和网页。',
    );
    assert.notEqual(second.sessionId, first.sessionId);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(second.workdir, 'verified.json'), 'utf8')),
      { sum: 42 },
    );
    assert.ok(second.trace.some((row) => row.name === 'shell' && row.phase === 'settled'));
    const updated = await models.work.get(original.id);
    assert.equal(updated.status, 'done');
    assert.equal(updated.progress, '合成计算已验证：17 + 25 = 42');
    assert.deepEqual(updated.updatedBy, { kind: 'bot', bot: 'mock-beta' });
    const args = {
      title: original.title,
      description: original.description,
      progress: original.progress,
      status: original.status,
    };
    const retried = await turn(
      'mock-alpha',
      'mock-work-retry',
      `这是原创建请求的受控重试。请只用下面完全相同的参数再次调用 work_create 来验证幂等，再 work_read 核对返回的同一卡片：${JSON.stringify(args)}。其他 Bot 已更新进展，必须保留后来的 done 和进展，不要使用 work_update、不要计算或创建文件，不用电脑、网页和日程。`,
      first.id,
    );
    page = await models.work.list();
    assert.equal(page.items.length, 1);
    assert.deepEqual(await models.work.get(original.id), updated);
    assert.equal(retried.intentId, first.id);
    assert.ok(retried.trace.some((row) => row.name === 'work_create' && row.phase === 'settled'));
    const greeting = await turn(
      'mock-alpha',
      'mock-work-greeting',
      '普通问候验收，只回复 MOCK-HELLO。不要使用任何工具，不要查询目录、待办、记忆、文件或电脑。',
    );
    assert.equal(greeting.toolCount, 0);
    const transcript = await models.transcript({
      bot: 'mock-beta',
      runId: second.id,
      chatRevision: 0,
    });
    assert.ok(
      transcript.items.some((row) => row.kind === 'call' && row.name?.includes('work_update')),
    );
    evidence.nativeTranscriptRecords = transcript.items.length;
    evidence.verifiedOutput = { file: 'verified.json', sum: 42 };
    evidence.sameCardAfterContinuation = true;
    evidence.distinctBotSessions = true;
    evidence.normalGreetingZeroTools = true;
    evidence.verified = true;
  } finally {
    try {
      await models?.close();
    } finally {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
      if (previousProxy === undefined) delete process.env.DSH_NETWORK_PROXY;
      else process.env.DSH_NETWORK_PROXY = previousProxy;
      evidence.credentialsUnchanged = JSON.stringify(before) === JSON.stringify(await identity());
      await rm(directory, { recursive: true, force: true });
      evidence.temporaryDataRemoved = true;
      await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    }
  }
  assert.equal(evidence.credentialsUnchanged, true);
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptWork(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      credentialsUnchanged: result.credentialsUnchanged,
      temporaryDataRemoved: result.temporaryDataRemoved,
    }),
  );
}
