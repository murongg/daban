import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('native statistics accept only current root updates and survive task settlement and restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-statistics-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let entered!: () => unknown;
  let release!: () => unknown;
  const ready = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session() {
      return {
        id: 'mock-statistics-session',
        run: async () => {
          entered();
          await gate;
          return { sessionId: 'mock-statistics-session', finalResponse: 'SYNTHETIC REPLY' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  const options = {
    settings,
    Harness,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'models'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns(options);
  try {
    await settings.save({ apiKey: 'mock-statistics-secret' });
    await models.start('mock-bot', {
      requestId: 'mock-statistics-request',
      prompt: 'Synthetic request',
    });
    await ready;
    const job = models.jobs.get('mock-bot')!;
    const stats = {
      turns: 3,
      steps: 5,
      llmMs: 2500,
      toolMs: 1250,
      ttftMs: 900,
      ttftSteps: 3,
      decodeMs: 1600,
      decodeTokens: 80,
    };
    const update = (params: Record<string, unknown>, token = job.token) =>
      models.rpc(job.bot, `Bearer ${token}`, { id: 1, method: 'statistics.update', params });
    const params = { sessionId: job.sessionId, seq: 20, stats };
    await expect(update({ ...params, sessionId: 'mock-other-session' })).rejects.toMatchObject({
      code: 'INVALID_STATISTICS',
    });
    await expect(update({ ...params, stats: { ...stats, llmMs: -1 } })).rejects.toMatchObject({
      code: 'INVALID_STATISTICS',
    });
    await expect(update(params, 'mock-wrong-token')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(await update(params)).toMatchObject({ result: { accepted: true } });
    expect(await update({ ...params, seq: 19, stats: { ...stats, steps: 1 } })).toMatchObject({
      result: { accepted: false },
    });
    const scope = { bot: job.bot, runId: job.id, chatRevision: 0 };
    expect(await models.transcript(scope)).not.toHaveProperty('stats');
    expect(await models.statistics(scope)).toMatchObject({ ...scope, stats });
    release();
    await job.done;
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    expect(await models.statistics(scope)).toMatchObject({ ...scope, stats });
    await expect(models.transcript({ ...scope, bot: 'mock-other-bot' })).rejects.toMatchObject({
      code: 'TRANSCRIPT_NOT_FOUND',
    });
    await expect(update(params)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  } finally {
    release();
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
