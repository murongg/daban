import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeFile, TaskRequest } from '@daban/protocol';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model check; all inputs and generated business records are synthetic.
export async function acceptFiles(output = '/tmp/daban-files-live.json') {
  assert.equal(process.platform, 'linux');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-files-acceptance-'));
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = { verified: false, computerAttached: false };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    const bot = request.url?.match(/^\/mcp\/(alpha|beta)$/)?.[1];
    try {
      assert.ok(models && ['alpha', 'beta'].includes(bot || ''));
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) throw new Error('body too large');
        chunks.push(Buffer.from(chunk));
      }
      const result = await models.rpc(
        bot!,
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
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const options = {
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace,
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    };
    models = new ModelRuns(options);
    async function turn(bot: string, task: TaskRequest) {
      assert.ok(models);
      await models.start(bot, task);
      const began = Date.now();
      while (models.running(bot)) {
        if (Date.now() - began > 120000) throw new Error('file task timed out');
        assert.equal(
          (await models.interactions.list()).filter((item) => item.status === 'pending').length,
          0,
        );
        await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
      }
      await models.jobs.get(bot)!.done;
      const result = models.status().bots[bot];
      evidence[task.requestId] = result;
      assert.equal(result.phase, 'completed', result.error || 'file task did not complete');
      assert.equal(
        result.trace?.some((item) => ['browser', 'desktop'].includes(item.surface)),
        false,
      );
      return result;
    }
    const input = 'item,amount\nMOCK-A,12\nMOCK-B,18\nMOCK-C,7\n';
    const first = await turn('alpha', {
      requestId: 'mock-create-source',
      prompt: `请实际使用 write_file 创建 mock-source.csv，内容原样如下：\n${input}\n这是明确要求创建的合成测试数据。只创建这个文件，不用电脑或网页，完成后简洁回复。`,
    });
    const source = first.files.find((file: RuntimeFile) => file.name === 'mock-source.csv');
    assert.ok(source);
    const sourcePath = path.join(workspace, source.path);
    const original = await readFile(sourcePath, 'utf8');
    assert.equal(original.trimEnd(), input.trimEnd());
    const digest = createHash('sha256').update(original).digest('hex');
    const second = await turn('beta', {
      requestId: 'mock-cross-bot-compute',
      prompt: `请使用 shell 和 Python 实际读取共享文件 /shared/${source.path}，计算全部 amount 合计、amount 大于等于 10 的合计、行数。把 JSON 对象保存为本轮 /workspace/mock-summary.json，字段只能是 total、filtered、count，值是数字。不要更改原文件，不要打开电脑或浏览器，不要口算代替实际执行。`,
    });
    assert.ok(second.trace?.some((item) => item.name === 'shell' && item.phase === 'settled'));
    const summary = second.files.find((file: RuntimeFile) => file.name === 'mock-summary.json');
    assert.ok(summary);
    const totals = JSON.parse(await readFile(path.join(workspace, summary.path), 'utf8'));
    assert.deepEqual(totals, { total: 37, filtered: 30, count: 3 });
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const third = await turn('alpha', {
      requestId: 'mock-reuse-after-restart',
      prompt:
        '请继续使用我上一轮要求你生成的 mock-source.csv，不要创建或重新上传输入。用 shell 和 Python 实际读取 /shared 中的原文件，计算 amount 总和乘以 2，把数值写进本轮 mock-followup.txt。原文件保持不变，不用电脑或网页。',
    });
    assert.equal(third.sessionId, first.sessionId);
    assert.ok(third.trace?.some((item) => item.name === 'shell' && item.phase === 'settled'));
    const followup = third.files.find((file: RuntimeFile) => file.name === 'mock-followup.txt');
    assert.ok(followup);
    assert.equal((await readFile(path.join(workspace, followup.path), 'utf8')).trim(), '74');
    assert.equal(
      createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex'),
      digest,
    );
    evidence.source = { path: source.path, sha256: digest, unchanged: true };
    evidence.totals = totals;
    evidence.restartContinuity = true;
    evidence.verified = true;
  } finally {
    if (models) evidence.lastStatus = models.status();
    await models?.close().catch(() => {});
    await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptFiles(process.argv[2]);
  console.log(
    JSON.stringify({ verified: result.verified, totals: result.totals, source: result.source }),
  );
}
