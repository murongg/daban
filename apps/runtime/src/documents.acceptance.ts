import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syntheticOffice, syntheticPdf } from './documents.fixture.js';
import { Documents } from './documents.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model acceptance; all documents and task content are synthetic.
export async function acceptDocuments(output = '/tmp/daban-documents-live.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-documents-live-'));
  const parser = new Documents();
  let models: ModelRuns | undefined;
  const evidence: Record<string, unknown> = {
    verified: false,
    synthetic: true,
    computerAttached: false,
  };
  const server = createServer(async (request, response) => {
    try {
      assert.ok(models && request.method === 'POST' && request.url === '/mcp/alpha');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 512 * 1024) throw new Error('body too large');
        chunks.push(Buffer.from(chunk));
      }
      const result = await models.rpc(
        'alpha',
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
    models = new ModelRuns({
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    });
    await models.ready;
    await models.profiles.register({
      id: 'alpha',
      name: '合成文档验收',
      instructions: '使用简洁中文回答。',
      memory: '',
      color: 'mint',
    });
    const documents = [];
    for (const format of ['pdf', 'docx', 'xlsx', 'pptx'] as const) {
      const data = format === 'pdf' ? syntheticPdf('MOCK-PDF-47') : syntheticOffice(format);
      const file = { name: `synthetic.${format}`, data: data.toString('base64') };
      const content = await parser.extract(file);
      const document = await models.knowledge.importDocument('alpha', file, content);
      assert.deepEqual((await models.knowledge.source('alpha', document.id)).file, file);
      await assert.rejects(models.knowledge.source('beta', document.id), {
        code: 'KNOWLEDGE_NOT_FOUND',
      });
      documents.push(document);
    }
    evidence.documents = documents;
    await models.start('alpha', {
      requestId: 'mock-document-formats',
      prompt:
        '请在我的长期资料库里查找 synthetic.pdf、synthetic.docx、synthetic.xlsx、synthetic.pptx 的提取文本，逐份实际调用读取工具核对正文。然后逐项列出：PDF 标记；Word 标记和中文文字；Excel 两张表的标记与公式缓存值（不要重新计算）；PPT 的正文标记和备注标记。只根据读到的内容回答，保留标记原样；不操作电脑、不访问网页、不生成文件。',
    });
    const deadline = Date.now() + 120000;
    while (models.running('alpha')) {
      if (Date.now() > deadline) throw new Error('document task timed out');
      assert.equal(
        (await models.interactions.list()).some((item) => item.status === 'pending'),
        false,
      );
      await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
    }
    await models.jobs.get('alpha')!.done;
    const task = models.status().bots.alpha;
    evidence.task = task;
    assert.equal(task.phase, 'completed', task.error || 'document task failed');
    for (const marker of [
      'MOCK-PDF-47',
      'MOCK-DOCX-47',
      '合成中文',
      'MOCK-XLSX-ALPHA-47',
      'MOCK-XLSX-HIDDEN-53',
      '100',
      'MOCK-PPTX-47',
      'MOCK-PPTX-NOTES-53',
    ])
      assert.ok(task.result?.includes(marker), `missing ${marker}`);
    assert.ok(
      (task.trace?.filter((item) => item.name === 'bot_knowledge_read' && item.phase === 'settled')
        .length || 0) >= 4,
    );
    assert.equal(
      task.trace?.some((item) => item.surface !== 'knowledge'),
      false,
    );
    assert.equal(task.files.length, 0);
    evidence.verified = true;
    return evidence;
  } finally {
    await models?.close();
    await parser.close();
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptDocuments(process.argv[2]);
  console.log(JSON.stringify({ verified: result.verified, computerAttached: false }));
}
