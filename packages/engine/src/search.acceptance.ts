import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Interaction } from '@daban/protocol';
import { ModelRuns } from './model.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';

// Manual paid-model check against public documentation, separate from synthetic unit tests.
export async function acceptSearch(options: {
  modelFile: string;
  searchFile: string;
  sdkFile: string;
  output: string;
}) {
  if (
    !options ||
    [options.modelFile, options.searchFile, options.sdkFile, options.output].some(
      (file) => typeof file !== 'string' || !path.isAbsolute(file),
    )
  )
    throw new Error(
      'Explicit absolute model, search, SDK and output paths are required for paid acceptance',
    );
  assert.equal(process.platform, 'linux');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-search-acceptance-'));
  const evidenceFile = await open(options.output, 'wx', 0o600);
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = { verified: false, computerAttached: false };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) throw new Error('body too large');
        chunks.push(Buffer.from(chunk));
      }
      assert.ok(models);
      const result = await models.rpc(
        'probe',
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
    const settings = new ModelSettings(options.modelFile);
    models = new ModelRuns({
      settings,
      search: new SearchSettings(options.searchFile, settings),
      sdkFile: options.sdkFile,
      workspace,
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    });
    await models.start('probe', {
      requestId: 'mock-official-search',
      prompt:
        '联网验收：请实际搜索 DeepSeek 官方 Search API 文档，读取搜索结果中的官方原文页面，然后用中文简洁回答：搜索接口路径是什么、query 长度上限是多少。附原始来源链接。不要改写搜索返回的网址，不需要文件或电脑，不要用记忆代替本轮查询。',
    });
    const began = Date.now();
    while (models.running('probe')) {
      if (Date.now() - began > 120000) throw new Error('search task timed out');
      const pending: Interaction[] = (await models.interactions.list()).filter(
        (item) => item.status === 'pending',
      );
      assert.equal(
        pending.length,
        0,
        'exact search-result reads should not require another confirmation',
      );
      await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
    }
    await models.jobs.get('probe')!.done;
    const result = models.status().bots.probe;
    evidence.search = result;
    assert.equal(result.phase, 'completed', result.error || 'search task did not complete');
    assert.ok(result.trace?.some((item) => item.name === 'web_search' && item.phase === 'settled'));
    assert.ok(result.trace?.some((item) => item.name === 'web_fetch' && item.phase === 'settled'));
    assert.match(result.result || '', /\/v1\/tools\/search/);
    assert.match(result.result || '', /128/);
    assert.match(result.result || '', /https:\/\/api-docs\.deepseek\.com/);
    assert.equal(result.files.length, 0);
    assert.equal(
      result.trace?.some((item) => ['browser', 'desktop'].includes(item.surface)),
      false,
    );
    await models.start('probe', {
      requestId: 'mock-search-greeting',
      prompt: '你好，现在只用一句话问候，不需要继续检索，不用工具或文件。',
    });
    await models.jobs.get('probe')!.done;
    const greeting = models.status().bots.probe;
    assert.equal(greeting.phase, 'completed', greeting.error || 'greeting did not complete');
    assert.equal(greeting.toolCount, 0);
    evidence.greeting = {
      phase: greeting.phase,
      toolCount: greeting.toolCount,
      result: greeting.result,
    };
    evidence.verified = true;
  } finally {
    if (models) {
      evidence.lastStatus = models.status().bots.probe;
      evidence.requests = await models.interactions.list();
    }
    try {
      await evidenceFile.writeFile(JSON.stringify(evidence, null, 2));
    } finally {
      await evidenceFile.close();
      await models?.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
      await rm(directory, { recursive: true, force: true });
    }
  }
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [modelFile, searchFile, sdkFile, output] = process.argv.slice(2);
  const result = await acceptSearch({ modelFile, searchFile, sdkFile, output });
  console.log(JSON.stringify({ verified: result.verified, greeting: result.greeting }));
}
