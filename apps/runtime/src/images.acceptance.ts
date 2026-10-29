import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAttachmentReceipt, isModelKey } from '@daban/protocol';
import { Computers } from './computers.js';
import { startPrototype } from './server.js';

// Opt-in paid integration: native DSH, synthetic PNG/JPEG fixtures and an SSH-stdin credential only.
assert.equal(process.platform, 'linux');
const root = process.env.DABAN_IMAGES_ROOT;
assert.ok(
  root &&
    path.dirname(root) === '/var/lib/bot-prototype' &&
    path.basename(root).startsWith('verify-images-'),
);
const [output, png, jpeg] = process.argv.slice(2);
assert.ok(
  output &&
    path.dirname(output) === '/var/lib/bot-prototype/verify-results' &&
    /^images-model-[a-z0-9-]+\.json$/.test(path.basename(output)),
);
assert.ok(
  png &&
    jpeg &&
    [png, jpeg].every((file) => path.dirname(file) === '/var/lib/bot-prototype/verify-inputs'),
);
await mkdir(root, { mode: 0o700 });
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const options = {
  profileDir: path.join(root, 'profile'),
  port: 0,
  computers: { displayBase: 91, limit: 2 },
};
let app: Awaited<ReturnType<typeof startPrototype>> | undefined;
const evidence: Record<string, unknown> = {
  verified: false,
  syntheticOnly: true,
  paidTaskTurnsSubmitted: 0,
  protocol: 26,
};
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MODEL_ACCEPTANCE_TIMEOUT')), 240000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    assert.ok(Buffer.byteLength(raw) < 8192);
  }
  const credential = JSON.parse(raw) as { apiKey?: unknown; revision?: unknown };
  assert.ok(isModelKey(credential.apiKey));
  const config = {
    apiKey: credential.apiKey,
    model: 'deepseek-flash' as const,
    revision: Number(credential.revision || 0),
  };
  raw = '';
  app = await startPrototype(options);
  let models = app.models!;
  assert.ok(models.status().available);
  models.settings.privateConfig = async () => config;
  const bot = 'mock-image-acceptance';
  await models.profiles.register({
    id: bot,
    name: '合成图片验收',
    instructions: '',
    memory: '',
    color: 'mint',
    model: 'deepseek-flash',
  });
  const files: { name: string; attachmentId: string }[] = [];
  const originals: Buffer[] = [];
  for (const source of [png, jpeg]) {
    const bytes = await readFile(source);
    originals.push(bytes);
    const file = { name: path.basename(source), data: bytes.toString('base64') };
    const response: Response = await fetch(`${app.url}/api/attachments/upload`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ bot, file }),
    });
    assert.equal(response.status, 200);
    const receipt: unknown = await response.json();
    assert.ok(isAttachmentReceipt(receipt));
    assert.deepEqual((await models.attachments.source(bot, receipt.id)).file, file);
    files.push({ name: receipt.name, attachmentId: receipt.id });
  }
  const prompt =
    '这是两张合成测试图片。请直接观察随消息提供的两张图片，按图片顺序输出 JSON 数组；每项仅包含 colors（从左到右的三个色块，用英文颜色名）和 marker（下方四位字母数字标记）。不要读取参考文本、不要使用任何工具、不要猜测，不要输出 Markdown。';
  const expected = [
    { colors: ['blue', 'red', 'green'], marker: 'Q7M2' },
    { colors: ['green', 'blue', 'red'], marker: 'R8K5' },
  ];
  const turns = [];
  let previous: string | undefined, session: string | undefined;
  for (let turn = 0; turn < 2; turn++) {
    await models.start(bot, {
      requestId: `mock-image-turn-${turn}`,
      prompt,
      ...(previous ? { retryOf: previous } : { files }),
    });
    evidence.paidTaskTurnsSubmitted = turn + 1;
    const job = models.jobs.get(bot)!;
    await bounded(job.done!);
    evidence.lastPhase = job.phase;
    evidence.lastError = job.error;
    assert.equal(job.phase, 'completed');
    const parsed = JSON.parse(
      job.result
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    );
    assert.deepEqual(parsed, expected);
    assert.equal(job.toolCount, 0);
    for (const [index, file] of files.entries())
      assert.deepEqual(await readFile(path.join(job.workdir, file.name)), originals[index]);
    if (session) assert.equal(job.sessionId, session);
    session = job.sessionId;
    previous = job.id;
    turns.push({ phase: job.phase, toolCount: job.toolCount, observed: parsed });
    assert.ok(app.runtime instanceof Computers);
    assert.equal(app.runtime.status().items.filter((item) => item.reserved).length, 0);
    assert.equal(
      await access(models.settings.file).then(
        () => true,
        () => false,
      ),
      false,
    );
    if (turn === 0) {
      await writeFile(path.join(job.workdir, files[0].name), 'SYNTHETIC MODIFIED WORKSPACE COPY');
      await app.close();
      app = await startPrototype(options);
      models = app.models!;
      models.settings.privateConfig = async () => config;
    }
  }
  const profile = await models.profiles.get(bot);
  assert.ok(profile);
  await models.profiles.update(bot, profile.revision, {
    name: profile.name,
    instructions: profile.instructions,
    memory: profile.memory,
    color: profile.color,
    model: 'deepseek-v4-pro',
  });
  await assert.rejects(models.start(bot, { requestId: 'mock-image-pro-refusal', prompt, files }), {
    code: 'MODEL_IMAGE_UNSUPPORTED',
  });
  Object.assign(evidence, {
    verified: true,
    nativeDsh: true,
    officialDeepSeek: true,
    directPixelReading: true,
    formats: ['image/png', 'image/jpeg'],
    turns,
    zeroComputerAllocations: true,
    immutableRetryAfterReconstruction: true,
    sameNativeSession: true,
    textOnlyModelRefusedBeforeInference: true,
    credentialConfigurationWritten: false,
    inferenceHttpRequestCountMeasured: false,
  });
} catch (error) {
  evidence.failure =
    error instanceof assert.AssertionError
      ? 'ACCEPTANCE_ASSERTION_FAILED'
      : 'IMAGE_ACCEPTANCE_FAILED';
  process.exitCode = 1;
} finally {
  try {
    await app?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      verified: evidence.verified,
      paidTaskTurnsSubmitted: evidence.paidTaskTurnsSubmitted,
    }),
  );
}
