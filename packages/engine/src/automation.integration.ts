import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { ModelRuns } from './model.js';
import { secureDirectory } from './private-files.js';
import { Schedules } from './schedules.js';
import { ModelSettings } from './settings.js';

test('scoped binary observations dispatch only stable changes through ModelRuns and preserve quiet results, locks and revocation', {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-integration-'));
  await secureDirectory(root);
  const service = await startExecutor({
    directory: path.join(root, 'guest'),
    port: 0,
    boot: 'mock-boot',
  });
  const execution = new RemoteExecutor({
    url: `${service.origin}/exec`,
    token: (await readFile(path.join(root, 'guest/token'), 'utf8')).trim(),
  });
  await execution.ready;
  let runs = 0;
  let dispatches = 0;
  let result = 'RESULT-A';
  class Harness {
    async start() {}
    async close() {}
    async resumeSession() {
      return this.session();
    }
    session() {
      return {
        id: 'mock-session',
        run: async () => {
          runs++;
          await writeFile(path.join(models.jobs.get('mock-bot')!.workdir, 'result.txt'), result);
          return { sessionId: 'mock-session', finalResponse: 'SYNTHETIC FINISHED' };
        },
      };
    }
  }
  const settings = new ModelSettings(path.join(root, 'settings.json'));
  const models = new ModelRuns({
    execution,
    settings,
    dir: path.join(root, 'model'),
    origin: service.origin,
    Harness,
  });
  let now = Date.parse('2026-01-01T00:00:00Z');
  const options = {
    file: path.join(root, 'schedules.sqlite'),
    clock: () => now,
    domain: Promise.resolve({
      create: (input: { id: string; title: string; prompt: string }) => ({
        ...input,
        kind: 'every',
        scheduledAt: '2026-01-01T00:00:00Z',
      }),
      decode: (value: {
        id: string;
        title: string;
        prompt: string;
        kind: string;
        scheduledAt: string;
      }) => value,
      due: (value: { scheduledAt: string }) => ({ occurrenceAt: value.scheduledAt }),
    }),
    observation: models.automationObserver(),
    runner: {
      running: models.running.bind(models),
      admit: models.admit.bind(models),
      findRequest: models.findRequest.bind(models),
      signal: models.automationSignal.bind(models),
      start: (
        bot: string,
        task: { requestId: string; prompt: string },
        _conversation?: undefined,
        source?: import('@daban/protocol').AutomationSource,
      ) => {
        dispatches++;
        return models.start(
          bot,
          { ...task, ...(source?.scope ? { project: source.scope } : {}) },
          undefined,
          { automation: source },
        );
      },
    },
  };
  let schedules = new Schedules(options);
  try {
    await models.ready;
    await schedules.ready;
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const created = await models.projects.write({
      requestId: 'mock-project-create',
      projectId: 'mock-project',
      expectedRevision: 0,
      action: 'create',
      value: { name: 'Synthetic', grants: [{ bot: 'mock-bot', content: 'write' }] },
    });
    assert.equal(created.state, 'complete');
    const scope = { projectId: 'mock-project', revision: 1 };
    const binding = models.projects.assertScope('mock-bot', scope, 'read');
    const files = await execution.call('workspace.base', {
      project: { ...binding, bot: 'mock-bot' },
    });
    assert.equal(typeof files, 'string');
    const watched = path.join(String(files), 'watched.bin');
    await writeFile(watched, Buffer.from([0, 1, 2]));
    let item = await schedules.create({
      id: 'mock-file-plan',
      bot: 'mock-bot',
      title: 'Synthetic monitor',
      prompt: 'Inspect synthetic files only',
      rule: { kind: 'file', scope, paths: ['watched.bin'], pollSeconds: 60 },
    });
    item = await schedules.monitor(item.id, item.revision, {
      kind: 'changes',
      signalPath: 'result.txt',
    });
    item = await schedules.update(item.id, item.revision, { enabled: true });
    item = await schedules.update(item.id, item.revision, { locked: true });
    const poll = async () => {
      now += 60000;
      await schedules.tick();
      const job = models.jobs.get('mock-bot');
      if (job?.done) await job.done;
      await schedules.tick();
    };
    await poll();
    await poll();
    assert.equal(runs, 0);
    for (const byte of [3, 4]) {
      await writeFile(watched, Buffer.from([0, byte]));
      const before: number = runs;
      await poll();
      assert.equal(runs, before);
      await poll();
      assert.equal(runs, before + 1);
      assert.equal(models.jobs.get('mock-bot')!.phase, 'completed');
      assert.equal((await schedules.notices()).length, 0);
      await schedules.close();
      schedules = new Schedules(options);
      await schedules.ready;
    }
    result = 'RESULT-B';
    await writeFile(watched, Buffer.from([0, 5]));
    await poll();
    await poll();
    assert.equal(runs, 3);
    assert.equal((await schedules.notices())[0].reason, 'changed');
    assert.equal(models.journal.notices().length, 0);
    assert.equal((await schedules.get(item.id)).locked, true);
    await schedules.ack(item.id, (await schedules.notices())[0].id);
    const beforeRootLoss: number = dispatches;
    await rm(String(files), { recursive: true, force: true });
    await poll();
    await poll();
    assert.equal(
      dispatches,
      beforeRootLoss,
      'a missing project root is a read failure, not an absent watched file',
    );
    await mkdir(String(files), { recursive: true, mode: 0o700 });
    await writeFile(watched, Buffer.from([0, 5]));
    await poll();
    await poll();
    assert.equal(dispatches, beforeRootLoss);
    await schedules.ack(item.id, (await schedules.notices())[0].id);
    await rm(watched);
    await poll();
    await poll();
    assert.equal(runs, 4);
    assert.equal((await schedules.notices()).length, 0);
    await models.projects.write({
      requestId: 'mock-revoke',
      projectId: scope.projectId,
      expectedRevision: 1,
      action: 'update',
      value: { name: 'Synthetic', grants: [] },
    });
    await writeFile(watched, Buffer.from([0, 6]));
    await poll();
    await poll();
    assert.equal(runs, 4);
    assert.equal((await schedules.get(item.id)).enabled, false);
  } finally {
    await schedules.close();
    await models.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
