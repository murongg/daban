import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerFacade, ToolRun } from './computer-tools.js';
import { ComputerTools } from './computer-tools.js';
import { Control } from './control.js';

function setup() {
  const calls: { id: string; input?: unknown; app?: boolean }[] = [];
  const control = new Control(['a', 'b']);
  const runtime: ComputerFacade = {
    control,
    frame: async (id) => Buffer.from(`synthetic-frame-${id}`),
    screens: {
      input: async (id, input) => {
        calls.push({ id, input });
      },
      openApp: async (id) => {
        calls.push({ id, app: true });
      },
    },
    browser: {
      frame: async (id) => Buffer.from(`synthetic-browser-${id}`),
      input: async (id, epoch, input, actor) =>
        control.execute(id, actor || 'agent', epoch, () => {
          calls.push({ id, input });
        }),
    },
  };
  const run: ToolRun = {
    bot: 'a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
  };
  return { calls, control, run, tools: new ComputerTools(runtime) };
}

test('model tools bind all screenshots and actions to the assigned Bot', async () => {
  const { calls, run, tools } = setup();
  const shot = await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  assert.equal(shot.content[1].type, 'image');
  await tools.invoke(run, 'act', { surface: 'desktop', actions: [{ type: 'key', key: 'Enter' }] });
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a'],
  );
  const rejected = await tools.invoke(run, 'screenshot', { surface: 'desktop', bot: 'b' });
  assert.equal(rejected.isError, true);
});

test('model native actions require a new screenshot after only the screen instance changes', async () => {
  const { tools, run, calls } = setup();
  let instance = 'mock-native-before';
  Object.assign(tools.runtime.screens, { instance: () => instance });
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  instance = 'mock-native-after';
  const result = await tools.invoke(run, 'act', {
    surface: 'desktop',
    actions: [{ type: 'key', key: 'Enter' }],
  });
  assert.equal(result.isError, true);
  assert.equal(run.trace.at(-1)?.code, 'DESKTOP_VIEW_STALE');
  assert.deepEqual(calls, []);
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  assert.equal((await tools.invoke(run, 'open_app', { app: 'terminal' })).isError, undefined);
  assert.equal(calls.length, 1);
});

test('a delayed model screenshot cannot authorize input on its replacement instance', async () => {
  const { tools, run } = setup();
  let instance = 'mock-native-before',
    release!: (value: Buffer) => unknown,
    entered!: () => unknown;
  Object.assign(tools.runtime.screens, { instance: () => instance });
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  tools.runtime.frame = async () => {
    entered();
    return new Promise<Buffer>((resolve) => {
      release = resolve;
    });
  };
  const pending = tools.invoke(run, 'screenshot', { surface: 'desktop' });
  await started;
  instance = 'mock-native-after';
  release(Buffer.from('SYNTHETIC-OLD-SHOT'));
  assert.equal((await pending).isError, true);
  assert.equal(run.seen.desktop, undefined);
  assert.equal(run.trace.at(-1)?.code, 'DESKTOP_VIEW_STALE');
});

test('a screenshot interrupted by takeover cannot publish an observation from the old lease', async () => {
  const { tools, run, control } = setup();
  let release!: (value: Buffer) => unknown, entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  tools.runtime.frame = async () => {
    entered();
    return new Promise<Buffer>((resolve) => {
      release = resolve;
    });
  };
  const pending = tools.invoke(run, 'screenshot', { surface: 'desktop' });
  await started;
  const takeover = control.transfer('a', 0, 'human');
  release(Buffer.from('SYNTHETIC-OLD-LEASE'));
  const human = await takeover;
  await control.transfer('a', human.epoch, 'agent');
  assert.equal((await pending).isError, true);
  assert.equal(run.seen.desktop, undefined);
});

test('an uncertain native action consumes its observation so a retry must inspect the actual screen first', async () => {
  const { tools, run, calls } = setup();
  let attempts = 0;
  tools.runtime.screens.input = async (id, input) => {
    calls.push({ id, input });
    if (++attempts === 1) throw new Error('synthetic acknowledgement lost after effect');
  };
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  const input = { surface: 'desktop', actions: [{ type: 'key', key: 'Enter' }] };
  assert.equal((await tools.invoke(run, 'act', input)).isError, true);
  assert.equal((await tools.invoke(run, 'act', input)).isError, true);
  assert.equal(run.trace.at(-1)?.code, 'FRESH_SCREENSHOT_REQUIRED');
  assert.equal(calls.length, 1);
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  assert.equal((await tools.invoke(run, 'act', input)).isError, undefined);
  assert.equal(calls.length, 2);
});

test('a failed native observation never leaves older coordinates authorized for input', async () => {
  const { tools, run, calls } = setup();
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  tools.runtime.frame = async () => {
    throw new Error('synthetic capture unavailable');
  };
  assert.equal((await tools.invoke(run, 'screenshot', { surface: 'desktop' })).isError, true);
  await tools.invoke(run, 'act', { surface: 'desktop', actions: [{ type: 'key', key: 'Enter' }] });
  assert.deepEqual(calls, []);
  assert.equal(run.trace.at(-1)?.code, 'FRESH_SCREENSHOT_REQUIRED');
});

test('human takeover holds pending actions, rejects old coordinates, and resumes on a fresh screenshot', async () => {
  const { calls, control, run, tools } = setup();
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  await control.transfer('a', 0, 'human');
  let settled = false;
  const pending = tools
    .invoke(run, 'act', { surface: 'desktop', actions: [{ type: 'click', x: 10, y: 10 }] })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(settled, false);
  assert.equal((run as unknown as Record<string, unknown>).waitingForComputer, true);
  assert.equal(calls.length, 0);
  assert.equal(control.state('b').owner, 'agent');
  await control.transfer('a', 1, 'agent');
  assert.equal((await pending).isError, true);
  assert.equal((run as unknown as Record<string, unknown>).waitingForComputer, false);
  assert.equal(run.trace.at(-1)?.code, 'FRESH_SCREENSHOT_REQUIRED');
  assert.equal(calls.length, 0);
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  assert.equal(
    (
      await tools.invoke(run, 'act', {
        surface: 'desktop',
        actions: [{ type: 'key', key: 'Enter' }],
      })
    ).isError,
    undefined,
  );
  assert.equal(calls.length, 1);
});

test('tool budgets and cancellation do not permit further native input', async () => {
  const { calls, run, tools } = setup();
  run.limit = 1;
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  assert.equal(
    (
      await tools.invoke(run, 'act', {
        surface: 'desktop',
        actions: [{ type: 'key', key: 'Enter' }],
      })
    ).isError,
    true,
  );
  run.abort.abort();
  assert.equal((await tools.invoke(run, 'screenshot', { surface: 'desktop' })).isError, true);
  assert.equal(calls.length, 0);
});
