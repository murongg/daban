import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ScheduleTools } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import { ModelSettings } from './settings.js';
import type { RawModelTask } from './snapshot.js';

function scheduleRunner(models: ModelRuns): ConstructorParameters<typeof Schedules>[0]['runner'] {
  return {
    running: (bot) => models.running(bot),
    findRequest: (bot, request) => models.findRequest(bot, request),
    start: (bot, task, _scope, source) =>
      models.start(bot, task, undefined, { automation: source }),
  };
}

// Manual paid-model acceptance; synthetic instructions, no customer data or real schedules.
export async function acceptScheduleTools(output = '/tmp/daban-schedule-tools-live.json') {
  assert.equal(process.platform, 'linux');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-schedule-tools-acceptance-'));
  let models: ModelRuns | undefined, schedules: Schedules | undefined;
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
    models = new ModelRuns({
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace: path.join(directory, 'workspace'),
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    });
    await models.ready;
    schedules = new Schedules({
      file: path.join(directory, 'schedules.sqlite'),
      runner: scheduleRunner(models),
    });
    await schedules.ready;
    models.tools.schedules = new ScheduleTools(schedules);
    async function turn(
      bot: string,
      requestId: string,
      prompt: string,
      retryOf?: string,
    ): Promise<RawModelTask> {
      assert.ok(models);
      await models.start(bot, { requestId, prompt, ...(retryOf ? { retryOf } : {}) });
      const deadline = Date.now() + 120000;
      while (models.running(bot)) {
        if (Date.now() > deadline) throw new Error('schedule management timed out');
        assert.equal(
          (await models.interactions.list()).some((item) => item.status === 'pending'),
          false,
        );
        await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
      }
      await models.jobs.get(bot)!.done;
      const task: RawModelTask = models.status().bots[bot];
      evidence[requestId] = task;
      assert.equal(task.phase, 'completed', task.error || 'task did not complete');
      assert.equal(task.files.length, 0);
      assert.equal(
        task.trace?.some((item) =>
          ['desktop', 'browser', 'web', 'workspace'].includes(item.surface),
        ),
        false,
      );
      return task;
    }
    const first = await turn(
      'alpha',
      'mock-chat-create',
      '请帮我新建一个先暂停的定时计划，名称“合成周报检查”，每周五 09:00（Asia/Shanghai），任务说明“用一句话报告合成代号 MOCK-ORION”。先查实际计划避免重复，创建后查询确认，保持暂停，不要现在执行，不用电脑或网页。',
    );
    const created = (await schedules.list({ bot: 'alpha' }))[0];
    assert.ok(created);
    assert.equal(created.title, '合成周报检查');
    assert.equal(created.enabled, false);
    assert.deepEqual(created.rule, {
      kind: 'weekly',
      time: '09:00',
      timeZone: 'Asia/Shanghai',
      weekdays: [5],
    });
    assert.ok(
      first.trace?.some((item) => item.name === 'bot_schedule_create' && item.phase === 'settled'),
    );
    assert.ok(first.runId);
    const retried = await turn(
      'alpha',
      'mock-chat-create-retry',
      `这是同一创建请求的受控重试，请用下面的完全相同参数再次调用 bot_schedule_create 验证幂等，然后查询确认，不要另建不同的计划：${JSON.stringify({ title: created.title, prompt: created.prompt, rule: created.rule, enabled: false })}`,
      first.runId,
    );
    assert.equal((await schedules.list({ bot: 'alpha' })).length, 1);
    assert.equal(models.jobs.get('alpha')!.intentId, first.runId);
    assert.ok(
      retried.trace?.some(
        (item) => item.name === 'bot_schedule_create' && item.phase === 'settled',
      ),
    );
    evidence.retryCreationDeduplicated = true;
    const updated = await turn(
      'alpha',
      'mock-chat-update',
      '把刚刚创建的“合成周报检查”改成工作日 17:30（Asia/Shanghai），并启用它。名称和任务说明保持不变。请先读取实际记录再修改，并再次查询确认。不要另外新建、不要现在执行。',
    );
    const changed = await schedules.get(created.id);
    assert.equal(changed.enabled, true);
    assert.equal(changed.prompt, created.prompt);
    assert.deepEqual(changed.rule, {
      kind: 'weekly',
      time: '17:30',
      timeZone: 'Asia/Shanghai',
      weekdays: [1, 2, 3, 4, 5],
    });
    assert.equal(updated.sessionId, first.sessionId);
    const locked = await schedules.update(created.id, changed.revision, { locked: true });
    await turn(
      'beta',
      'mock-other-bot',
      `请查询并删除计划 ${created.id}。如果无权访问，简短说明并结束，不要另建计划或提问，不用电脑或网页。`,
    );
    assert.deepEqual(await schedules.get(created.id), locked);
    assert.equal((await schedules.list({ bot: 'beta' })).length, 0);
    await turn(
      'alpha',
      'mock-locked-update',
      `请读取计划 ${created.id}，尝试把时间改成 18:00。它已被用户锁定；如果工具或记录显示不能修改，就说明并保持原样。不要解锁、不要新建替代，不用其他工具。`,
    );
    assert.deepEqual(await schedules.get(created.id), locked);
    const unlocked = await schedules.update(created.id, locked.revision, { locked: false });
    evidence.lockedRecord = locked;
    evidence.unlockedRevision = unlocked.revision;
    await turn(
      'alpha',
      'mock-chat-delete',
      `我已解锁，请取消并删除计划 ${created.id}。先查实际记录，使用最新版本删除，再确认它已不存在。不要影响其他计划，不用电脑或网页。`,
    );
    assert.equal((await schedules.list()).length, 0);
    const greeting = await turn(
      'alpha',
      'mock-schedule-greeting',
      '你好，只需要一句简短问候，不要查询或安排任何计划，不用工具。',
    );
    assert.equal(greeting.toolCount, 0);
    evidence.verified = true;
    evidence.sameSession = greeting.sessionId === first.sessionId;
  } finally {
    if (schedules) evidence.finalCatalog = await schedules.status();
    if (models) evidence.finalModels = models.status();
    await schedules?.close();
    await models?.close().catch(() => {});
    await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptScheduleTools(process.argv[2]);
  console.log(JSON.stringify({ verified: result.verified, sameSession: result.sameSession }));
}
