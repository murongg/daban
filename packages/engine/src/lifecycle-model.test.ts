import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('archiving fences model publication and automatic admission while another Bot and restored chat remain usable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-lifecycle-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let started = 0;
  let sequence = 0;
  class Harness {
    async start() {
      started++;
    }
    async close() {}
    session(id = `mock-lifecycle-session-${++sequence}`) {
      return {
        id,
        run: async () => ({ sessionId: id, finalResponse: 'SYNTHETIC-LIFECYCLE-REPLY' }),
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  });
  try {
    await settings.save({ apiKey: 'synthetic-lifecycle-model-key' });
    await models.ready;
    for (const id of ['mock-a', 'mock-b'])
      await models.profiles.register({
        id,
        name: id,
        instructions: '',
        memory: 'SYNTHETIC-RETAINED-MEMORY',
        color: 'mint',
      });
    await models.start('mock-a', { requestId: 'mock-before-archive', prompt: '合成普通问候' });
    const before = models.jobs.get('mock-a')!;
    await before.done;
    const release = models.profiles.reserveLifecycle('mock-a');
    try {
      assert.equal(models.admit('mock-a'), false);
      await assert.rejects(
        models.start('mock-a', { requestId: 'mock-during-archive', prompt: '合成不得开始' }),
        { code: 'BOT_CHANGING' },
      );
      assert.equal(models.jobs.get('mock-a')?.id, before.id);
      await models.profiles.beginLifecycle({
        id: 'mock-archive-op',
        bot: 'mock-a',
        action: 'archive',
        revision: 1,
      });
      await models.profiles.finishLifecycle('mock-a', 'mock-archive-op');
    } finally {
      release();
    }
    const count = started;
    await assert.rejects(
      models.start('mock-a', { requestId: 'mock-after-archive', prompt: '合成不得开始' }),
      { code: 'BOT_ARCHIVED' },
    );
    assert.equal(started, count);
    assert.equal(models.findRequest('mock-a', 'mock-after-archive'), undefined);
    assert.equal(models.admit('mock-b'), true);
    await models.start('mock-b', { requestId: 'mock-other-turn', prompt: '合成其他 Bot 问候' });
    await models.jobs.get('mock-b')!.done;
    const unlock = models.profiles.reserveLifecycle('mock-a');
    try {
      await models.profiles.beginLifecycle({
        id: 'mock-restore-op',
        bot: 'mock-a',
        action: 'restore',
        revision: 3,
      });
    } finally {
      unlock();
    }
    assert.equal(started, count + 1);
    assert.equal(models.admit('mock-a'), true);
    await models.start('mock-a', { requestId: 'mock-restored-turn', prompt: '合成恢复后的新请求' });
    const restored = models.jobs.get('mock-a')!;
    await restored.done;
    assert.equal(restored.sessionId, before.sessionId);
    assert.equal(models.journal.history('mock-a').length, 2);
    assert.equal((await models.profiles.get('mock-a'))?.memory, 'SYNTHETIC-RETAINED-MEMORY');
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
