import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { syntheticAnimatedWebp, syntheticGif, syntheticLossyWebp } from './images.fixture.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Paid integration uses only synthetic pixels and reads the existing key inside its original VM.
assert.equal(process.platform, 'linux');
assert.equal(process.getuid?.(), 999);
const root = process.env.DABAN_FORMAT_MODEL_ROOT;
assert.ok(
  root &&
    path.dirname(root) === '/var/lib/bot-prototype' &&
    path.basename(root).startsWith('verify-formats-model-'),
);
assert.equal(await realpath(root), root);
assert.equal((await lstat(root)).uid, 999);
const state = path.join(root, 'state');
await mkdir(state, { mode: 0o700 });
const credentialFile = '/var/lib/bot-prototype/model/credentials.json';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const before = digest(await readFile(credentialFile));
const settings = new ModelSettings(credentialFile);
const config = await settings.privateConfig();
assert.ok(config);
const bot = 'mock-raster-format';
let models: ModelRuns | undefined;
let verified = false,
  stage = 'setup',
  paidTaskStarts = 0;
let phase = '';
const turns: { runId: string; sessionId: string; colors: string[]; toolCount: number }[] = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, `/mcp/${bot}`);
    assert.equal(request.method, 'POST');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 65536);
      chunks.push(Buffer.from(chunk));
    }
    assert.ok(models);
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
async function keyAbsent(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!(await keyAbsent(file))) return false;
    } else if (entry.isFile()) {
      let tail = Buffer.alloc(0);
      for await (const chunk of createReadStream(file)) {
        const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
        if (bytes.includes(Buffer.from(config!.apiKey))) return false;
        tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - config!.apiKey.length + 1)));
      }
    }
  }
  return true;
}
let keyNotPersisted = false,
  existingSettingsUnchanged = false;
try {
  await new Promise<undefined>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const options = {
    settings,
    workspace: path.join(state, 'workspace'),
    dir: path.join(state, 'model'),
    origin: `http://127.0.0.1:${address.port}`,
  };
  models = new ModelRuns(options);
  await models.ready;
  await models.profiles.register({
    id: bot,
    name: '合成图片格式验证',
    instructions: '这是合成图片验收。只观察随附图片，不调用工具，只输出要求的 JSON。',
    memory: '',
    model: 'deepseek-flash',
    color: 'mint',
  });
  const sources = [syntheticGif, syntheticAnimatedWebp, syntheticLossyWebp];
  const files = [];
  for (const file of sources) {
    const receipt = await models.attachments.upload(bot, file, async () =>
      assert.fail('raster must not invoke document extraction'),
    );
    assert.deepEqual((await models.attachments.source(bot, receipt.id)).file, file);
    files.push({ name: file.name, attachmentId: receipt.id });
  }
  const prompt =
    '随消息附有三张合成测试图片，每张都是一个单色矩形。请直接观察模型收到的静态图片，按顺序输出颜色名称的 JSON 数组，只能使用小写英文颜色名。不使用工具、不读取文件、不参考文件名或说明猜测，不输出 Markdown。';
  let previous: string | undefined;
  for (let turn = 0; turn < 2; turn++) {
    stage = turn ? 'reconstructed-retry' : 'first-images';
    await models.start(bot, {
      requestId: `mock-format-${turn}`,
      prompt,
      ...(previous ? { retryOf: previous } : { files }),
    });
    paidTaskStarts++;
    const job: ReturnType<ModelRuns['jobs']['get']> = models.jobs.get(bot);
    assert.ok(job);
    await writeFile(
      path.join(root, 'progress.json'),
      JSON.stringify({ stage, paidTaskStarts, runId: job.id }),
      { mode: 0o600 },
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.done,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('FORMAT_MODEL_TIMEOUT')), 240000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    phase = job.phase;
    assert.equal(job.phase, 'completed');
    assert.equal(job.model, 'deepseek-flash');
    assert.equal(job.toolCount, 0);
    const colors: unknown = JSON.parse(
      job.result.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'),
    );
    assert.deepEqual(colors, ['red', 'red', 'blue']);
    assert.ok(job.sessionId);
    if (turn) assert.equal(job.sessionId, turns[0].sessionId);
    turns.push({
      runId: job.id,
      sessionId: job.sessionId,
      colors: colors as string[],
      toolCount: job.toolCount,
    });
    for (const [index, file] of files.entries())
      assert.deepEqual(
        await readFile(path.join(job.workdir, file.name)),
        Buffer.from(sources[index].data, 'base64'),
      );
    previous = job.id;
    if (!turn) {
      // Retry must resolve immutable originals rather than this deliberately changed working copy.
      await writeFile(path.join(job.workdir, files[0].name), 'SYNTHETIC CHANGED WORKING COPY');
      await models.close();
      models = new ModelRuns(options);
      await models.ready;
    }
  }
  assert.equal(
    await access(path.join(state, 'model/credentials.json')).then(
      () => true,
      () => false,
    ),
    false,
  );
  verified = true;
  stage = 'complete';
} catch {
  // Export fixed labels only; provider exceptions must never expose a credential in host evidence.
  process.exitCode = 1;
} finally {
  await models?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<undefined>((resolve) => server.close(() => resolve(undefined)));
  existingSettingsUnchanged = digest(await readFile(credentialFile)) === before;
  keyNotPersisted = await keyAbsent(root);
  if (!existingSettingsUnchanged || !keyNotPersisted) {
    verified = false;
    process.exitCode = 1;
  }
  const evidence = {
    verified,
    stage,
    phase,
    paidTaskStarts,
    nativeSdk: true,
    harnessMocked: false,
    syntheticDataOnly: true,
    model: 'deepseek-flash',
    turns,
    originalsRetained: verified,
    reconstructionRetry: verified,
    originalCredentialFileUnchanged: existingSettingsUnchanged,
    keyBytesAbsentFromOwnedRoot: keyNotPersisted,
    originalServiceUpgraded: false,
  };
  await writeFile(path.join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(evidence));
}
