import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepSeekModel, isModelKey } from '@daban/protocol';
import { errorCode } from './control.js';
import { type ModelRuns, sdkPatch } from './model.js';
import { startPrototype } from './server.js';

// Manual paid integration. The existing credential arrives over authenticated SSH stdin, never CLI arguments or a saved model configuration.
assert.equal(process.platform, 'linux');
const root = process.env.DABAN_AUTHORITY_MODEL_ROOT;
assert.ok(root);
assert.ok(root.startsWith('/var/lib/bot-prototype/verify-authority-'));
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output) && !output.startsWith(`${root}/`));
await mkdir(root, { mode: 0o700 });
let app: Awaited<ReturnType<typeof startPrototype>> | undefined;
let evidence: Record<string, unknown> = { verified: false, paidModelTaskTurns: 0 };
try {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    assert.ok(Buffer.byteLength(text) < 8192);
  }
  const source = JSON.parse(text) as { apiKey?: unknown; model?: unknown; revision?: unknown };
  assert.ok(isModelKey(source.apiKey));
  const model = source.model ?? 'deepseek-flash';
  assert.ok(isDeepSeekModel(model));
  const config = { apiKey: source.apiKey, model, revision: Number(source.revision || 0) };
  text = '';
  const prototype = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: { displayBase: 191 },
  });
  app = prototype;
  const models = prototype.models;
  assert.ok(models?.status().available);
  models.settings.privateConfig = async () => config;
  await models.profiles.register({
    id: 'mock-authority-agent',
    name: '合成 DSH 文件验收',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  await models.start('mock-authority-agent', {
    requestId: 'mock-authority-file-task',
    prompt:
      '这是合成文件验收。请通过 write_file 在当前任务目录创建 authority-check.json，内容恰为 {"marker":"SYNTHETIC-DSH-47","total":18}，然后通过 read_file 读回并核对。不要使用电脑、网页、命令或其他工具。完成后简短回复核对结果。',
  });
  evidence.paidModelTaskTurns = 1;
  const job = models.jobs.get('mock-authority-agent');
  assert.ok(job?.done);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      job.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MODEL_ACCEPTANCE_TIMEOUT')), 180000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(job.phase, 'completed');
  const result = JSON.parse(await readFile(path.join(job.workdir, 'authority-check.json'), 'utf8'));
  assert.deepEqual(result, { marker: 'SYNTHETIC-DSH-47', total: 18 });
  assert.ok(job.trace.some((item) => item.name === 'write_file'));
  assert.ok(job.trace.some((item) => item.name === 'read_file'));
  assert.equal(
    prototype.runtime.status().items.filter((item) => item.phase === 'connected').length,
    0,
  );
  assert.equal(
    await access(models.settings.file).then(
      () => true,
      () => false,
    ),
    false,
  );
  const firstSession = job.sessionId;
  assert.ok(firstSession);
  const patch = path.join(root, 'directory-control.patch.json');
  await writeFile(
    patch,
    JSON.stringify(
      sdkPatch(prototype.url, job.bot, 'synthetic-directory-control', undefined, 60, model).map(
        (row) =>
          'insert' in row
            ? { ...row, insert: row.insert.filter((item) => item.id !== 'computer-tools') }
            : row,
      ),
    ),
    { mode: 0o600 },
  );
  const { DeepSeekHarness } = (await import(
    pathToFileURL('/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')
      .href
  )) as { DeepSeekHarness: NonNullable<ConstructorParameters<typeof ModelRuns>[0]['Harness']> };
  const directoryControl = async (value?: string) => {
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patch],
      dshHome: path.join(models.dir, 'dsh', job.bot),
      processCwd: root,
      cwd: root,
      provider: 'deepseek-official',
      model,
      maxTokens: 8192,
      initializeTimeoutMs: 40000,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', DEEPSEEK_API_KEY: config.apiKey },
    });
    try {
      const session = await harness.resumeSession(firstSession);
      const control = session as typeof session & {
        getWorkingDirectory(): Promise<string>;
        setWorkingDirectory(directory: string): Promise<string>;
      };
      return value === undefined
        ? await control.getWorkingDirectory()
        : await control.setWorkingDirectory(value);
    } finally {
      await harness.close();
    }
  };
  // A durable public cwd reproduces the legacy session state without changing a real user conversation.
  assert.equal(await directoryControl(job.workdir), job.workdir);
  const previousFile = `/shared/${path.relative(path.join(root, 'desktops/shared'), job.workdir)}/authority-check.json`;
  evidence.paidModelTaskTurns = 2;
  await models.start(job.bot, {
    requestId: 'mock-authority-resume-task',
    prompt: `继续合成验收。通过 read_file 读取 ${previousFile}，再通过 write_file 在当前任务目录写 resumed-check.json，内容为 {"marker":"SYNTHETIC-DSH-47","total":18,"resumed":true}，并读回核对。不使用电脑、网页或命令。`,
  });
  const resumed = models.jobs.get(job.bot)!;
  assert.ok(resumed.done);
  try {
    await Promise.race([
      resumed.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MODEL_ACCEPTANCE_TIMEOUT')), 180000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(resumed.phase, 'completed');
  assert.equal(resumed.sessionId, firstSession);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(resumed.workdir, 'resumed-check.json'), 'utf8')),
    { marker: 'SYNTHETIC-DSH-47', total: 18, resumed: true },
  );
  assert.equal(await directoryControl(), resumed.privateDir);
  evidence = {
    verified: true,
    scope: 'Actual installed DSH and official DeepSeek, synthetic task only',
    paidModelTaskTurns: 2,
    resumedSameNativeSession: true,
    durablePublicDirectoryMigratedToPrivate: true,
    inferenceHttpRequestCountMeasured: false,
    model,
    toolNames: [job.trace.map((item) => item.name), resumed.trace.map((item) => item.name)],
    total: result.total,
    fileContentVerified: true,
    allocatedComputers: 0,
    taskAndPrivateDirectoriesDistinct: job.workdir !== job.privateDir,
    credentialConfigurationWritten: false,
    originalUserRuntimeOperated: false,
  };
} catch (error) {
  evidence.error = errorCode(error) || 'MODEL_ACCEPTANCE_FAILED';
  process.exitCode = 1;
} finally {
  try {
    await app?.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    evidence.temporaryRuntimeRemoved = await access(root).then(
      () => false,
      () => true,
    );
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
}
