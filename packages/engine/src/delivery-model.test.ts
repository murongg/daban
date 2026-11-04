import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { TaskJournal } from './tasks.js';

test('delivery identity survives journal restart without becoming user-supplied task authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-journal-'));
  try {
    const journal = new TaskJournal(root);
    await journal.load();
    const reference = { attemptId: 'mock-attempt', workId: 'mock-work', requestId: 'mock-request' };
    await journal.put({
      bot: 'mock-bot',
      runId: 'mock-run',
      requestId: 'mock-request',
      phase: 'completed',
      running: false,
      prompt: 'Synthetic task',
      result: 'Synthetic result',
      error: '',
      trace: [],
      ...{ delivery: reference },
    });
    const restored = new TaskJournal(root);
    await restored.load();
    expect(restored.findRequest('mock-bot', 'mock-request')).toMatchObject({ delivery: reference });
    expect(restored.findRequest('mock-other', 'mock-request')).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { Delivery } from './delivery.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

test('a durable claim before runner entry recovers as unknown and never auto-dispatches after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-claim-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const files = new WorkspaceFiles(path.join(root, 'shared'));
  const options = {
    settings,
    workspace: files,
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns(options);
  try {
    await models.ready;
    await models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await models.work.write(
      {
        id: 'mock-create',
        item: 'mock-work',
        revision: 0,
        action: 'create',
        value: { title: 'Synthetic work', description: '', progress: '', status: 'todo' },
      },
      { kind: 'human' },
    );
    const request = {
      requestId: 'mock-root-request',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      bot: 'mock-bot',
    };
    await models.work.deliveryEffect((store) => store.start(request));
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    const delivery = new Delivery(models, undefined, files);
    const value = await delivery.command({ type: 'delivery.get', query: { workId: 'mock-work' } });
    expect(value).toMatchObject({ attempts: [{ phase: 'unknown' }] });
    await expect(delivery.command({ type: 'delivery.start', request })).resolves.toMatchObject({
      state: 'complete',
    });
    expect(models.jobs.size).toBe(0);
    expect(models.journal.findRequest('mock-bot', request.requestId)).toBeUndefined();
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { isDeliveryAttempt, isDeliveryReceipt } from '@daban/protocol';

test('an accepted-looking phase without a human decision and a wrong-kind start receipt are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-contract-'));
  const { Work } = await import('./work.js');
  const work = new Work(path.join(root, 'work.sqlite'));
  try {
    await work.ready;
    await work.write(
      {
        id: 'mock-create',
        item: 'mock-work',
        revision: 0,
        action: 'create',
        value: { title: 'Synthetic work', description: '', progress: '', status: 'todo' },
      },
      { kind: 'human' },
    );
    const request = {
      requestId: 'mock-request',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      bot: 'mock-bot',
    };
    const ack = await work.deliveryEffect((store) => store.start(request));
    expect.assert(ack.state === 'complete' && 'attempt' in ack);
    expect(isDeliveryAttempt({ ...ack.attempt, phase: 'accepted-by-user' })).toBe(false);
    expect(isDeliveryAttempt({ ...ack.attempt, phase: 'rejected' })).toBe(false);
    expect(
      isDeliveryReceipt({ state: 'complete', request, checklist: ack.attempt.checklist }),
    ).toBe(false);
    expect(isDeliveryReceipt({ ...ack, request: { ...request, bot: 'mock-other' } })).toBe(false);
  } finally {
    await work.close();
    await rm(root, { recursive: true, force: true });
  }
});
