import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('captured Bot skills use native plugins, change only the next task, and fence resumed sessions without losing chat', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skills-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const patches: { bot: string; rows: Record<string, unknown>[] }[] = [],
    resumed: string[] = [];
  let sequence = 0,
    hold = false,
    release!: () => unknown,
    entered!: () => unknown;
  let gate = Promise.resolve();
  let stage = 'setup',
    activeBot = 'mock-a',
    turns = 0,
    harnessStarts = 0,
    harnessRuns = 0,
    gateEntered = false,
    gateReleased = false,
    observations = 0;
  const startedAt = Date.now();
  class Harness {
    constructor(options: { patches: string[] }) {
      const patch = JSON.parse(readFileSync(options.patches[0], 'utf8'));
      const rows = patch.find((item: { insert?: unknown }) => item.insert).insert;
      const bot = new URL(
        rows.find((item: { id: string }) => item.id === 'computer-tools').config.url,
      ).pathname
        .split('/')
        .at(-1)!;
      patches.push({ bot, rows });
    }
    async start() {
      harnessStarts++;
    }
    async close() {
      release?.();
    }
    session(id = `mock-skill-session-${++sequence}`) {
      return {
        id,
        run: async () => {
          harnessRuns++;
          if (hold) {
            gateEntered = true;
            observe('gate-entered');
            entered();
            await gate;
          }
          return { sessionId: id, finalResponse: 'SYNTHETIC-SKILL-REPLY' };
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
    Harness,
  };
  let models = new ModelRuns(options);
  function observe(event: string) {
    if (observations >= 64) return;
    observations++;
    const job = models.jobs.get(activeBot);
    const phase = job?.phase ?? 'absent';
    const error = job?.error ?? '';
    // Capture only fixed fixture stages, public state/error codes and counts, never job objects or task content.
    console.info(
      '[skills-model-stage]',
      JSON.stringify({
        event,
        stage,
        elapsedMs: Date.now() - startedAt,
        turns,
        harnessStarts,
        harnessRuns,
        gateEntered,
        gateReleased,
        resumed: resumed.length,
        patches: patches.length,
        phase: [
          'absent',
          'starting',
          'running',
          'paused',
          'waiting',
          'completed',
          'failed',
          'stopped',
          'interrupted',
        ].includes(phase)
          ? phase
          : 'unrecognized',
        errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error) ? error : error ? 'NON_CODE_ERROR' : '',
        running: job?.running ?? false,
        preparing: !!job?.preparing,
        finalizing: job?.finalizing ?? false,
        aborted: job?.abort.signal.aborted ?? false,
        toolCount: job?.toolCount ?? 0,
        files: job?.files.length ?? 0,
      }),
    );
  }
  function mark(next: string) {
    stage = next;
    observe('phase');
  }
  const heartbeat = setInterval(() => observe('waiting'), 2000);
  t.onTestFailed(() => observe('test-failed'));
  t.onTestFinished(() => clearInterval(heartbeat));
  async function turn(bot: string, requestId: string, prompt: string) {
    turns++;
    activeBot = bot;
    mark('turn-start');
    await models.start(bot, { requestId, prompt });
    const job = models.jobs.get(bot)!;
    mark('turn-terminal-wait');
    await job.done;
    mark('turn-terminal');
    expect(job.phase).toBe('completed');
    return job.sessionId;
  }
  const document = (body: string) =>
    `---\nname: mock-summary\ndescription: 合成汇总\n---\n${body}\n`;
  try {
    mark('settings-save');
    await settings.save({ apiKey: 'synthetic-skills-key' });
    mark('owner-ready');
    await models.ready;
    const released: unknown[] = [],
      tools = models.tools.skills!,
      originalRelease = Reflect.get(tools, 'release');
    Reflect.set(tools, 'release', (run: unknown) => {
      released.push(run);
      if (typeof originalRelease === 'function')
        return Reflect.apply(originalRelease, tools, [run]);
    });
    const plain = await turn('mock-a', 'mock-no-skills', '合成普通问候');
    expect(released.length, 'Completed jobs must release task-owned package buffers').toBe(1);
    mark('skill-import');
    const skill = await models.skills.import(document('SYNTHETIC-ORIGINAL'));
    mark('skill-bind');
    await models.skills.bind('mock-a', {
      id: skill.id,
      revision: skill.revision,
      bindingRevision: 0,
      enabled: true,
    });
    const ready = new Promise<unknown>((resolve) => {
      entered = () => resolve(undefined);
    });
    gate = new Promise<undefined>((resolve) => {
      release = () => {
        gateReleased = true;
        resolve(undefined);
      };
    });
    hold = true;
    mark('held-start');
    await models.start('mock-a', {
      requestId: 'mock-skill-held',
      prompt: '/mock-summary 合成汇总',
    });
    const held = models.jobs.get('mock-a')!;
    expect.assert(held.done);
    mark('held-gate-wait');
    // An early task terminal must surface before the test's 30s deadline instead of hiding behind an unopened gate.
    const outcome = await Promise.race([
      ready.then(() => 'entered' as const),
      held.done.then(
        () => 'terminal' as const,
        () => 'terminal' as const,
      ),
    ]);
    observe(outcome === 'terminal' ? 'terminal-before-gate' : 'gate-ready');
    expect(
      outcome,
      'Held task terminated before the synthetic Harness run gate; see bounded phase trace',
    ).toBe('entered');
    expect(held.sessionId).not.toBe(plain);
    const row = patches.at(-1)!.rows.find((item) => item.id === 'daban-skills')!;
    expect.assert(row);
    const config = row.config as { invoked: string[]; skills: { name: string; content: string }[] };
    expect(config.invoked).toStrictEqual(['mock-summary']);
    expect(config.skills.find((item) => item.name === 'mock-summary')?.content).toBe(
      'SYNTHETIC-ORIGINAL',
    );
    expect.assert(patches.at(-1)!.rows.some((item) => item.name === '@deepseek-ai/dsh-skill'));
    expect.assert(patches.at(-1)!.rows.some((item) => item.name === '@deepseek-ai/dsh-tool-skill'));
    expect(
      patches.at(-1)!.rows.some((item) => item.name === '@deepseek-ai/dsh-skill-filesystem'),
    ).toBe(false);
    mark('skill-update');
    const edited = await models.skills.update(
      skill.id,
      skill.revision,
      document('SYNTHETIC-UPDATED'),
    );
    expect(config.skills.find((item) => item.name === 'mock-summary')?.content).toBe(
      'SYNTHETIC-ORIGINAL',
    );
    hold = false;
    mark('held-release');
    release();
    await held.done;
    mark('held-terminal');
    await turn('mock-b', 'mock-other-no-skills', '合成其他 Bot 问候');
    expect(
      (
        patches.at(-1)!.rows.find((item) => item.id === 'daban-skills')!.config as {
          skills: { name: string }[];
        }
      ).skills.map((item) => item.name),
    ).toStrictEqual(['find-skills']);
    const changed = await turn('mock-a', 'mock-skill-updated', '按启用技能处理合成记录');
    expect(changed).not.toBe(held.sessionId);
    expect(resumed.includes(held.sessionId!)).toBe(false);
    mark('owner-close');
    await models.close();
    mark('owner-restart');
    models = new ModelRuns(options);
    await models.ready;
    expect(await turn('mock-a', 'mock-skill-restart', '合成后续任务')).toBe(changed);
    expect.assert(resumed.includes(changed!));
    mark('skill-disable');
    await models.skills.bind('mock-a', {
      id: skill.id,
      revision: edited.revision,
      bindingRevision: 1,
      enabled: false,
    });
    const disabled = await turn('mock-a', 'mock-skill-disabled', '合成普通任务');
    expect(disabled).not.toBe(changed);
    expect(
      (
        patches.at(-1)!.rows.find((item) => item.id === 'daban-skills')!.config as {
          skills: { name: string }[];
        }
      ).skills.map((item) => item.name),
    ).toStrictEqual(['find-skills']);
    expect(models.journal.history('mock-a').length).toBe(5);
  } finally {
    mark('cleanup-close');
    hold = false;
    release?.();
    try {
      await models.close();
      mark('cleanup-remove');
      await rm(root, { recursive: true, force: true });
    } finally {
      clearInterval(heartbeat);
    }
  }
});

test('unreadable skills leave ordinary conversation available and never resume the old loaded-skill session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skills-degraded-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  let sequence = 0,
    prompt = '';
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-degraded-${++sequence}`) {
      return {
        id,
        run: async (text: unknown) => {
          expect.assert(typeof text === 'string');
          prompt = text;
          return { sessionId: id, finalResponse: 'SYNTHETIC-ORDINARY' };
        },
      };
    }
    async resumeSession(): Promise<never> {
      throw new Error('Must not resume stale skill instructions');
    }
  }
  const options = {
    settings,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
    origin: 'http://127.0.0.1:12345',
    Harness,
  };
  let models = new ModelRuns(options);
  const file = path.join(root, 'model/skills.sqlite'),
    corrupt = Buffer.from('SYNTHETIC-UNREADABLE-SKILLS');
  try {
    await settings.save({ apiKey: 'synthetic-degraded-skill-key' });
    await models.ready;
    await models.profiles.register({
      id: 'mock-bot',
      name: '合成助手',
      instructions: '',
      memory: 'SYNTHETIC-RETAINED-MEMORY',
      color: 'mint',
    });
    const skill = await models.skills.import(
      '---\nname: mock-old-skill\ndescription: 合成旧技能\n---\n只处理合成输入。',
    );
    await models.skills.bind('mock-bot', {
      id: skill.id,
      revision: skill.revision,
      bindingRevision: 0,
      enabled: true,
    });
    await models.start('mock-bot', { requestId: 'mock-before-corrupt', prompt: '合成任务' });
    await models.jobs.get('mock-bot')!.done;
    const previous = models.jobs.get('mock-bot')!.sessionId;
    await models.close();
    await writeFile(file, corrupt, { mode: 0o600 });
    models = new ModelRuns(options);
    await models.ready;
    expect((await models.skills.status()).available).toBe(false);
    await models.start('mock-bot', { requestId: 'mock-after-corrupt', prompt: '合成普通问候' });
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    expect(job.phase).toBe('completed');
    expect(job.sessionId).not.toBe(previous);
    expect.assert(prompt.includes('The skill service is unavailable for this turn'));
    expect(models.journal.history('mock-bot').length).toBe(2);
    expect((await models.profiles.get('mock-bot'))?.memory).toBe('SYNTHETIC-RETAINED-MEMORY');
    expect(await readFile(file)).toStrictEqual(corrupt);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
