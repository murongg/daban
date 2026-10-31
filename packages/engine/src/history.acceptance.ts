import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import type { RawModelTask } from './snapshot.js';

// Paid-model check: actual old task plus explicitly synthetic filler history, never customer records.
export async function acceptHistory(output = '/tmp/daban-history-live.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-history-acceptance-'));
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = {
    verified: false,
    computerAttached: false,
    syntheticFillerCount: 135,
  };
  const readArguments: { bot: string; field?: string; limit?: number; offset?: number }[] = [];
  evidence.readArguments = readArguments;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const bot = request.url?.match(/^\/mcp\/(alpha|beta)$/)?.[1];
      assert.ok(models && bot);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) throw new Error('body too large');
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (input.method === 'tools/call' && input.params?.name === 'bot_history_read') {
        const args = input.params.arguments || {};
        readArguments.push({
          bot,
          ...(typeof args.field === 'string' &&
          ['prompt', 'result', 'partial', 'error', 'files'].includes(args.field)
            ? { field: args.field }
            : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
        });
      }
      const result = await models.rpc(bot, request.headers.authorization, input);
      response.writeHead(result === null ? 202 : 200, { 'content-type': 'application/json' });
      response.end(result === null ? undefined : JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end('{}');
    }
  });
  try {
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const options = {
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    };
    models = new ModelRuns(options);
    await models.ready;
    const alpha = await models.profiles.register({
      id: 'alpha',
      name: '合成历史助手甲',
      instructions: '简洁中文回答。',
      memory: '',
      color: 'mint',
    });
    await models.profiles.register({
      id: 'beta',
      name: '合成历史助手乙',
      instructions: '简洁中文回答。',
      memory: '',
      color: 'violet',
    });
    async function turn(
      bot: string,
      requestId: string,
      prompt: string,
      archive = false,
    ): Promise<RawModelTask> {
      assert.ok(models);
      await models.start(bot, { requestId, prompt });
      const deadline = Date.now() + 120000;
      while (models.running(bot)) {
        if (Date.now() > deadline) throw new Error('history task timed out');
        assert.equal(
          (await models.interactions.list()).some((item) => item.status === 'pending'),
          false,
        );
        await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
      }
      await models.jobs.get(bot)!.done;
      const task: RawModelTask = models.status().bots[bot];
      evidence[requestId] = task;
      assert.equal(task.phase, 'completed', task.error || 'history task failed');
      assert.equal(
        task.trace?.some((item) => ['desktop', 'browser', 'web'].includes(item.surface)),
        false,
      );
      if (!archive) {
        assert.equal(task.files.length, 0);
        assert.equal(
          task.trace?.some((item) => item.surface === 'workspace'),
          false,
        );
      }
      return task;
    }
    const originalPrompt =
      '这是合成历史验收。请用 write_file 创建 mock-archive.txt，内容原样为 MOCK-CEDAR=47。最终回复必须原样包含 MOCK-CEDAR=47 和文件名。不要打开电脑或联网。';
    const old = await turn('alpha', 'mock-original-archive', originalPrompt, true);
    assert.ok(old.runId);
    const file = old.files.find((item) => item.name === 'mock-archive.txt');
    assert.ok(file);
    const actualPath = path.join(root, 'workspace', file.path);
    assert.equal((await readFile(actualPath, 'utf8')).trim(), 'MOCK-CEDAR=47');
    const before = (await stat(actualPath)).mtimeMs;
    const epoch = Number(old.runId.split('-')[0]);
    for (let i = 0; i < 135; i++)
      await models.journal.put({
        bot: 'alpha',
        runId: `${epoch + i + 1}-synthetic-${String(i).padStart(4, '0')}`,
        requestId: `mock-filler-${i}`,
        kind: 'chat',
        prompt: `合成填充任务 ${i}`,
        result: `合成无关回答 ${i}`,
        phase: 'completed',
        running: false,
        error: '',
        trace: [],
        files: [],
        inputs: [],
        createdAt: new Date(epoch + i + 1).toISOString(),
      });
    assert.equal(
      models.journal.history('alpha').some((item) => item.runId === old.runId),
      false,
    );
    // A persona change forces a fresh DSH context; the bounded fallback contains only unrelated filler.
    await models.profiles.update('alpha', alpha.revision, {
      instructions: '只根据实际检索到的历史证据回答，不从旧模型上下文猜测。',
    });
    const query =
      '请用历史查询工具查证以前 MOCK-CEDAR 那次任务：旧回答中的具体数值是什么，产生的文件名是什么？先搜索再分别读取旧回答原文和文件元数据。不要用记忆猜测，不读取文件正文、不生成文件，不用电脑或网页。';
    const found = await turn('alpha', 'mock-find-old', query);
    assert.notEqual(found.sessionId, old.sessionId);
    assert.match(found.result || '', /47/);
    assert.match(found.result || '', /mock-archive\.txt/);
    assert.ok(
      found.trace?.some((item) => item.name === 'bot_history_search' && item.phase === 'settled'),
    );
    assert.ok(
      (found.trace?.filter((item) => item.name === 'bot_history_read' && item.phase === 'settled')
        .length || 0) >= 2,
    );
    const replay = await models.start('alpha', {
      requestId: 'mock-original-archive',
      prompt: originalPrompt,
    });
    assert.equal(replay.runId, old.runId);
    assert.equal(models.jobs.get('alpha')!.id, found.runId);
    assert.equal((await stat(actualPath)).mtimeMs, before);
    evidence.oldRequestDeduplicated = true;
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const restored = await turn('alpha', 'mock-history-restart', query);
    assert.equal(restored.sessionId, found.sessionId);
    assert.match(restored.result || '', /mock-archive\.txt/);
    assert.ok(
      restored.trace?.some(
        (item) => item.name === 'bot_history_search' && item.phase === 'settled',
      ),
    );
    const denied = await turn(
      'beta',
      'mock-other-history',
      `请用历史读取工具读取运行 ${old.runId} 的回答。如果没有权限或找不到，就简短说明并结束，不要新建任务、不访问其他工具。`,
    );
    assert.ok(
      denied.trace?.some(
        (item) =>
          item.name === 'bot_history_read' &&
          item.phase === 'rejected' &&
          item.code === 'HISTORY_NOT_FOUND',
      ),
    );
    const greeting = await turn(
      'alpha',
      'mock-history-greeting',
      '你好，只需一句简短问候，不用任何工具。',
    );
    assert.equal(greeting.toolCount, 0);
    evidence.oldRunId = old.runId;
    evidence.sourceArtifact = file;
    evidence.restartContinuity = true;
    evidence.verified = true;
  } finally {
    if (models) evidence.finalModels = models.status();
    await models?.close().catch(() => {});
    await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptHistory(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      oldRequestDeduplicated: result.oldRequestDeduplicated,
      restartContinuity: result.restartContinuity,
    }),
  );
}
