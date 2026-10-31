import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import type { RawModelTask } from './snapshot.js';

// Manual paid-model acceptance with synthetic preferences only; no real profile is loaded.
export async function acceptMemory(output = '/tmp/daban-memory-live.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-memory-acceptance-'));
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = { verified: false, computerAttached: false };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const bot = request.url?.match(/^\/mcp\/(alpha|beta)$/)?.[1];
      assert.ok(bot && models);
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) throw new Error('body too large');
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
    const base = '输出尽量简洁。';
    await models.profiles.register({
      id: 'alpha',
      name: '合成记忆助手甲',
      instructions: '简洁中文回答。',
      memory: base,
      color: 'mint',
    });
    const beta = await models.profiles.register({
      id: 'beta',
      name: '合成记忆助手乙',
      instructions: '简洁中文回答。',
      memory: '合成偏好：代号 MOCK-BETA，仅用要点。',
      color: 'violet',
    });
    async function turn(bot: string, requestId: string, prompt: string): Promise<RawModelTask> {
      assert.ok(models);
      await models.start(bot, { requestId, prompt });
      const deadline = Date.now() + 120000;
      while (models.running(bot)) {
        if (Date.now() > deadline) throw new Error('memory task timed out');
        assert.equal(
          (await models.interactions.list()).some((item) => item.status === 'pending'),
          false,
        );
        await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
      }
      await models.jobs.get(bot)!.done;
      const task: RawModelTask = models.status().bots[bot];
      evidence[requestId] = task;
      assert.equal(task.phase, 'completed', task.error || 'memory task did not complete');
      assert.equal(task.files.length, 0);
      if (requestId !== 'mock-memory-greeting')
        assert.ok(
          task.trace?.some((item) => item.name === 'bot_memory_read' && item.phase === 'settled'),
        );
      assert.equal(
        task.trace?.some((item) =>
          ['desktop', 'browser', 'workspace', 'web'].includes(item.surface),
        ),
        false,
      );
      return task;
    }
    const first = await turn(
      'alpha',
      'mock-remember',
      '请长期记住这个合成工作偏好：我的项目代号是 MOCK-ORION。原有偏好逐字保留。通过记忆工具保存后再次调用读取工具确认，不生成文件、不用电脑或网页。',
    );
    assert.ok(
      first.trace?.some((item) => item.name === 'bot_memory_write' && item.phase === 'settled'),
    );
    const saved = await models.profiles.get('alpha');
    assert.ok(saved);
    assert.ok(saved.memory.includes('MOCK-ORION'));
    assert.ok(saved.memory.includes(base));
    evidence.saved = saved;
    const read = await turn(
      'alpha',
      'mock-read-memory',
      '请用记忆读取工具核对，现在保存了哪些工作偏好？不要只依据聊天历史。',
    );
    assert.match(read.result || '', /MOCK-ORION/);
    assert.equal(read.sessionId, first.sessionId);
    await turn(
      'alpha',
      'mock-forget-one',
      '只忘掉已保存的合成项目代号 MOCK-ORION 这一项，原有“输出尽量简洁。”逐字保留。请保存后通过读取工具确认。不需要删除聊天记录，不要生成文件或打开电脑。',
    );
    const partial = await models.profiles.get('alpha');
    assert.ok(partial);
    assert.ok(partial.memory.includes(base));
    assert.equal(partial.memory.includes('MOCK-ORION'), false);
    evidence.partialForget = partial;
    assert.deepEqual(await models.profiles.get('beta'), beta);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const restarted = await turn(
      'alpha',
      'mock-restart-read',
      '请实际读取现在持久保存的工作偏好，只报告当前存在的内容，不要把历史中已移除的条目补回来。',
    );
    assert.equal(restarted.sessionId, first.sessionId);
    assert.equal((restarted.result || '').includes('MOCK-ORION'), false);
    assert.ok((await models.profiles.get('alpha'))!.memory.includes(base));
    const other = await turn(
      'beta',
      'mock-other-memory',
      '请使用记忆工具读取你当前保存的工作偏好，不要读取或推测其他 Bot 的内容。',
    );
    assert.match(other.result || '', /MOCK-BETA/);
    assert.equal((other.result || '').includes('MOCK-ORION'), false);
    await turn(
      'alpha',
      'mock-forget-all',
      '请清空当前保存的全部工作偏好，保存后再用读取工具核对。不删除历史聊天记录，不使用文件、电脑或网页。',
    );
    assert.equal((await models.profiles.get('alpha'))!.memory, '');
    const empty = await turn(
      'alpha',
      'mock-empty-read',
      '请用工具核对当前保存的工作偏好；如果为空，只回答“当前没有保存的工作偏好”。不要从聊天历史恢复旧条目。',
    );
    assert.match(empty.result || '', /当前没有保存的工作偏好/);
    assert.equal((await models.profiles.get('alpha'))!.memory, '');
    const greeting = await turn(
      'alpha',
      'mock-memory-greeting',
      '你好，只需要一句简短问候，不用任何工具或文件。',
    );
    assert.equal(greeting.toolCount, 0);
    evidence.sameSessionAfterRestart = true;
    evidence.otherBotUnchanged = true;
    assert.deepEqual(await models.profiles.get('beta'), beta);
    evidence.verified = true;
  } finally {
    if (models) {
      evidence.finalProfiles = await models.profiles.list();
      evidence.finalModels = models.status();
    }
    await models?.close().catch(() => {});
    await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptMemory(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      sameSessionAfterRestart: result.sameSessionAfterRestart,
    }),
  );
}
