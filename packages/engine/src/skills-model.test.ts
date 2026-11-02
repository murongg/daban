import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('captured Bot skills use native plugins, change only the next task, and fence resumed sessions without losing chat', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skills-model-'));
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  const patches: { bot: string; rows: Record<string, unknown>[] }[] = [],
    resumed: string[] = [];
  let sequence = 0,
    hold = false,
    release!: () => unknown,
    entered!: () => unknown;
  let gate = Promise.resolve();
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
    async start() {}
    async close() {
      release?.();
    }
    session(id = `mock-skill-session-${++sequence}`) {
      return {
        id,
        run: async () => {
          if (hold) {
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
  async function turn(bot: string, requestId: string, prompt: string) {
    await models.start(bot, { requestId, prompt });
    const job = models.jobs.get(bot)!;
    await job.done;
    assert.equal(job.phase, 'completed');
    return job.sessionId;
  }
  const document = (body: string) =>
    `---\nname: mock-summary\ndescription: 合成汇总\n---\n${body}\n`;
  try {
    await settings.save({ apiKey: 'synthetic-skills-key' });
    await models.ready;
    const plain = await turn('mock-a', 'mock-no-skills', '合成普通问候');
    const skill = await models.skills.import(document('SYNTHETIC-ORIGINAL'));
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
      release = () => resolve(undefined);
    });
    hold = true;
    await models.start('mock-a', {
      requestId: 'mock-skill-held',
      prompt: '/mock-summary 合成汇总',
    });
    await ready;
    const held = models.jobs.get('mock-a')!;
    assert.notEqual(held.sessionId, plain);
    const row = patches.at(-1)!.rows.find((item) => item.id === 'daban-skills')!;
    assert.ok(row);
    const config = row.config as { invoked: string[]; skills: { name: string; content: string }[] };
    assert.deepEqual(config.invoked, ['mock-summary']);
    assert.equal(
      config.skills.find((item) => item.name === 'mock-summary')?.content,
      'SYNTHETIC-ORIGINAL',
    );
    assert.ok(patches.at(-1)!.rows.some((item) => item.name === '@deepseek-ai/dsh-skill'));
    assert.ok(patches.at(-1)!.rows.some((item) => item.name === '@deepseek-ai/dsh-tool-skill'));
    assert.equal(
      patches.at(-1)!.rows.some((item) => item.name === '@deepseek-ai/dsh-skill-filesystem'),
      false,
    );
    const edited = await models.skills.update(
      skill.id,
      skill.revision,
      document('SYNTHETIC-UPDATED'),
    );
    assert.equal(
      config.skills.find((item) => item.name === 'mock-summary')?.content,
      'SYNTHETIC-ORIGINAL',
    );
    hold = false;
    release();
    await held.done;
    await turn('mock-b', 'mock-other-no-skills', '合成其他 Bot 问候');
    assert.deepEqual(
      (
        patches.at(-1)!.rows.find((item) => item.id === 'daban-skills')!.config as {
          skills: { name: string }[];
        }
      ).skills.map((item) => item.name),
      ['find-skills'],
    );
    const changed = await turn('mock-a', 'mock-skill-updated', '按启用技能处理合成记录');
    assert.notEqual(changed, held.sessionId);
    assert.equal(resumed.includes(held.sessionId!), false);
    await models.close();
    models = new ModelRuns(options);
    await models.ready;
    assert.equal(await turn('mock-a', 'mock-skill-restart', '合成后续任务'), changed);
    assert.ok(resumed.includes(changed!));
    await models.skills.bind('mock-a', {
      id: skill.id,
      revision: edited.revision,
      bindingRevision: 1,
      enabled: false,
    });
    const disabled = await turn('mock-a', 'mock-skill-disabled', '合成普通任务');
    assert.notEqual(disabled, changed);
    assert.deepEqual(
      (
        patches.at(-1)!.rows.find((item) => item.id === 'daban-skills')!.config as {
          skills: { name: string }[];
        }
      ).skills.map((item) => item.name),
      ['find-skills'],
    );
    assert.equal(models.journal.history('mock-a').length, 5);
  } finally {
    hold = false;
    release?.();
    await models.close();
    await rm(root, { recursive: true, force: true });
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
          assert.ok(typeof text === 'string');
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
    assert.equal((await models.skills.status()).available, false);
    await models.start('mock-bot', { requestId: 'mock-after-corrupt', prompt: '合成普通问候' });
    const job = models.jobs.get('mock-bot')!;
    await job.done;
    assert.equal(job.phase, 'completed');
    assert.notEqual(job.sessionId, previous);
    assert.ok(prompt.includes('本轮技能服务暂不可用'));
    assert.equal(models.journal.history('mock-bot').length, 2);
    assert.equal((await models.profiles.get('mock-bot'))?.memory, 'SYNTHETIC-RETAINED-MEMORY');
    assert.deepEqual(await readFile(file), corrupt);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});
