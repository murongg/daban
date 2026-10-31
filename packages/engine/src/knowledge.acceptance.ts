import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import type { RawModelTask } from './snapshot.js';

// Manual paid-model check; all source documents and tasks are synthetic and temporary.
export async function acceptKnowledge(output = '/tmp/daban-knowledge-live.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-knowledge-acceptance-'));
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = { verified: false, computerAttached: false };
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
    for (const bot of ['alpha', 'beta'])
      await models.profiles.register({
        id: bot,
        name: `合成资料助手 ${bot}`,
        instructions: '简洁中文回答。',
        memory: '',
        color: 'mint',
      });
    const source = '项目代号 MOCK-CEDAR\n报价上限=47\n保留段落 ALPHA-KEEP\n';
    const document = await models.knowledge.write('alpha', {
      path: '报价规范.md',
      revision: 0,
      content: source,
    });
    evidence.imported = document;
    async function turn(
      bot: string,
      requestId: string,
      prompt: string,
      workspaceAllowed = false,
    ): Promise<RawModelTask> {
      assert.ok(models);
      await models.start(bot, { requestId, prompt });
      const deadline = Date.now() + 120000;
      while (models.running(bot)) {
        if (Date.now() > deadline) throw new Error('knowledge task timed out');
        assert.equal(
          (await models.interactions.list()).some((item) => item.status === 'pending'),
          false,
        );
        await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
      }
      await models.jobs.get(bot)!.done;
      const task: RawModelTask = models.status().bots[bot];
      evidence[requestId] = task;
      assert.equal(task.phase, 'completed', task.error || 'knowledge task failed');
      assert.equal(
        task.trace?.some((item) => ['desktop', 'browser', 'web'].includes(item.surface)),
        false,
      );
      if (!workspaceAllowed) {
        assert.equal(task.files.length, 0);
        assert.equal(
          task.trace?.some((item) => item.surface === 'workspace'),
          false,
        );
      }
      return task;
    }
    const first = await turn(
      'alpha',
      'mock-kb-read',
      '请在我的长期资料库里搜索报价规范，读取实际正文后回答报价上限是多少。不依赖聊天猜测，不用电脑或网页。',
    );
    assert.match(first.result || '', /47/);
    assert.ok(
      first.trace?.some((item) => item.name === 'bot_knowledge_read' && item.phase === 'settled'),
    );
    await turn(
      'alpha',
      'mock-kb-edit',
      '把刚读到的报价规范中的上限 47 精确改成 53，其他内容逐字保留。使用精确片段编辑并重新读取确认，不改文件名、不生成副本。',
    );
    const edited = await models.knowledge.read('alpha', document.id);
    assert.equal(edited.content, source.replace('47', '53'));
    const computed = await turn(
      'alpha',
      'mock-kb-export',
      '请导出这份报价规范的当前版本为本轮工作区的 policy.txt（导出工具 target 用相对文件名 policy.txt）。再用 shell 和 Python 实际读取副本中的报价上限，乘以 2，把纯数字写入 result.txt。不要更改资料库原文，不用电脑或网页。',
      true,
    );
    const copy = computed.files.find((item) => item.name === 'policy.txt'),
      result = computed.files.find((item) => item.name === 'result.txt');
    assert.ok(copy && result);
    const copyPath = path.join(root, 'workspace', copy.path);
    assert.equal(await readFile(copyPath, 'utf8'), edited.content);
    assert.equal((await readFile(path.join(root, 'workspace', result.path), 'utf8')).trim(), '106');
    assert.equal((await models.knowledge.read('alpha', document.id)).content, edited.content);
    await turn(
      'alpha',
      'mock-kb-delete',
      '请把报价规范移入资料库回收站，保留版本历史。操作后实际查询确认，不生成文件。',
    );
    assert.equal((await models.knowledge.read('alpha', document.id)).deleted, true);
    await turn(
      'alpha',
      'mock-kb-restore',
      '请在回收站和版本历史中找到报价规范，恢复它的最初版本为新版本。读取确认报价上限回到原值；保留后续历史和之前导出的副本不变。',
    );
    const restored = await models.knowledge.read('alpha', document.id);
    assert.equal(restored.content, source);
    assert.ok(restored.revision > edited.revision);
    assert.equal((await models.knowledge.versions('alpha', document.id)).length, 4);
    assert.equal(await readFile(copyPath, 'utf8'), edited.content);
    evidence.restored = restored;
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const restarted = await turn(
      'alpha',
      'mock-kb-restart',
      '请通过资料库工具重新查证当前报价规范的报价上限，只依据实际保存正文回答，不从历史猜测。',
    );
    assert.match(restarted.result || '', /47/);
    assert.equal(restarted.sessionId, first.sessionId);
    const other = await turn(
      'beta',
      'mock-kb-other',
      `请读取资料 ${document.id}。如果没有访问权限或找不到，就说明并结束，不另建资料，不使用其他工具。`,
    );
    assert.ok(
      other.trace?.some(
        (item) =>
          item.name === 'bot_knowledge_read' &&
          item.phase === 'rejected' &&
          item.code === 'KNOWLEDGE_NOT_FOUND',
      ),
    );
    assert.equal((await models.knowledge.list('beta')).length, 0);
    const greeting = await turn(
      'alpha',
      'mock-kb-greeting',
      '你好，只需一句简短问候，不需要任何工具或文件。',
    );
    assert.equal(greeting.toolCount, 0);
    evidence.sameSessionAfterRestart = true;
    evidence.verified = true;
  } finally {
    if (models) {
      evidence.finalDocuments = await models.knowledge.list('alpha', true);
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
  const result = await acceptKnowledge(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      sameSessionAfterRestart: result.sameSessionAfterRestart,
    }),
  );
}
