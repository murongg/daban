import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuns } from './model.js';
import { Recovery } from './recovery.js';
import { ModelSettings } from './settings.js';

test('global recovery rejects active work without fencing its tools and prevents late model publication for every Bot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-recovery-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let models: ModelRuns;
  const owner = new Recovery({
    quiesce: async () => undefined,
    file: path.join(root, 'recovery.json'),
    boot: 'mock-model-boot',
    instance: 'mock-model-runtime',
    snapshot: () => ({
      computersRevision: 0,
      screens: [],
      running: models
        ? [...models.jobs.values()].filter((job) => job.running).map((job) => job.bot)
        : [],
      changing: false,
    }),
  });
  let release: () => unknown = () => undefined;
  let continueRead: () => unknown = () => undefined;
  const response = new Promise<{ sessionId: string; finalResponse: string }>((resolve) => {
    release = () =>
      resolve({ sessionId: 'mock-recovery-session', finalResponse: 'SYNTHETIC-REPLY' });
  });
  let starts = 0;
  class Harness {
    async start() {
      starts++;
    }
    async close() {}
    session() {
      return { id: 'mock-recovery-session', run: async () => response };
    }
    async resumeSession() {
      return this.session();
    }
  }
  await owner.ready;
  models = new ModelRuns(
    Object.assign(
      {
        settings,
        Harness,
        dir: path.join(root, 'model'),
        workspace: path.join(root, 'workspace'),
        origin: 'http://127.0.0.1:12345',
      },
      { admit: () => owner.admit() },
    ),
  );
  try {
    await settings.save({ apiKey: 'synthetic-recovery-key' });
    await models.ready;
    for (const id of ['mock-a', 'mock-b'])
      await models.profiles.register({
        id,
        name: id,
        instructions: '',
        memory: 'SYNTHETIC-RETAINED',
        color: 'mint',
      });
    await models.start('mock-a', { requestId: 'mock-running', prompt: '合成等待' });
    const busy = owner.review();
    await assert.rejects(
      owner.prepare({
        id: 'mock-busy-recovery',
        revision: busy.revision,
        review: busy.digest,
        confirmation: 'restart-all-apps',
      }),
      { code: 'RECOVERY_TASKS_RUNNING' },
    );
    assert.equal(models.admit('mock-a'), true);
    assert.equal(models.admit('mock-b'), true);
    release();
    await models.jobs.get('mock-a')!.done;
    const original = models.journal.read.bind(models.journal);
    let entered: () => unknown = () => undefined;
    const enteredRead = new Promise((resolve) => {
      entered = () => resolve(undefined);
    });
    const hold = new Promise((resolve) => {
      continueRead = () => resolve(undefined);
    });
    models.journal.read = async (bot, runId) => {
      entered();
      await hold;
      return original(bot, runId);
    };
    const late = models.start('mock-a', {
      requestId: 'mock-late-job',
      prompt: '合成不得启动',
      retryOf: models.jobs.get('mock-a')!.id,
    });
    const rejected = assert.rejects(late, { code: 'RUNTIME_RECOVERY_PENDING' });
    await enteredRead;
    const review = owner.review();
    const prepared = await owner.prepare({
      id: 'mock-real-prepare',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    continueRead();
    await rejected;
    models.journal.read = original;
    assert.equal(models.findRequest('mock-a', 'mock-late-job'), undefined);
    assert.equal(models.admit('mock-a'), false);
    assert.equal(models.admit('mock-b'), false);
    assert.equal(starts, 1);
    await owner.cancel(prepared.id, prepared.revision);
    assert.equal(models.admit('mock-b'), true);
  } finally {
    continueRead();
    release();
    await models.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});
