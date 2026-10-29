import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { imageMime } from '@daban/protocol';
import { syntheticAnimatedWebp, syntheticGif, syntheticPng } from './images.fixture.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('native image prompts use immutable bytes, keep group ownership and retry the same session after reconstruction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-image-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const prompts: unknown[] = [];
  const resumed: string[] = [];
  class FakeHarness {
    async start() {}
    async close() {}
    session(id = 'mock-image-session') {
      return {
        id,
        run: async (input: unknown) => {
          prompts.push(input);
          return { sessionId: id, finalResponse: 'SYNTHETIC IMAGE REPLY' };
        },
      };
    }
    async resumeSession(id: string) {
      resumed.push(id);
      return this.session(id);
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  };
  let models = new ModelRuns(options);
  try {
    await settings.save({ apiKey: 'synthetic-image-key', model: 'deepseek-flash' });
    await models.ready;
    const images = [syntheticPng, syntheticGif, syntheticAnimatedWebp];
    const receipts = await Promise.all(
      images.map((image) =>
        models.attachments.upload('mock-group', image, async () => assert.fail('must not extract')),
      ),
    );
    const task = {
      requestId: 'mock-image-request',
      prompt: '描述这张合成图片',
      files: receipts.map((receipt, index) => ({
        name: `renamed-${index}.txt`,
        attachmentId: receipt.id,
      })),
    };
    await assert.rejects(models.start('mock-a', task), { code: 'ATTACHMENT_NOT_FOUND' });
    await models.start(
      'mock-a',
      { ...task, requestId: 'mock-image-group' },
      { id: 'mock-group', context: 'Synthetic group data' },
    );
    const job = models.jobs.get('mock-a')!;
    await job.done;
    assert.equal(job.phase, 'completed');
    assert.ok(Array.isArray(prompts[0]));
    assert.deepEqual(
      prompts[0].slice(1),
      images.map((image) => ({ type: 'image', data: image.data, mimeType: imageMime(image.name) })),
    );
    assert.equal(prompts[0][0].type, 'text');
    assert.equal(job.toolCount, 0);
    for (const [index, image] of images.entries())
      assert.deepEqual(
        await readFile(path.join(job.workdir, task.files[index].name)),
        Buffer.from(image.data, 'base64'),
      );
    await writeFile(path.join(job.workdir, task.files[0].name), 'synthetic changed workspace copy');
    const journal = await readFile(
      path.join(options.dir, 'task-journal', `${job.id}.json`),
      'utf8',
    );
    for (const image of images) assert.equal(journal.includes(image.data), false);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    await models.start(
      'mock-a',
      { requestId: 'mock-image-retry', prompt: task.prompt, retryOf: job.id },
      { id: 'mock-group', context: 'Synthetic group data' },
    );
    await models.jobs.get('mock-a')!.done;
    assert.ok(Array.isArray(prompts[1]));
    assert.deepEqual(prompts[1].slice(1), prompts[0].slice(1));
    assert.deepEqual(resumed, ['mock-image-session']);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a captured text-only model refuses pixels before any harness starts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-text-image-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let starts = 0;
  class FakeHarness {
    async start() {
      starts++;
    }
    async close() {}
    session(id = 'mock-no-image') {
      return { id, run: async () => ({ sessionId: id, finalResponse: 'must not run' }) };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const models = new ModelRuns({
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness: FakeHarness,
  });
  try {
    await settings.save({ apiKey: 'synthetic-image-key', model: 'deepseek-v4-pro' });
    await models.ready;
    const image = await models.attachments.upload(
      'mock-a',
      syntheticPng,
      async () => 'must not extract',
    );
    await assert.rejects(
      models.start('mock-a', {
        requestId: 'mock-refused-image',
        prompt: '描述合成图',
        files: [{ name: image.name, attachmentId: image.id }],
      }),
      { code: 'MODEL_IMAGE_UNSUPPORTED' },
    );
    assert.equal(starts, 0);
    assert.equal(models.jobs.get('mock-a')!.running, false);
    assert.deepEqual((await models.attachments.source('mock-a', image.id)).file, syntheticPng);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
