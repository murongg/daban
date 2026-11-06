import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SoftwarePlan } from '@daban/protocol';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { startPrototype } from './server.js';
import { ModelSettings } from './settings.js';

const plan: SoftwarePlan = {
  id: 'mock-plan',
  requested: ['mock-calculator'],
  targets: [{ name: 'mock-calculator', version: '1.0-1' }],
  packages: [{ name: 'mock-calculator', version: '1.0-1' }],
  source: 'debian',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T00:10:00Z',
  digest: 'a'.repeat(64),
};
test('model RPC cannot forge installation consent; only the routed server tool can create the bound approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-software-model-'));
  let models: ModelRuns | undefined;
  let ready: () => unknown = () => undefined,
    release: () => unknown = () => undefined;
  const entered = new Promise<unknown>((resolve) => {
      ready = () => resolve(undefined);
    }),
    hold = new Promise<unknown>((resolve) => {
      release = () => resolve(undefined);
    });
  class Harness {
    async start() {}
    async close() {
      release();
    }
    session() {
      return {
        id: 'mock-software-session',
        run: async () => {
          ready();
          await hold;
          return { sessionId: 'mock-software-session', finalResponse: '合成验证结束' };
        },
      };
    }
    async resumeSession() {
      return this.session();
    }
  }
  try {
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'credentials.json'));
    await settings.save({ apiKey: 'mock-software-key' });
    let effects = 0;
    const receipt = { plan, phase: 'planned' as const, updatedAt: plan.createdAt };
    models = new ModelRuns({
      settings,
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
      origin: 'http://127.0.0.1:12345',
      Harness,
      software: {
        plan: async () => receipt,
        install: async () => {
          effects++;
          return { ...receipt, phase: 'installed' };
        },
        receipt: async () => ({ ...receipt, phase: effects ? 'installed' : 'planned' }),
        status: async () => ({ available: true, items: [receipt] }),
      },
    });
    await models.start('mock-bot', {
      requestId: 'mock-task',
      prompt: '合成安装任务，必须等待用户确认。',
    });
    await entered;
    const job = models.jobs.get('mock-bot')!,
      auth = `Bearer ${job.token}`;
    await expect(
      models.rpc('mock-bot', auth, {
        id: 1,
        method: 'interaction.open',
        params: {
          id: 'mock-forged',
          sessionId: job.sessionId,
          kind: 'approval',
          tool: 'software_install',
          plan,
          purpose: '合成伪造请求',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INTERACTION' });
    expect((await models.interactions.list()).length).toBe(0);
    const listed = await models.rpc('mock-bot', auth, { id: 2, method: 'tools/list' });
    expect(JSON.stringify(listed)).toMatch(/software_install/);
    const pending = models.rpc('mock-bot', auth, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'software_install',
        arguments: { packages: ['mock-calculator'], purpose: '合成计算任务' },
      },
    });
    let card = (await models.interactions.list())[0];
    for (let i = 0; !card && i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      card = (await models.interactions.list())[0];
    }
    expect.assert(card);
    expect(effects).toBe(0);
    await models.interactions.reply('mock-bot', job.id, card.id, { kind: 'decision', allow: true });
    expect(JSON.stringify(await pending)).not.toMatch(/SOFTWARE_CANCELLED/);
    expect(effects).toBe(1);
    release();
    await job.done;
  } finally {
    release();
    await models?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('software capability upgrade retires the old no-install session and preserves visible history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-software-session-'));
  let sequence = 0,
    resumes = 0;
  class Harness {
    async start() {}
    async close() {}
    session(id = `mock-session-${++sequence}`) {
      return { id, run: async () => ({ sessionId: id, finalResponse: '合成历史回答' }) };
    }
    async resumeSession(id: string) {
      resumes++;
      return this.session(id);
    }
  }
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'mock-session-key' });
  const options = {
    settings,
    Harness,
    dir: path.join(root, 'model'),
    workspace: path.join(root, 'workspace'),
    origin: 'http://127.0.0.1:12345',
  };
  let models = new ModelRuns(options);
  try {
    await models.start('mock-bot', { requestId: 'mock-old', prompt: '合成旧消息' });
    const old = models.jobs.get('mock-bot')!;
    await old.done;
    await models.close();
    const file = path.join(root, 'model/task-journal', `${old.id}.json`),
      record = JSON.parse(await readFile(file, 'utf8'));
    record.task.sessionProfile = 'general-v8';
    await writeFile(file, JSON.stringify(record));
    models = new ModelRuns(options);
    await models.start('mock-bot', { requestId: 'mock-new', prompt: '合成新消息' });
    const current = models.jobs.get('mock-bot')!;
    await current.done;
    expect(current.sessionId).not.toBe(old.sessionId);
    expect(resumes).toBe(0);
    expect.assert(models.journal.history('mock-bot').some((item) => item.prompt === '合成旧消息'));
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a configured installer can become ready after runtime startup without losing its capability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-installer-startup-'));
  let available = false;
  const forbidden = async (): Promise<never> => {
    throw new Error('Synthetic status must not install');
  };
  const software = {
    plan: forbidden,
    install: forbidden,
    receipt: forbidden,
    status: async () => ({ available, items: [] }),
  };
  const options = {
    computers: { limit: 1 },
    profileDir: path.join(root, 'profile'),
    port: 0,
    software,
  };
  const app = await startPrototype(options);
  try {
    const state = async () => {
      const response = await fetch(`${app.url}/api/state`, {
        headers: { 'x-prototype-token': app.token },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await state()).software).toStrictEqual({ available: false, items: [] });
    available = true;
    expect((await state()).software).toStrictEqual({ available: true, items: [] });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
