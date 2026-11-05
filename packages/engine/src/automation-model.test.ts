import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';
import { TaskJournal } from './tasks.js';
import { WorkspaceFiles } from './workspace.js';

test('only the saved output of the accepted run is a signal; replacing its bytes cannot rewrite that result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-signal-'));
  let runs = 0;
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
          const job = models.jobs.get('mock-bot')!;
          await writeFile(path.join(job.workdir, 'result.txt'), 'SYNTHETIC-A');
          return { sessionId: 'mock-session', finalResponse: 'SYNTHETIC FINISHED' };
        },
      };
    }
  }
  const settings = new ModelSettings(path.join(root, 'settings.json'));
  const models = new ModelRuns({
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    settings,
    origin: 'http://127.0.0.1:12345',
    Harness,
  });
  const source = {
    scheduleId: 'mock-schedule',
    firingId: 'mock-firing',
    configRevision: 1,
    trigger: 'manual' as const,
    policy: { kind: 'changes' as const, signalPath: 'result.txt' },
  };
  const task = { requestId: 'mock-accepted', prompt: 'Synthetic task' };
  try {
    await models.ready;
    await settings.save({ apiKey: 'synthetic-model-key' });
    await models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await models.start('mock-bot', task, undefined, { automation: source });
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase, job.error).toBe('completed');
    expect(job.task?.memory).toContain('result.txt');
    expect((await models.automationSignal('mock-bot', job.id, 'result.txt')).toString()).toBe(
      'SYNTHETIC-A',
    );
    const original = await models.journal.read('mock-bot', job.id);
    if (!original) throw new Error('Missing synthetic receipt');
    const other = await new WorkspaceFiles(path.join(root, 'workspace')).create([
      'model-runs',
      'mock-other-run',
      'mock-bot',
    ]);
    await other.write('result.txt', 'SYNTHETIC-A');
    await other.close();
    await models.journal.put({
      ...original,
      outputDirectory: other.path,
      files: original.files?.map((file) => ({
        ...file,
        path: file.path.replace(job.id, 'mock-other-run'),
      })),
    });
    await expect(models.automationSignal('mock-bot', job.id, 'result.txt')).rejects.toMatchObject({
      code: 'AUTOMATION_SIGNAL_UNAVAILABLE',
    });
    await models.journal.put(original);
    const download = WorkspaceFiles.prototype.download;
    vi.spyOn(WorkspaceFiles.prototype, 'download').mockImplementationOnce(async function (
      this: WorkspaceFiles,
      relative,
      limit,
    ) {
      return {
        ...(await download.call(this, relative, limit)),
        path: 'other.txt',
        name: 'other.txt',
      };
    });
    await expect(models.automationSignal('mock-bot', job.id, 'result.txt')).rejects.toMatchObject({
      code: 'AUTOMATION_SIGNAL_UNAVAILABLE',
    });
    await expect(models.automationSignal('mock-other', job.id, 'result.txt')).rejects.toMatchObject(
      { code: 'AUTOMATION_SIGNAL_UNAVAILABLE' },
    );
    await expect(
      models.automationSignal('mock-bot', job.id, '../result.txt'),
    ).rejects.toMatchObject({ code: 'AUTOMATION_SIGNAL_UNAVAILABLE' });
    await expect(models.start('mock-bot', task)).rejects.toMatchObject({
      code: 'REQUEST_ID_REUSED',
    });
    await writeFile(path.join(job.workdir, 'result.txt'), 'SYNTHETIC-B');
    await expect(models.automationSignal('mock-bot', job.id, 'result.txt')).rejects.toMatchObject({
      code: 'AUTOMATION_SIGNAL_UNAVAILABLE',
    });
    expect(models.journal.notices()).toHaveLength(0);
    expect(runs).toBe(1);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted changes provenance suppresses ordinary completion notices across journal restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-journal-'));
  const record = {
    bot: 'mock-bot',
    runId: 'mock-run',
    requestId: 'mock-request',
    kind: 'chat' as const,
    prompt: 'Synthetic input',
    phase: 'completed',
    running: false,
    result: 'Synthetic result',
    error: '',
    trace: [],
    automation: {
      scheduleId: 'mock-schedule',
      firingId: 'mock-firing',
      configRevision: 1,
      trigger: 'time' as const,
      policy: { kind: 'changes' as const, signalPath: 'mock.txt' },
    },
  };
  try {
    let journal = new TaskJournal(root);
    await journal.load();
    await journal.put(record);
    expect(journal.notices()).toHaveLength(0);
    journal = new TaskJournal(root);
    await journal.load();
    expect(journal.notices()).toHaveLength(0);
    const ordinary = { ...record, runId: 'mock-ordinary', automation: undefined };
    await journal.put(ordinary);
    expect(journal.notices()).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
