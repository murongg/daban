import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isModelKey, modelHasVision } from '@daban/protocol';
import { errorCode } from './control.js';
import { startPrototype } from './server.js';

// Opt-in paid verification: normal native DSH/MCP, real Linux screens and synthetic data only.
assert.equal(process.platform, 'linux');
const root = process.env.DABAN_VISION_ROOT;
assert.ok(root);
assert.ok(root.startsWith('/var/lib/bot-prototype/verify-vision-'));
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output) && !output.startsWith(`${root}/`));
await mkdir(root, { mode: 0o700 });
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
let app: Awaited<ReturnType<typeof startPrototype>> | undefined;
let diagnostics: (() => Promise<unknown>) | undefined;
const evidence: Record<string, unknown> = {
  verified: false,
  syntheticOnly: true,
  paidTaskTurnsSubmitted: 0,
  stage: 'credential',
};
async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 240000);
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
  const source = JSON.parse(raw) as { apiKey?: unknown; revision?: unknown };
  assert.ok(isModelKey(source.apiKey));
  const config = {
    apiKey: source.apiKey,
    model: 'deepseek-flash' as const,
    revision: Number(source.revision || 0),
  };
  raw = '';
  assert.equal(modelHasVision(config.model), true);
  const prototype = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: { displayBase: 81, limit: 2 },
  });
  app = prototype;
  assert.ok(prototype.models?.status().available);
  const models = prototype.models,
    computers = prototype.runtime;
  models.settings.privateConfig = async () => config;
  const bots = ['mock-vision-a', 'mock-vision-b'] as const;
  for (const bot of bots)
    await models.profiles.register({
      id: bot,
      name: `合成视觉 ${bot}`,
      instructions: '',
      memory: '',
      color: 'mint',
      model: config.model,
    });
  const connections = await Promise.all(
    bots.map((bot) =>
      computers.operate({ id: `mock-connect-${bot}`, bot, action: 'connect', revision: 0 }),
    ),
  );
  for (const connected of connections) assert.equal(connected.state.phase, 'connected');
  assert.notEqual(connections[0].state.instance, connections[1].state.instance);
  const browser = computers.browserFor(bots[0]);
  for (const bot of bots)
    await browser.tabs!.navigate(
      bot,
      'agent',
      computers.control.state(bot).epoch,
      `${prototype.url}/fixture/page?bot=${bot}`,
      new AbortController().signal,
      `mock-fixture-${bot}`,
    );
  await browser.act(bots[0], 'agent', computers.control.state(bots[0]).epoch, (page) =>
    page.locator('#login').click(),
  );
  await browser
    .page(bots[1])
    .waitForFunction(() => document.querySelector('#identity')?.textContent === '示例用户');
  await browser.page(bots[1]).locator('#note').fill('SYNTHETIC-B-NOTE-UNCHANGED');
  await computers.transfer(
    bots[0],
    computers.control.state(bots[0]).epoch,
    'human',
    connections[0].state.instance,
  );
  evidence.stage = 'concurrent-models';
  const markers = ['VISION-A-47', 'VISION-B-53'];
  const originalFiles: string[] = [];
  evidence.paidTaskTurnsSubmitted = 2;
  await Promise.all(
    bots.map((bot, index) =>
      models.start(bot, {
        requestId: `mock-vision-task-${index}`,
        prompt: `这是授权的合成 Linux 图形操作验收。只允许 screenshot、open_app 和 act，不调用文件、命令或浏览器 DOM 工具。先 screenshot(surface=desktop)，再 open_app(app=terminal) 聚焦终端；通过 act(surface=desktop) 发送 ctrl+c、ctrl+u，再在终端用 printf 将 ${markers[index]} 写入本轮任务目录内的 vision-${index}.txt，并发送 Return。文件是这一行标记，末尾可以有换行。以本轮提示中的真实任务目录绝对路径为准，不使用终端默认目录。用桌面截图核对执行结果，再 screenshot(surface=browser) 观察已准备好的共享示例登录页；不操作网页。不改其他文件。若电脑被用户接管，请等待工具继续，交还后重新截图再操作，不能绕过等待或提前结束。最后简短回复完成情况。`,
      }),
    ),
  );
  const jobs = bots.map((bot) => models.jobs.get(bot)!);
  assert.ok(jobs.every((job) => job?.done));
  diagnostics = async () =>
    Promise.all(
      jobs.map(async (job, index) => {
        const bytes = await readFile(path.join(job.workdir, `vision-${index}.txt`)).catch(
          () => undefined,
        );
        return {
          bot: job.bot,
          phase: job.phase,
          waitingForComputer: job.waitingForComputer,
          tools: job.trace.map(({ name, surface, phase, code }) => ({
            name,
            surface,
            phase,
            code,
          })),
          fileExists: !!bytes,
          fileBytes: bytes?.length,
          exactMarker: bytes?.toString() === markers[index],
          trimmedMarker: bytes?.toString().trim() === markers[index],
          registeredFiles: job.files.map((file) => path.basename(file.path)),
        };
      }),
    );
  for (let attempt = 0; attempt < 1200 && !jobs[0].waitingForComputer && jobs[0].running; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(jobs[0].waitingForComputer, true);
  console.log(JSON.stringify({ stage: 'a-waiting-b-running' }));
  await bounded(jobs[1].done!, 'B_MODEL_TIMEOUT');
  assert.equal(jobs[1].phase, 'completed', jobs[1].error);
  assert.equal(jobs[0].running, true);
  assert.equal(jobs[0].waitingForComputer, true);
  evidence.otherBotCompletedWhileAHumanOwned = true;
  console.log(JSON.stringify({ stage: 'b-completed-release-a' }));
  await computers.transfer(
    bots[0],
    computers.control.state(bots[0]).epoch,
    'agent',
    connections[0].state.instance,
  );
  await bounded(jobs[0].done!, 'A_MODEL_TIMEOUT');
  for (const [index, job] of jobs.entries()) {
    assert.equal(job.phase, 'completed', job.error);
    assert.equal(job.model, config.model);
    for (const name of ['screenshot', 'open_app', 'act'])
      assert.ok(job.trace.some((item) => item.name === name));
    assert.ok(job.trace.every((item) => ['screenshot', 'open_app', 'act'].includes(item.name)));
    assert.ok(job.trace.some((item) => item.name === 'screenshot' && item.surface === 'browser'));
    const content = await readFile(path.join(job.workdir, `vision-${index}.txt`), 'utf8');
    assert.ok(
      content === markers[index] ||
        content === `${markers[index]}\n` ||
        content === `${markers[index]}\r\n`,
    );
    originalFiles[index] = content;
    assert.ok(job.files.some((file) => file.path.endsWith(`/vision-${index}.txt`)));
    await writeFile(
      path.join(path.dirname(output), `vision-${index}.jpg`),
      await computers.frame(
        job.bot,
        connections[index].state.instance,
        computers.control.state(job.bot).epoch,
      ),
      { mode: 0o600 },
    );
  }
  assert.equal(
    await browser.page(bots[1]).locator('#note').inputValue(),
    'SYNTHETIC-B-NOTE-UNCHANGED',
  );
  console.log(JSON.stringify({ stage: 'native-files-confirmed-recycle-a' }));
  const stopped = await computers.operate({
    id: 'mock-vision-stop-a',
    bot: bots[0],
    action: 'stop',
    revision: connections[0].state.revision,
    instance: connections[0].state.instance,
    confirmation: 'close-apps',
  });
  assert.equal(stopped.state.phase, 'disconnected');
  assert.equal(computers.status().items.find((item) => item.bot === bots[1])?.phase, 'connected');
  const reconnected = await computers.operate({
    id: 'mock-vision-reconnect-a',
    bot: bots[0],
    action: 'connect',
    revision: stopped.state.revision,
  });
  assert.equal(reconnected.state.phase, 'connected');
  assert.notEqual(reconnected.state.instance, connections[0].state.instance);
  evidence.stage = 'reconnected-model';
  evidence.paidTaskTurnsSubmitted = 3;
  await models.start(bots[0], {
    requestId: 'mock-vision-new-instance',
    prompt:
      '这是屏幕重建后的合成验收。只调用 screenshot(surface=desktop) 观察当前新屏幕，不输入、不打开应用、不使用其他工具，也不继续之前的命令。然后回复 VISION-RECONNECTED-61。',
  });
  const last = models.jobs.get(bots[0])!;
  await bounded(last.done!, 'RECONNECTED_MODEL_TIMEOUT');
  assert.equal(last.phase, 'completed', last.error);
  assert.equal(last.sessionId, jobs[0].sessionId);
  assert.ok(last.trace.length > 0 && last.trace.every((item) => item.name === 'screenshot'));
  for (const [index, job] of jobs.entries())
    assert.equal(
      await readFile(path.join(job.workdir, `vision-${index}.txt`), 'utf8'),
      originalFiles[index],
    );
  assert.ok(
    (await computers.browserFor(bots[0]).context.cookies()).some(
      (cookie) => cookie.name === 'demo_session' && cookie.httpOnly,
    ),
  );
  assert.equal(
    await access(models.settings.file).then(
      () => true,
      () => false,
    ),
    false,
  );
  Object.assign(evidence, {
    verified: true,
    stage: 'completed',
    protocol: 25,
    model: config.model,
    actualNativeDsh: true,
    independentScreenInstances: true,
    sharedSyntheticLogin: true,
    separateStopAndReconnect: true,
    reconnectedSameDshSession: true,
    savedFilesPreserved: true,
    credentialsConfiguredOnDisk: false,
    inferenceHttpRequestCountMeasured: false,
    turns: [...jobs, last].map((job) => ({
      bot: job.bot,
      tools: job.trace.map(({ name, surface, phase, code }) => ({ name, surface, phase, code })),
      files: job.files.length,
    })),
    screenshots: ['vision-0.jpg', 'vision-1.jpg'],
    originalUserServiceChanged: false,
  });
} catch (error) {
  evidence.diagnostics = await diagnostics?.();
  evidence.failureLocation =
    error instanceof Error
      ? error.stack
          ?.split('\n')
          .find((line) => /vision\.acceptance\.js:\d+/.test(line))
          ?.trim()
      : undefined;
  evidence.error =
    errorCode(error) ||
    (error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'VISION_ACCEPTANCE_FAILED');
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
