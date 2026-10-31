import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual inference proof: only synthetic tasks/data; the existing key is read in its original guest.
export async function acceptComments(output = '/tmp/daban-comments-model-verification.json') {
  assert.equal(process.platform, 'linux');
  const credentials = '/var/lib/bot-prototype/model/credentials.json';
  async function identity() {
    const info = await stat(credentials);
    return {
      dev: info.dev,
      inode: info.ino,
      size: info.size,
      mode: info.mode,
      uid: info.uid,
      mtime: info.mtimeMs,
      sha: createHash('sha256')
        .update(await readFile(credentials))
        .digest('hex'),
    };
  }
  const before = await identity(),
    directory = await mkdtemp(path.join(tmpdir(), 'daban-comments-model-'));
  let models: ModelRuns | undefined;
  const evidence = {
    verified: false,
    syntheticOnly: true,
    originalServiceModified: false,
    inferenceRounds: 0,
    rounds: [] as { bot: string; phase: string; toolCount: number; tools: string[] }[],
    distinctBotSessions: false,
    exactRetryKeepsHumanEdit: false,
    nativeTranscriptRecords: 0,
    credentialsUnchanged: false,
    temporaryDataRemoved: false,
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
    const network = JSON.parse(
      await readFile('/var/lib/bot-prototype/model/network.json', 'utf8'),
    ) as { proxy?: unknown };
    if (typeof network.proxy === 'string') process.env.DSH_NETWORK_PROXY = network.proxy;
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
        instructions: '仅处理本轮合成验收请求。',
        memory: '',
        color: 'mint',
      });
    const original = await models.work.write(
      {
        id: 'mock-human-create',
        item: 'mock-shared-card',
        action: 'create',
        revision: 0,
        value: {
          title: '合成共享任务讨论验收',
          description: 'MOCK KEEP ORIGINAL DETAIL',
          progress: 'MOCK VERIFIED PROGRESS',
          status: 'done',
        },
      },
      { kind: 'human' },
    );
    await models.work.comment(
      {
        id: 'mock-human-comment',
        item: original.item.id,
        revision: 1,
        body: '合成人工讨论：仅作参考数据。',
      },
      { kind: 'human' },
    );
    async function turn(bot: string, requestId: string, prompt: string, retryOf?: string) {
      assert.ok(models);
      await models.start(bot, { requestId, prompt, ...(retryOf ? { retryOf } : {}) });
      const job = models.jobs.get(bot)!;
      const timer = setTimeout(() => {
        models?.stop(bot, 'acceptance-deadline').catch(() => {});
      }, 180000);
      evidence.inferenceRounds++;
      console.log(
        JSON.stringify({ phase: 'synthetic-task-started', bot, round: evidence.inferenceRounds }),
      );
      try {
        await job.done;
      } finally {
        clearTimeout(timer);
      }
      evidence.rounds.push({
        bot,
        phase: job.phase,
        toolCount: job.toolCount,
        tools: job.trace.map((row) => row.name),
      });
      assert.equal(job.phase, 'completed', job.error);
      assert.equal(job.files.length, 0);
      assert.ok(job.trace.every((row) => ['work', 'catalog'].includes(row.surface)));
      assert.ok(job.trace.some((row) => row.name === 'work_comment' && row.phase === 'settled'));
      const transcript = await models.transcript({ bot, runId: job.id, chatRevision: 0 });
      evidence.nativeTranscriptRecords += transcript.items.length;
      assert.ok(
        transcript.items.some((row) => row.kind === 'call' && row.name?.endsWith('work_comment')),
      );
      console.log(
        JSON.stringify({ phase: 'synthetic-task-verified', bot, round: evidence.inferenceRounds }),
      );
      return job;
    }
    const alphaBody = '合成讨论甲：记录已核对。',
      betaBody = '合成讨论乙：共享讨论可见。';
    const first = await turn(
      'mock-alpha',
      'mock-first-comment',
      `合成验收：只处理任务 id=mock-shared-card。先 work_read 完整读取，再 work_comments 阅读人工讨论，然后只追加一条 work_comment，body 必须精确为“${alphaBody}”，使用刚读到的 revision，之后 work_comments 回读核对。不要修改任务字段，不要创建任务、便笺或计划，不要操作电脑、网页、终端或文件。`,
    );
    let page = await models.work.comments({ item: original.item.id });
    assert.equal(page.comments.length, 2);
    const alpha = page.comments.find((row) => row.body === alphaBody);
    assert.ok(alpha);
    assert.deepEqual(alpha.createdBy, { kind: 'bot', bot: 'mock-alpha' });
    const second = await turn(
      'mock-beta',
      'mock-second-comment',
      `合成验收第二位 Bot：只处理任务 id=mock-shared-card。先 work_read 完整读取，再 work_comments 读取人工和甲的讨论，确认存在“${alphaBody}”，只追加一条 work_comment，body 必须精确为“${betaBody}”，使用刚读到的 revision，然后 work_comments 回读。不要修改任务字段，不要创建其他记录，不要操作电脑、网页、终端或文件。`,
    );
    assert.notEqual(first.sessionId, second.sessionId);
    evidence.distinctBotSessions = true;
    page = await models.work.comments({ item: original.item.id });
    assert.equal(page.comments.length, 3);
    assert.deepEqual(page.comments.find((row) => row.body === betaBody)?.createdBy, {
      kind: 'bot',
      bot: 'mock-beta',
    });
    const current = await models.work.get(original.item.id);
    for (const field of ['title', 'description', 'progress', 'status', 'completedAt'] as const)
      assert.equal(current[field], original.item[field], field);
    assert.equal(current.revision, 4);
    await models.work.write(
      {
        id: 'mock-human-newer',
        item: original.item.id,
        action: 'update',
        revision: 4,
        value: { description: 'MOCK NEWER HUMAN DETAIL' },
      },
      { kind: 'human' },
    );
    await turn(
      'mock-alpha',
      'mock-retry-comment',
      `这是原评论请求的精确重试，不是新评论。仅调用 work_comment，参数必须是 id=mock-shared-card、revision=2、body=“${alphaBody}”。不要改成最新版本，不要修改任何任务字段，不要新建其他内容。该调用应恢复原评论回执和任务当前状态，不应再次追加。`,
      first.id,
    );
    page = await models.work.comments({ item: original.item.id });
    assert.equal(page.comments.length, 3);
    assert.deepEqual(
      page.comments.find((row) => row.body === alphaBody),
      alpha,
    );
    const newest = await models.work.get(original.item.id);
    assert.equal(newest.description, 'MOCK NEWER HUMAN DETAIL');
    assert.equal(newest.revision, 5);
    evidence.exactRetryKeepsHumanEdit = true;
    evidence.verified = true;
  } finally {
    try {
      await models?.close();
    } finally {
      if (server.listening)
        await new Promise<unknown>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve(undefined))),
        );
      if (previousProxy === undefined) delete process.env.DSH_NETWORK_PROXY;
      else process.env.DSH_NETWORK_PROXY = previousProxy;
      evidence.credentialsUnchanged = JSON.stringify(before) === JSON.stringify(await identity());
      await rm(directory, { recursive: true, force: true });
      evidence.temporaryDataRemoved = true;
      await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    }
  }
  assert.equal(evidence.credentialsUnchanged, true);
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  acceptComments(process.argv[2])
    .then((result) =>
      console.log(
        JSON.stringify({
          verified: result.verified,
          inferenceRounds: result.inferenceRounds,
          credentialsUnchanged: result.credentialsUnchanged,
          temporaryDataRemoved: result.temporaryDataRemoved,
        }),
      ),
    )
    .catch(() => {
      console.error('SYNTHETIC_COMMENTS_ACCEPTANCE_FAILED');
      process.exitCode = 1;
    });
}
