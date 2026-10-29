import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

// Manual paid integration: all conversation data is synthetic; the existing key is read in its original VM only.
assert.equal(process.platform, 'linux');
assert.equal(process.getuid?.(), 999);
const root = process.env.DABAN_CHAT_MODEL_ROOT;
assert.ok(root);
assert.ok(root.startsWith('/var/lib/bot-prototype/verify-chat-model-'));
assert.equal(await realpath(root), root);
assert.equal((await lstat(root)).uid, process.getuid());
const state = path.join(root, 'state');
await mkdir(state, { mode: 0o700 });
const credentialFile = '/var/lib/bot-prototype/model/credentials.json';
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const before = digest(await readFile(credentialFile));
const settings = new ModelSettings(credentialFile);
const config = await settings.privateConfig();
assert.ok(config);
const temporary = `SYNTHETIC-${randomUUID()}`;
const preference = 'SYNTHETIC-PREFERENCE-47';
const bot = 'mock-chat-context';
let models: ModelRuns | undefined;
let stage = 'setup';
let verified = false;
let paidTaskStarts = 0;
const turns: {
  runId: string;
  sessionId: string;
  phase: string;
  result: string;
  toolCount: number;
  chatRevision: number;
}[] = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, `/mcp/${bot}`);
    assert.equal(request.method, 'POST');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 65536);
      chunks.push(Buffer.from(chunk));
    }
    assert.ok(models);
    const value = await models.rpc(
      bot,
      request.headers.authorization,
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    response.writeHead(value === null ? 202 : 200, { 'content-type': 'application/json' });
    response.end(value === null ? undefined : JSON.stringify(value));
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
function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'),
  );
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
let keyNotPersisted = false;
let existingSettingsUnchanged = false;
try {
  await new Promise<undefined>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const workspace = path.join(state, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'preserved.txt'), 'SYNTHETIC PRESERVED FILE\n', {
    mode: 0o600,
  });
  const options = {
    settings,
    workspace,
    dir: path.join(state, 'model'),
    origin: `http://127.0.0.1:${address.port}`,
  };
  models = new ModelRuns(options);
  await models.ready;
  await models.profiles.register({
    id: bot,
    name: '合成上下文验证',
    instructions: '这是合成验收。只输出一行 JSON，不使用工具，不保存临时代码。',
    memory: `已保存的工作偏好标记是 ${preference}。`,
    color: 'mint',
  });
  const profile = await models.profiles.get(bot);
  async function turn(requestId: string, prompt: string, chatRevision: number) {
    assert.ok(models);
    paidTaskStarts++;
    await writeFile(
      path.join(root!, 'progress.json'),
      JSON.stringify({ stage, phase: 'starting', paidTaskStarts }),
      { mode: 0o600 },
    );
    await models.start(bot, { requestId, prompt, chatRevision });
    const job = models.jobs.get(bot);
    assert.ok(job?.done);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        job.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('CHAT_MODEL_TIMEOUT')), 180000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(job.phase, 'completed');
    assert.equal(job.toolCount, 0);
    assert.ok(job.sessionId);
    assert.equal(job.chatRevision, chatRevision);
    turns.push({
      runId: job.id,
      sessionId: job.sessionId,
      phase: job.phase,
      result: job.result.replaceAll(config!.apiKey, '[redacted]'),
      toolCount: job.toolCount,
      chatRevision,
    });
    console.log(
      JSON.stringify({ stage, phase: job.phase, toolCount: job.toolCount, paidTaskStarts }),
    );
    await writeFile(
      path.join(root!, 'progress.json'),
      JSON.stringify({ stage, phase: job.phase, paidTaskStarts, toolCount: job.toolCount }),
      { mode: 0o600 },
    );
    return json(job.result);
  }
  stage = 'establish-private-context';
  assert.equal(
    (
      await turn(
        'mock-chat-establish',
        `本次会话临时代码是 ${temporary}。它只属于当前对话，不要写入偏好、资料或文件，不调用工具。只输出 {"received":true}。`,
        0,
      )
    ).received,
    true,
  );
  const recallPrompt =
    '不调用任何工具，不查历史、不猜测。只输出一行 JSON：temporary 为当前对话已经给出的临时代码，没有则为 NO_CONTEXT；preference 为已保存的工作偏好标记。';
  stage = 'recall-same-session';
  const recalled = await turn('mock-chat-recall', recallPrompt, 0);
  assert.equal(recalled.temporary, temporary);
  assert.equal(recalled.preference, preference);
  assert.equal(turns[0].sessionId, turns[1].sessionId);
  stage = 'new-conversation-and-restart';
  const request = { id: 'mock-chat-new', bot, revision: 0 };
  const receipt = await models.chats.renew(request);
  assert.equal(receipt.chat.revision, 1);
  assert.equal(models.status().bots[bot].history.length, 0);
  await models.close();
  models = new ModelRuns(options);
  await models.ready;
  assert.deepEqual(await models.chats.receipt(bot, request.id), receipt);
  assert.equal(models.status().bots[bot].history.length, 0);
  stage = 'fresh-context-after-restart';
  const fresh = await turn('mock-chat-fresh', recallPrompt, 1);
  assert.equal(fresh.temporary, 'NO_CONTEXT');
  assert.equal(fresh.preference, preference);
  assert.notEqual(turns[2].sessionId, turns[1].sessionId);
  assert.deepEqual(await models.profiles.get(bot), profile);
  assert.equal(
    await readFile(path.join(workspace, 'preserved.txt'), 'utf8'),
    'SYNTHETIC PRESERVED FILE\n',
  );
  const old = await models.chatHistory(bot, 0);
  assert.equal(old.items.length, 2);
  assert.ok(old.items[0].prompt.includes(temporary));
  assert.equal(models.status().bots[bot].history.length, 1);
  const beforeReplay = models.jobs.get(bot)!.id;
  assert.equal(
    (
      await models.start(bot, {
        requestId: 'mock-chat-recall',
        prompt: recallPrompt,
        chatRevision: 0,
      })
    ).runId,
    turns[1].runId,
  );
  assert.equal(models.jobs.get(bot)!.id, beforeReplay);
  await assert.rejects(
    models.start(bot, {
      requestId: 'mock-chat-delayed',
      prompt: 'SYNTHETIC DELAYED',
      chatRevision: 0,
    }),
    { code: 'CHAT_CONFLICT' },
  );
  assert.equal(models.chats.current('b').revision, 0);
  assert.equal(
    await access(path.join(state, 'model/credentials.json')).then(
      () => true,
      () => false,
    ),
    false,
  );
  await models.close();
  existingSettingsUnchanged = digest(await readFile(credentialFile)) === before;
  assert.ok(existingSettingsUnchanged);
  keyNotPersisted = await keyAbsent(root);
  assert.ok(keyNotPersisted);
  verified = true;
  stage = 'complete';
} catch {
  // Export fixed stage labels only; provider exceptions must never carry credentials into the host evidence.
  process.exitCode = 1;
} finally {
  await models?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<undefined>((resolve) => server.close(() => resolve(undefined)));
  const evidence = {
    verified,
    stage,
    paidTaskStarts,
    nativeSdk: true,
    harnessMocked: false,
    syntheticDataOnly: true,
    provider: 'deepseek-official',
    model: config.model,
    computerAttached: false,
    sameSessionRecall: verified,
    freshSessionAfterDurableBoundaryAndRestart: verified,
    preferenceAndFilePreserved: verified,
    oldRecordsRetained: verified,
    acceptedReplayDidNotStartAnotherTask: verified,
    staleSendRefused: verified,
    existingSettingsUnchanged,
    keyNotPersistedInAcceptanceState: keyNotPersisted,
    turns,
  };
  await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      verified,
      stage,
      paidTaskStarts,
      existingSettingsUnchanged,
      keyNotPersistedInAcceptanceState: keyNotPersisted,
    }),
  );
}
