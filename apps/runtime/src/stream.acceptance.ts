import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import type { RawModelTask } from './snapshot.js';

// Manual paid-model acceptance: synthetic prompts/replies only; never part of the unit-test command.
export async function acceptStream(output = '/tmp/daban-stream-live.json') {
  assert.equal(process.platform, 'linux');
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-stream-acceptance-'));
  let models: ModelRuns | undefined;
  const faults: string[] = [];
  const evidence: Record<string, unknown> = { verified: false, computerAttached: false };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    try {
      const bot = new URL(request.url || '/', 'http://127.0.0.1').pathname.split('/').at(-1)!;
      assert.ok(['alpha', 'beta'].includes(bot));
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) throw new Error('request too large');
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
    } catch (error) {
      faults.push(
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'RPC_ERROR',
      );
      response.writeHead(400);
      response.end('{}');
    }
  });
  const pause = () => new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), 50));
  try {
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const options = {
      settings: new ModelSettings('/var/lib/bot-prototype/model/credentials.json'),
      workspace,
      dir: path.join(directory, 'model'),
      origin: `http://127.0.0.1:${address.port}`,
    };
    models = new ModelRuns(options);
    await Promise.all(
      ['alpha', 'beta'].map((bot) =>
        models!.start(bot, {
          requestId: `mock-stream-${bot}`,
          prompt: `合成验收：第一行原样写 MOCK-${bot.toUpperCase()}。随后用中文写一份完全虚构的团队资料整理规范，共48条编号，每条至少60字。直接输出完整正文，不使用工具、计划、提问或文件。不要提及其他合成团队。`,
        }),
      ),
    );
    const samples: { bot: string; revision: number; length: number; phase: string }[] = [];
    const revisions = new Map<string, number>();
    const began = Date.now();
    let cancelled = '',
      continuing = '';
    while (!cancelled) {
      if (Date.now() - began > 120000) throw new Error('no live streaming prefix');
      const state: Record<string, RawModelTask> = models.status().bots;
      for (const bot of ['alpha', 'beta']) {
        const task = state[bot],
          stream = task.response;
        if (stream?.text && stream.revision > (revisions.get(bot) || 0)) {
          revisions.set(bot, stream.revision);
          samples.push({
            bot,
            revision: stream.revision,
            length: stream.text.length,
            phase: task.phase,
          });
          const journal = JSON.parse(
            await readFile(
              path.join(directory, 'model/task-journal', `${task.runId}.json`),
              'utf8',
            ),
          );
          assert.ok(
            journal.task.response.revision >= stream.revision,
            'visible text must already be durable',
          );
          const other = bot === 'alpha' ? 'beta' : 'alpha';
          assert.equal(stream.text.includes(`MOCK-${other.toUpperCase()}`), false);
          if (stream.text.length > 80 && task.running && state[other].running) {
            cancelled = bot;
            continuing = other;
            break;
          }
        }
      }
      if (!cancelled && !state.alpha.running && !state.beta.running)
        throw new Error('answers arrived without an in-flight prefix');
      if (!cancelled) await pause();
    }
    await models.stop(cancelled);
    const stopped = models.status().bots[cancelled];
    assert.equal(stopped.phase, 'stopped');
    assert.ok(stopped.response?.text);
    const completionStart = Date.now();
    while (models.running(continuing)) {
      if (Date.now() - completionStart > 120000) throw new Error('remaining Bot did not finish');
      const task = models.status().bots[continuing];
      if (task.response?.text && task.response.revision > (revisions.get(continuing) || 0)) {
        revisions.set(continuing, task.response.revision);
        samples.push({
          bot: continuing,
          revision: task.response.revision,
          length: task.response.text.length,
          phase: task.phase,
        });
      }
      await pause();
    }
    await models.jobs.get(continuing)!.done;
    const complete = models.status().bots[continuing];
    assert.equal(complete.phase, 'completed', complete.error || 'remaining Bot did not complete');
    assert.ok(complete.result?.includes(`MOCK-${continuing.toUpperCase()}`));
    assert.equal(complete.toolCount, 0);
    assert.ok(samples.filter((item) => item.bot === continuing).length > 1);
    const prefix = stopped.response!.text;
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    assert.equal(models.status().bots[cancelled].response?.text, prefix);
    assert.equal(models.status().bots[cancelled].phase, 'stopped');
    assert.equal(models.status().bots[continuing].result, complete.result);
    await models.start(cancelled, {
      requestId: 'mock-stream-greeting',
      prompt: '你好，现在只用一句话问候，不继续历史任务，不需要工具或文件。',
    });
    await models.jobs.get(cancelled)!.done;
    const greeting = models.status().bots[cancelled];
    assert.equal(greeting.phase, 'completed', greeting.error || 'greeting did not complete');
    assert.equal(greeting.toolCount, 0);
    evidence.verified = true;
    evidence.samples = samples;
    evidence.cancelled = { bot: cancelled, phase: stopped.phase, prefixLength: prefix.length };
    evidence.completed = {
      bot: continuing,
      phase: complete.phase,
      length: complete.result?.length,
      toolCount: complete.toolCount,
    };
    evidence.recovered = true;
    evidence.greeting = {
      phase: greeting.phase,
      toolCount: greeting.toolCount,
      result: greeting.result,
    };
  } finally {
    if (models) evidence.lastStatus = models.status();
    evidence.faults = faults;
    await writeFile(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await models?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(directory, { recursive: true, force: true });
  }
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await acceptStream(process.argv[2]);
  console.log(
    JSON.stringify({
      verified: result.verified,
      cancelled: result.cancelled,
      completed: result.completed,
      recovered: result.recovered,
      greeting: result.greeting,
    }),
  );
}
