import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskFile } from '@daban/protocol';
import { syntheticOffice, syntheticPdf } from './documents.fixture.js';
import { Documents } from './documents.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid-model acceptance with synthetic input only; it never writes the adopted runtime's tasks.
export async function acceptAttachments(output = '/tmp/daban-attachments-live.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-attachments-live-'));
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
      name: '合成附件验收',
      instructions: '使用简洁中文回答。',
      memory: '',
      color: 'mint',
    });
    const files: TaskFile[] = [];
    const originals = new Map<string, Buffer>();
    for (const format of ['pdf', 'docx', 'xlsx', 'pptx'] as const) {
      const bytes = format === 'pdf' ? syntheticPdf('MOCK-PDF-47') : syntheticOffice(format);
      const file = { name: `synthetic.${format}`, data: bytes.toString('base64') };
      const receipt = await models.attachments.upload('alpha', file, (input, signal) =>
        parser.extract(input, signal),
      );
      files.push({ name: file.name, attachmentId: receipt.id });
      originals.set(file.name, bytes);
      assert.deepEqual((await models.attachments.source('alpha', receipt.id)).file, file);
    }
    const retained = (await models.attachments.list('alpha', {})).items[0];
    const trashed = await models.attachmentAction('alpha', {
      id: retained.id,
      version: retained.version,
      action: 'trash',
    });
    await models.attachmentAction('alpha', {
      id: retained.id,
      version: trashed.version,
      action: 'restore',
    });
    evidence.restoredBeforeRun = true;
    const request = {
      requestId: 'mock-direct-attachments',
      files,
      prompt:
        '请实际读取四份附件的提取文本，不要打开电脑或网页，也不要保存长期资料。写 result.json，字段严格为 pdfMarker（PDF 标记）、wordMarker（Word 标记）、wordChinese（Word 中文原文）、excelMarkers（两个单元格正文中以 MOCK-XLSX- 开头的完整标记字符串数组，包含隐藏表；不是工作表名称）、formulaCacheSum（用 shell 和 Python 从 Excel 提取文本实际读取两个公式缓存值并求和，不重新计算公式）、pptBody（PPT 正文标记）、pptNotes（PPT 备注标记）。所有标记保留原样，数据必须来自附件。完成后简短说明。',
    };
    const first = await models.start('alpha', request);
    await assert.rejects(
      models.attachmentAction('alpha', {
        id: retained.id,
        version: retained.version,
        action: 'trash',
      }),
      { code: 'ATTACHMENT_BUSY' },
    );
    assert.equal((await models.start('alpha', request)).runId, first.runId);
    const deadline = Date.now() + 120000;
    while (models.running('alpha')) {
      if (Date.now() > deadline) throw new Error('attachment task timed out');
      assert.equal(
        (await models.interactions.list()).some((item) => item.status === 'pending'),
        false,
      );
      await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
    }
    const job = models.jobs.get('alpha')!;
    await job.done;
    const task = models.status().bots.alpha;
    evidence.task = task;
    evidence.documentInputs = job.documentInputs;
    assert.equal(task.phase, 'completed', task.error || 'attachment task failed');
    const result = JSON.parse(await readFile(path.join(job.workdir, 'result.json'), 'utf8'));
    evidence.result = result;
    assert.equal(result.pdfMarker, 'MOCK-PDF-47');
    assert.equal(result.wordMarker, 'MOCK-DOCX-47');
    assert.equal(result.wordChinese, '合成中文');
    assert.deepEqual(
      new Set(result.excelMarkers),
      new Set(['MOCK-XLSX-ALPHA-47', 'MOCK-XLSX-HIDDEN-53']),
    );
    assert.equal(result.formulaCacheSum, 200);
    assert.equal(result.pptBody, 'MOCK-PPTX-47');
    assert.equal(result.pptNotes, 'MOCK-PPTX-NOTES-53');
    assert.equal(
      task.trace?.some((item) => item.surface !== 'workspace'),
      false,
    );
    assert.ok(task.trace?.some((item) => item.name === 'shell' && item.phase === 'settled'));
    assert.equal((await models.knowledge.list('alpha')).length, 0);
    for (const [name, original] of originals)
      assert.equal((await readFile(path.join(job.workdir, name))).equals(original), true);
    assert.ok(task.files.some((file) => file.name === 'result.json'));
    assert.equal(
      task.files.some((file) => job.inputs.includes(file.name)),
      false,
    );
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
  const result = await acceptAttachments(process.argv[2]);
  console.log(JSON.stringify({ verified: result.verified, computerAttached: false }));
}
