import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBotLifecycleAck } from '@daban/protocol';
import { startPrototype } from './server.js';

export async function acceptLifecycle(output: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-lifecycle-model-'));
  const key = '/var/lib/bot-prototype/model/credentials.json';
  const beforeKey = await stat(key);
  const keyHash = createHash('sha256')
    .update(await readFile(key))
    .digest('hex');
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await symlink(key, path.join(root, 'model/credentials.json'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const turns: {
    bot: string;
    session?: string;
    tools: string[];
    result: string;
    run: string;
    phase: string;
  }[] = [];
  let acceptedTaskTurns = 0;
  try {
    assert.ok(app.models && app.schedules && app.groups && app.lifecycle);
    const models = app.models;
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(app.url + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-prototype-token': app.token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    };
    const api = async (route: string, body?: unknown) => {
      const result = await request(route, body);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      return result.value;
    };
    assert.equal((await api('/api/state')).clientProtocol, 30);
    const marker = `SYNTHETIC-LC-FILE-${randomBytes(8).toString('hex')}`;
    const memory = `SYNTHETIC-LC-MEMORY-${randomBytes(8).toString('hex')}`;
    for (const id of ['mock-lifecycle-a', 'mock-lifecycle-b'])
      await api('/api/bots', {
        id,
        name: `合成 ${id}`,
        instructions: '',
        memory,
        color: 'mint',
        model: 'deepseek-flash',
      });
    async function turn(bot: string, id: string, prompt: string) {
      const accepted = await api(`/api/bots/${bot}/model`, {
        running: true,
        task: { requestId: id, prompt },
      });
      assert.equal(accepted.requestId, id);
      acceptedTaskTurns++;
      const job = models.jobs.get(bot)!;
      const timer = setTimeout(() => {
        models.stop(bot, 'synthetic-lifecycle-timeout').catch(() => {});
      }, 120000);
      try {
        await job.done;
        const proof = {
          bot,
          session: job.sessionId,
          tools: job.trace.map((item) => item.name),
          result: job.result,
          run: job.id,
          phase: job.phase,
        };
        turns.push(proof);
        assert.equal(job.phase, 'completed', job.error);
        return job;
      } finally {
        clearTimeout(timer);
      }
    }
    const a = 'mock-lifecycle-a';
    const first = await turn(
      a,
      'mock-lifecycle-before',
      `这是合成验收。使用工作区 write_file 写 retained.txt，内容严格为 ${marker}。不使用电脑、浏览器、联网或其他服务；写完只回复已保存。`,
    );
    const report = path.join(first.workdir, 'retained.txt');
    const bytes = await readFile(report);
    assert.equal(bytes.toString('utf8').trim(), marker);
    const group = await api('/api/groups/register', {
      id: 'mock-lifecycle-group',
      name: '合成保留群',
      members: [a, 'mock-lifecycle-b'],
    });
    await app.schedules.create({
      id: 'mock-lifecycle-plan',
      bot: a,
      title: '合成保留计划',
      prompt: '合成未来工作',
      rule: { kind: 'every', everySeconds: 86400 },
      locked: true,
    });
    const archive = { id: 'mock-lifecycle-archive', bot: a, action: 'archive', revision: 1 };
    const archived = await api(`/api/bots/${a}/lifecycle`, archive);
    assert.ok(isBotLifecycleAck(archived));
    assert.equal(archived.profile.archived, true);
    assert.equal(archived.profile.memory, memory);
    assert.deepEqual(await api(`/api/bots/${a}/lifecycle`, archive), archived);
    assert.deepEqual(await api(`/api/bots/${a}/lifecycle-receipt`, { id: archive.id }), archived);
    const blocked = await request(`/api/bots/${a}/model`, {
      running: true,
      task: { requestId: 'mock-lifecycle-blocked', prompt: '合成禁止执行' },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.value.error, 'BOT_ARCHIVED');
    assert.equal(models.findRequest(a, 'mock-lifecycle-blocked'), undefined);
    assert.equal(models.jobs.get(a)!.id, first.id);
    const paused = await app.schedules.get('mock-lifecycle-plan');
    assert.equal(paused.enabled, false);
    assert.equal(paused.locked, true);
    assert.equal(paused.history.length, 0);
    const other = await turn(
      'mock-lifecycle-b',
      'mock-lifecycle-other',
      '普通问候验收：只回复 LC-OTHER-22，不使用任何工具。',
    );
    assert.equal(other.toolCount, 0);
    const restored = await api(`/api/bots/${a}/lifecycle`, {
      id: 'mock-lifecycle-restore',
      bot: a,
      action: 'restore',
      revision: archived.profile.revision,
    });
    assert.ok(isBotLifecycleAck(restored));
    assert.equal(restored.profile.archived, false);
    assert.equal(restored.profile.memory, memory);
    assert.equal(models.jobs.get(a)!.id, first.id);
    assert.equal(models.running(a), false);
    assert.equal((await app.schedules.get('mock-lifecycle-plan')).enabled, false);
    const shared = path.join(root, 'desktops/shared');
    const previous = `/shared/${path.relative(shared, report)}`;
    const after = await turn(
      a,
      'mock-lifecycle-after',
      `这是恢复后的新合成请求。请用 read_file 读取 ${previous}，再回复文件里的标记和你保留的偏好标记。不猜文件内容，不使用电脑或浏览器。`,
    );
    assert.equal(after.sessionId, first.sessionId);
    assert.ok(after.result.includes(marker));
    assert.ok(after.result.includes(memory));
    assert.ok(after.trace.some((item) => item.name === 'read_file' && item.phase === 'settled'));
    assert.deepEqual(await readFile(report), bytes);
    assert.deepEqual(
      (await app.groups.status()).items.find((item) => item.id === group.id)?.members,
      group.members,
    );
    assert.equal(app.runtime.status().items.length, 0);
    const afterKey = await stat(key);
    assert.equal(afterKey.ino, beforeKey.ino);
    assert.equal(afterKey.mtimeMs, beforeKey.mtimeMs);
    assert.equal(
      createHash('sha256')
        .update(await readFile(key))
        .digest('hex'),
      keyHash,
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          verified: true,
          scope:
            'Isolated native DSH through authenticated lifecycle/task APIs; no original Electron activation',
          clientProtocol: 24,
          paidTaskTurns: turns.length,
          httpInferenceRequestCountNotMeasured: true,
          turns,
          archivedRequestHadNoRun: true,
          sameSessionAfterRestore: true,
          originalFileAndMemoryRetained: true,
          groupsRetained: true,
          schedulesPausedNotReenabled: true,
          graphicsAllocated: 0,
          originalKeyContentAndMetadataUnchanged: true,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch (error) {
    await writeFile(
      output,
      JSON.stringify(
        {
          verified: false,
          clientProtocol: 24,
          acceptedTaskTurns,
          completedTaskTurns: turns.filter((turn) => turn.phase === 'completed').length,
          turns,
          error: error instanceof Error ? error.message.slice(0, 1000) : 'ACCEPTANCE_FAILED',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await acceptLifecycle(process.argv[2] || '/tmp/daban-lifecycle-model.json');
