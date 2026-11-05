import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeliveryPage, isDeliveryReceipt } from '@daban/protocol';
import { Delivery } from './delivery.js';
import { Groups } from './groups.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { WorkspaceFiles } from './workspace.js';

test('a lost UI reply and host restart retain the root, artifact version and explicit human acceptance without rerunning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-integration-'));
  const files = new WorkspaceFiles(path.join(root, 'shared'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let calls = 0;
  let finish!: () => unknown;
  const gate = new Promise<unknown>((resolve) => {
    finish = () => resolve(undefined);
  });
  let models: ModelRuns;
  class Harness {
    async start() {}
    async close() {
      finish();
    }
    session(id = 'mock-session') {
      return {
        id,
        run: async () => {
          calls++;
          await gate;
          const job = models.jobs.get('mock-bot');
          assert.ok(job);
          await writeFile(path.join(job.workdir, 'report.txt'), 'SYNTHETIC ROOT DELIVERY');
          return { sessionId: id, finalResponse: 'Synthetic output ready for human review' };
        },
      };
    }
    async resumeSession(id: string) {
      return this.session(id);
    }
  }
  const open = async () => {
    models = new ModelRuns({
      settings,
      Harness,
      dir: path.join(root, 'model'),
      workspace: files,
      origin: 'http://127.0.0.1:12345',
    });
    await models.ready;
    const groups = new Groups(path.join(root, 'groups.sqlite'), {
      member: (bot) => models.profiles.get(bot),
      running: (bot) => models.running(bot),
      source: (bot, runId, scope) => models.groupSource(bot, runId, scope),
      findRequest: (bot, requestId) => models.findRequest(bot, requestId),
      start: (bot, task, scope, reference) => models.start(bot, task, scope, reference),
      stopRequest: (bot, requestId, scope) => models.stopRequest(bot, requestId, scope),
    });
    await groups.ready;
    return { delivery: new Delivery(models, groups, files), groups };
  };
  let app = await open();
  try {
    await settings.save({ apiKey: 'mock-integration-provider-key' });
    await models!.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await models!.work.write(
      {
        id: 'mock-create',
        item: 'mock-work',
        revision: 0,
        action: 'create',
        value: {
          title: 'Synthetic task',
          description: '',
          progress: '',
          status: 'todo',
          assignee: 'mock-bot',
        },
      },
      { kind: 'human' },
    );
    await app.delivery.command({
      type: 'delivery.checklist.write',
      request: {
        requestId: 'mock-checklist',
        workId: 'mock-work',
        workRevision: 1,
        checklistRevision: 0,
        items: [{ id: 'mock-report', text: 'Synthetic report', kind: 'file', required: true }],
      },
    });
    const start = {
      requestId: 'mock-root-request',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 1,
      bot: 'mock-bot',
    };
    // The caller drops the response; it can only recover the original accepted operation.
    await app.delivery.command({ type: 'delivery.start', request: start });
    const receipt = await app.delivery.command({ type: 'delivery.receipt', request: start });
    assert.ok(isDeliveryReceipt(receipt) && receipt.state === 'complete' && 'attempt' in receipt);
    finish();
    await models!.jobs.get('mock-bot')?.done;
    assert.equal(calls, 1);
    await app.groups.close();
    await models!.close();
    app = await open();
    const page = await app.delivery.command({
      type: 'delivery.get',
      query: { workId: 'mock-work' },
    });
    assert.ok(isDeliveryPage(page));
    let attempt = page.attempts[0];
    assert.equal(attempt.attemptId, receipt.attempt.attemptId);
    assert.equal(attempt.phase, 'ready');
    assert.equal(calls, 1);
    assert.equal(attempt.outputs.length, 1);
    assert.ok(!JSON.stringify(page).includes(root));
    assert.ok(!JSON.stringify(page).includes('mock-integration-provider-key'));
    const target = () => ({
      workId: 'mock-work',
      workRevision: attempt.ownershipRevision,
      attemptId: attempt.attemptId,
      attemptRevision: attempt.revision,
    });
    const bound = await app.delivery.command({
      type: 'delivery.file.bind',
      request: {
        ...target(),
        requestId: 'mock-bind',
        criterionId: 'mock-report',
        output: attempt.outputs[0],
      },
    });
    assert.ok(isDeliveryReceipt(bound) && bound.state === 'complete' && 'attempt' in bound);
    attempt = bound.attempt;
    const request = {
      ...target(),
      requestId: 'mock-human-accept',
      action: 'accept' as const,
      checked: ['mock-report'],
      reason: '',
      confirmed: true,
    };
    const accepted = await app.delivery.command({ type: 'delivery.decide', request });
    assert.ok(
      isDeliveryReceipt(accepted) && accepted.state === 'complete' && 'attempt' in accepted,
    );
    assert.equal(accepted.attempt.phase, 'accepted-by-user');
    assert.equal((await models!.work.get('mock-work')).status, 'done');
    assert.equal(calls, 1);
    await assert.rejects(
      models!.start('mock-bot', {
        requestId: 'mock-unclaimed-retry',
        prompt: 'Synthetic retry',
        retryOf: attempt.runId,
        chatRevision: models!.chats.current('mock-bot').revision,
      }),
      { code: 'DELIVERY_START_REQUIRED' },
    );
    assert.deepEqual(await app.delivery.command({ type: 'delivery.decide', request }), accepted);
  } finally {
    finish();
    await app.groups.close();
    await models!.close();
    await rm(root, { recursive: true, force: true });
  }
});
