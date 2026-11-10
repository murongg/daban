import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns } from '../packages/engine/src/model.js';
import { ModelSettings } from '../packages/engine/src/settings.js';
import { syntheticRelease } from './testing/releases.js';

test.each(['Bot chat', 'assigned chat'])(
  '%s pins one template generation and enforces model requirements',
  async (surface) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mock-template-model-'));
    const settings = new ModelSettings(path.join(directory, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'mock-model' }] }),
    );
    let releaseRun = () => {};
    const gate = new Promise<undefined>((resolve) => {
      releaseRun = () => resolve(undefined);
    });
    class Harness {
      async start() {}
      async close() {
        releaseRun();
      }
      session(id = 'mock-session') {
        return {
          id,
          run: async () => {
            await gate;
            return { sessionId: id, finalResponse: 'SYNTHETIC REPLY' };
          },
        };
      }
      async resumeSession(id: string) {
        return this.session(id);
      }
    }
    const models = new ModelRuns({
      settings,
      Harness,
      dir: path.join(directory, 'model'),
      workspace: path.join(directory, 'workspace'),
      origin: 'http://127.0.0.1:12345',
    });
    try {
      await settings.configure({
        revision: 0,
        requestId: 'mock-model-config',
        apiKey: 'synthetic-model-key',
        model: 'provider:mock-provider:mock-model',
        connection: {
          id: 'mock-provider',
          name: 'Synthetic',
          baseURL: 'https://models.example.test/v1',
          models: [
            {
              id: 'mock-model',
              name: 'Synthetic',
              vision: false,
              contextWindow: 64000,
              maxTokens: 4096,
            },
          ],
        },
      });
      await models.ready;
      const release = syntheticRelease();
      release.definition.knowledge = [{ key: 'manual', path: 'mock.md', content: 'SYNTHETIC OLD' }];
      const installed = await models.templates.install('mock-model-install', release);
      const chat = surface === 'Bot chat' ? installed.botId : 'mock-assigned-template-chat';
      if (chat !== installed.botId)
        await models.profiles.register({
          id: chat,
          name: 'Synthetic template chat',
          instructions: '',
          memory: '',
          color: 'mint',
          kind: 'chat',
          assistant: installed.botId,
        });
      await models.start(chat, { requestId: 'mock-first-task', prompt: 'SYNTHETIC TASK' });
      const job = models.jobs.get(chat)!;
      const document = (await models.knowledge.list(installed.botId))[0];
      const next = structuredClone(release);
      next.manifest.releaseVersion = '1.1.0';
      next.definition.knowledge[0].content = 'SYNTHETIC NEW';
      next.definition.knowledge.push({
        key: 'new-manual',
        path: 'new.md',
        content: 'SYNTHETIC NEW DOCUMENT',
      });
      const plan = await models.templates.prepare(installed.botId, next);
      await models.templates.commit(plan.id, {}, 'mock-model-upgrade');
      expect(
        (await models.knowledge.read(installed.botId, document.id, undefined, job.id)).content,
      ).toBe('SYNTHETIC OLD');
      expect((await models.knowledge.read(installed.botId, document.id)).content).toBe(
        'SYNTHETIC NEW',
      );
      expect(await models.knowledge.list(installed.botId, true, job.id)).toHaveLength(1);
      await expect(
        models.knowledge.read(
          installed.botId,
          document.id,
          models.templates.installations.read(installed.botId)!.revision,
          job.id,
        ),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_NOT_FOUND' });
      releaseRun();
      await job.done;
      const vision = structuredClone(next);
      vision.manifest.releaseVersion = '1.2.0';
      vision.manifest.requires.model.vision = true;
      const visionPlan = await models.templates.prepare(installed.botId, vision);
      await models.templates.commit(visionPlan.id, {}, 'mock-model-vision');
      await expect(
        models.start(chat, {
          requestId: 'mock-vision-task',
          prompt: 'SYNTHETIC VISION TASK',
        }),
      ).rejects.toMatchObject({ code: 'MODEL_VISION_REQUIRED' });
    } finally {
      releaseRun();
      await models.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
