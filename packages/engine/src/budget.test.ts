import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Control } from './control.js';
import type { Desktop } from './desktop.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test('human waiting does not cancel a model task, while the active execution budget still stops it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-budget-'));
  try {
    let now = 0,
      closed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const control = new Control(['a', 'b'], () => now);
    await control.transfer('a', 0, 'human');
    await mkdir(path.join(root, 'workspace'));
    const settings = new ModelSettings(path.join(root, 'model', 'credentials.json'));
    await settings.save({ apiKey: 'synthetic-budget-key' });
    let complete!: (result: { sessionId: string; finalResponse: string }) => unknown,
      entered!: () => unknown;
    const ready = new Promise<undefined>((resolve) => {
      entered = () => resolve(undefined);
    });
    const waiting = new Promise<{ sessionId: string; finalResponse: string }>((resolve) => {
      complete = resolve;
    });
    let observed!: () => unknown;
    const computerReturned = new Promise<unknown>((resolve) => {
      observed = () => resolve(undefined);
    });
    class FakeHarness {
      async start() {}
      async close() {
        closed++;
        complete({ sessionId: 'synthetic-budget-session', finalResponse: '合成结束' });
      }
      session() {
        return {
          id: 'synthetic-budget-session',
          run: async () => {
            entered();
            const job = models.jobs.get('a')!;
            await models.rpc('a', `Bearer ${job.token}`, {
              id: 'mock-budget-screen',
              method: 'tools/call',
              params: { name: 'screenshot', arguments: { surface: 'desktop' } },
            });
            observed();
            return waiting;
          },
        };
      }
      async resumeSession() {
        return this.session();
      }
    }
    const runtime = {
      page: () => ({}),
      stopWorker: async () => {},
      control,
      screens: {
        screen: () => ({ workspace: path.join(root, 'workspace') }),
        windows: async () => [],
        input: async () => {},
        openApp: async () => {},
      },
      frame: async () => Buffer.from('synthetic'),
      browser: { frame: async () => Buffer.from('synthetic'), input: async () => {} },
      snapshot: async () => ({ sharedLogin: true }),
    } as unknown as Desktop;
    const models = new ModelRuns({
      runtime,
      settings,
      origin: 'http://127.0.0.1:12345',
      dir: path.join(root, 'model'),
      Harness: FakeHarness,
    });
    await models.start('a', { requestId: 'synthetic-budget-request', prompt: '合成等待任务' });
    await ready;
    for (let i = 0; i < 10 && !models.jobs.get('a')!.waitingForComputer; i++)
      await new Promise(setImmediate);
    expect(models.status().bots.a.phase).toBe('paused');
    now = 30 * 60 * 1000;
    vi.advanceTimersByTime(30 * 60 * 1000);
    await new Promise(setImmediate);
    expect(closed, 'an actual computer wait must not spend execution budget').toBe(0);
    expect(models.running('a')).toBe(true);
    await control.transfer('a', 1, 'agent');
    vi.advanceTimersByTime(80);
    await computerReturned;
    now += 300001;
    vi.advanceTimersByTime(1000);
    await models.jobs.get('a')!.done;
    expect(models.status().bots.a.phase).toBe('stopped');
    expect(models.status().bots.a.error || '').toMatch(/运行时长/);
    await models.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
