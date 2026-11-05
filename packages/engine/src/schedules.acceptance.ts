import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { Schedules } from './schedules.js';
import { ModelSettings } from './settings.js';
import type { RawModelTask } from './snapshot.js';

// Paid manual check: real wall-clock timers and DSH, synthetic task content only.
export async function acceptSchedules(output = '/tmp/daban-schedules-live.json') {
  assert.equal(process.platform, 'linux');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-schedules-acceptance-'));
  let models: ModelRuns | undefined, schedules: Schedules | undefined;
  const evidence: Record<string, unknown> = { verified: false, computerAttached: false };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const bot = request.url?.match(/^\/mcp\/(alpha|beta)$/)?.[1];
      assert.ok(models && bot);
      let size = 0;
      const chunks: Buffer[] = [];
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
    const modelOptions = {
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace: path.join(directory, 'workspace'),
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    };
    models = new ModelRuns(modelOptions);
    await models.ready;
    const options = { file: path.join(directory, 'schedules.sqlite'), runner: models };
    schedules = new Schedules(options);
    for (const bot of ['alpha', 'beta'])
      await schedules.create({
        id: `mock-timer-${bot}`,
        bot,
        title: `合成自动任务 ${bot}`,
        prompt: `这是合成定时验收：请使用 write_file 创建 mock-${bot}.txt，内容原样为 TIMER-${bot}-VERIFIED。只创建这个文件，不要打开电脑、浏览器或联网检索。`,
        rule: { kind: 'every', everySeconds: 60 },
      });
    const definitions = await schedules.list();
    evidence.definitions = definitions;
    await schedules.close();
    schedules = new Schedules(options);
    assert.deepEqual(await schedules.list(), definitions);
    schedules.start();
    async function waitCompleted(count: number) {
      const deadline = Date.now() + 150000;
      while (true) {
        assert.ok(models && schedules);
        const items = await schedules.list();
        if (
          items.reduce(
            (total, item) =>
              total + item.history.filter((firing) => firing.state === 'completed').length,
            0,
          ) >= count
        )
          return items;
        assert.equal(
          (await models.interactions.list()).some((item) => item.status === 'pending'),
          false,
        );
        if (Date.now() > deadline) throw new Error('scheduled model task timed out');
        await new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 100));
      }
    }
    const automatically = await waitCompleted(2);
    evidence.automatic = automatically;
    for (const item of automatically) {
      const firing = item.history[0];
      assert.ok(
        Date.parse(firing.createdAt) >=
          Date.parse(definitions.find((value) => value.id === item.id)!.nextRunAt!),
      );
      const task: RawModelTask = models.status().bots[item.bot];
      assert.equal(task.phase, 'completed');
      assert.equal(task.requestId, firing.requestId);
      assert.equal(
        task.trace?.some((entry) => ['desktop', 'browser'].includes(entry.surface)),
        false,
      );
      const file = task.files.find((entry) => entry.name === `mock-${item.bot}.txt`);
      assert.ok(file);
      assert.equal(
        (await readFile(path.join(directory, 'workspace', file.path), 'utf8')).trim(),
        `TIMER-${item.bot}-VERIFIED`,
      );
      await schedules.update(item.id, item.revision, { enabled: false });
    }
    const manual = await schedules.run('mock-timer-alpha', 'mock-one-manual-request');
    assert.deepEqual(await schedules.run('mock-timer-alpha', 'mock-one-manual-request'), manual);
    evidence.afterManual = await waitCompleted(3);
    evidence.tasks = models.status();
    const totalBefore = (await schedules.list()).reduce(
      (total, item) => total + item.history.length,
      0,
    );
    await schedules.close();
    await models.close();
    models = new ModelRuns(modelOptions);
    await models.ready;
    schedules = new Schedules({ ...options, runner: models });
    await schedules.tick();
    assert.equal(
      (await schedules.list()).reduce((total, item) => total + item.history.length, 0),
      totalBefore,
    );
    assert.equal(models.running('alpha'), false);
    assert.equal(models.running('beta'), false);
    for (const item of await schedules.list())
      for (const firing of item.history)
        assert.equal(models.findRequest(item.bot, firing.requestId)?.phase, 'completed');
    evidence.fullModelServiceRestart = true;
    evidence.restartDidNotReplay = true;
    evidence.verified = true;
  } finally {
    if (schedules) evidence.lastSchedules = await schedules.status();
    if (models) evidence.lastModels = models.status();
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
  const result = await acceptSchedules(process.argv[2]);
  console.log(
    JSON.stringify({ verified: result.verified, restartDidNotReplay: result.restartDidNotReplay }),
  );
}
