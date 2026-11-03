import { expect, test } from 'vitest';
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
  expect(shot.content[1].type).toBe('image');
  await tools.invoke(run, 'act', { surface: 'desktop', actions: [{ type: 'key', key: 'Enter' }] });
  expect(calls.map((call) => call.id)).toStrictEqual(['a']);
  const rejected = await tools.invoke(run, 'screenshot', { surface: 'desktop', bot: 'b' });
  expect(rejected.isError).toBe(true);
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
  expect(result.isError).toBe(true);
  expect(run.trace.at(-1)?.code).toBe('DESKTOP_VIEW_STALE');
  expect(calls).toStrictEqual([]);
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  expect((await tools.invoke(run, 'open_app', { app: 'terminal' })).isError).toBe(undefined);
  expect(calls.length).toBe(1);
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
  expect((await pending).isError).toBe(true);
  expect(run.seen.desktop).toBe(undefined);
  expect(run.trace.at(-1)?.code).toBe('DESKTOP_VIEW_STALE');
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
  expect((await pending).isError).toBe(true);
  expect(run.seen.desktop).toBe(undefined);
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
  expect((await tools.invoke(run, 'act', input)).isError).toBe(true);
  expect((await tools.invoke(run, 'act', input)).isError).toBe(true);
  expect(run.trace.at(-1)?.code).toBe('FRESH_SCREENSHOT_REQUIRED');
  expect(calls.length).toBe(1);
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  expect((await tools.invoke(run, 'act', input)).isError).toBe(undefined);
  expect(calls.length).toBe(2);
});

test('a failed native observation never leaves older coordinates authorized for input', async () => {
  const { tools, run, calls } = setup();
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  tools.runtime.frame = async () => {
    throw new Error('synthetic capture unavailable');
  };
  expect((await tools.invoke(run, 'screenshot', { surface: 'desktop' })).isError).toBe(true);
  await tools.invoke(run, 'act', { surface: 'desktop', actions: [{ type: 'key', key: 'Enter' }] });
  expect(calls).toStrictEqual([]);
  expect(run.trace.at(-1)?.code).toBe('FRESH_SCREENSHOT_REQUIRED');
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
  expect(settled).toBe(false);
  expect((run as unknown as Record<string, unknown>).waitingForComputer).toBe(true);
  expect(calls.length).toBe(0);
  expect(control.state('b').owner).toBe('agent');
  await control.transfer('a', 1, 'agent');
  expect((await pending).isError).toBe(true);
  expect((run as unknown as Record<string, unknown>).waitingForComputer).toBe(false);
  expect(run.trace.at(-1)?.code).toBe('FRESH_SCREENSHOT_REQUIRED');
  expect(calls.length).toBe(0);
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  expect(
    (
      await tools.invoke(run, 'act', {
        surface: 'desktop',
        actions: [{ type: 'key', key: 'Enter' }],
      })
    ).isError,
  ).toBe(undefined);
  expect(calls.length).toBe(1);
});

test('tool budgets and cancellation do not permit further native input', async () => {
  const { calls, run, tools } = setup();
  run.limit = 1;
  await tools.invoke(run, 'screenshot', { surface: 'desktop' });
  expect(
    (
      await tools.invoke(run, 'act', {
        surface: 'desktop',
        actions: [{ type: 'key', key: 'Enter' }],
      })
    ).isError,
  ).toBe(true);
  run.abort.abort();
  expect((await tools.invoke(run, 'screenshot', { surface: 'desktop' })).isError).toBe(true);
  expect(calls.length).toBe(0);
});
