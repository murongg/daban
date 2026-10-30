import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual inference proof: synthetic prompts and isolated data; the key stays in its original guest file.
export async function acceptNotes(output = '/tmp/daban-notes-model-verification.json') {
  assert.equal(process.platform, 'linux');
  const credentials = '/var/lib/bot-prototype/model/credentials.json';
  async function identity() {
    const info = await stat(credentials);
    return {
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
    directory = await mkdtemp(path.join(tmpdir(), 'daban-notes-model-'));
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = {
    verified: false,
    syntheticOnly: true,
    originalServiceModified: false,
    inferenceRounds: 0,
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
    for (const id of ['mock-alpha', 'mock-beta'])
      await models.profiles.register({
        id,
        name: id,
        instructions: '仅处理本轮合成验收。',
        memory: '',
        color: 'mint',
        model: 'deepseek-flash',
      });
    async function turn(bot: string, requestId: string, prompt: string, retryOf?: string) {
      assert.ok(models);
      evidence.inferenceRounds = Number(evidence.inferenceRounds) + 1;
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
        toolCount: job.toolCount,
        tools: job.trace.map(({ name, surface, phase }) => ({ name, surface, phase })),
        files: job.files.length,
      };
      await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      assert.equal(job.phase, 'completed', 'SYNTHETIC_NOTE_TASK_FAILED');
      assert.equal(job.files.length, 0);
      assert.ok(job.trace.every((row) => ['notes', 'catalog'].includes(row.surface)));
      return job;
    }
    const args = {
      title: '合成独立便笺验收',
      body: '只处理合成事项 17 与 25，稍后核对。',
      status: 'parked',
    };
    const first = await turn(
      'mock-alpha',
      'mock-note-add',
      `这是合成验收。先 task_catalog 核对本 Bot 便笺，然后 bot_notes_list 查看现有记录，只用以下精确参数调用 bot_notes_add 一次，再 bot_notes_read 回读核对：${JSON.stringify(args)}。现在只保存，不执行事项，不用文件、电脑、网页、记忆、共享待办或日程。`,
    );
    const page = await models.notes.list('mock-alpha', { filter: 'all' });
    assert.equal(page.items.length, 1);
    const original = await models.notes.get('mock-alpha', page.items[0].id);
    assert.equal(original.title, args.title);
    assert.equal(original.body, args.body);
    assert.equal(original.status, args.status);
    assert.deepEqual(original.createdBy, { kind: 'bot', bot: 'mock-alpha' });
    const betaArgs = { title: args.title, body: '这是乙的独立合成记录。', status: 'open' };
    const second = await turn(
      'mock-beta',
      'mock-note-private-beta',
      `你是第二位 Bot。本轮只做合成验收：先 task_catalog、bot_notes_list 核对自己的便笺为空，不查其他 Bot；然后只用以下精确参数 bot_notes_add 一次并 bot_notes_read 回读核对：${JSON.stringify(betaArgs)}。不要用文件、电脑、网页、记忆、共享待办或日程。`,
    );
    assert.notEqual(first.sessionId, second.sessionId);
    const beta = await models.notes.list('mock-beta', { filter: 'all' });
    assert.equal(beta.items.length, 1);
    assert.notEqual(beta.items[0].id, original.id);
    assert.equal((await models.notes.get('mock-beta', beta.items[0].id)).body, betaArgs.body);
    await assert.rejects(models.notes.get('mock-beta', original.id), /NOTE_NOT_FOUND/);
    evidence.privateBotScopesVerified = true;
    evidence.distinctBotSessions = true;
    const human = await models.notes.write(
      'mock-alpha',
      {
        id: 'mock-human-later',
        note: original.id,
        action: 'update',
        revision: 1,
        value: { body: '合成人工后续修改，应被保留。', status: 'done' },
      },
      { kind: 'human' },
    );
    const retry = await turn(
      'mock-alpha',
      'mock-note-exact-retry',
      `这是原登记请求的受控重试。请用完全相同参数再次调用 bot_notes_add 恢复回执，再 bot_notes_read 核对原记录：${JSON.stringify(args)}。人工已改为 done 并更新正文；必须保留后续修改，不调用 update，不新建其他便笺，不用其他工具。`,
      first.id,
    );
    evidence.retryIntentMatches = retry.intentId === first.id;
    evidence.alphaCountAfterRetry = (
      await models.notes.list('mock-alpha', { filter: 'all' })
    ).items.length;
    evidence.retryKeepsHumanRecord = isDeepStrictEqual(
      await models.notes.get('mock-alpha', original.id),
      human.item,
    );
    assert.equal(retry.intentId, first.id);
    assert.ok(retry.trace.some((row) => row.name === 'bot_notes_add' && row.phase === 'settled'));
    assert.equal((await models.notes.list('mock-alpha', { filter: 'all' })).items.length, 1);
    assert.deepEqual(await models.notes.get('mock-alpha', original.id), human.item);
    const transcript = await models.transcript({
      bot: 'mock-alpha',
      runId: first.id,
      chatRevision: 0,
    });
    evidence.nativeCallNames = transcript.items
      .filter((row) => row.kind === 'call')
      .map((row) => row.name);
    assert.ok(
      transcript.items.some((row) => row.kind === 'call' && row.name?.endsWith('bot_notes_add')),
    );
    evidence.nativeTranscriptRecords = transcript.items.length;
    evidence.privateBotScopesVerified = true;
    evidence.distinctBotSessions = true;
    evidence.exactRetryKeepsHumanEdit = true;
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
  acceptNotes(process.argv[2])
    .then((result) =>
      console.log(
        JSON.stringify({
          verified: result.verified,
          credentialsUnchanged: result.credentialsUnchanged,
          temporaryDataRemoved: result.temporaryDataRemoved,
          inferenceRounds: result.inferenceRounds,
        }),
      ),
    )
    .catch(() => {
      console.error('SYNTHETIC_NOTES_ACCEPTANCE_FAILED');
      process.exitCode = 1;
    });
}
