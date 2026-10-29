import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BrowserCommandRequest } from '@daban/protocol';
import type { BrowserContext, Page } from 'playwright';
import { ComputerTools, type ToolRun } from './computer-tools.js';
import { Browser } from './runtime.js';
import { TabStore } from './tab-store.js';
import { Tabs } from './tabs.js';

function page() {
  const value = new EventEmitter();
  let url = 'about:blank';
  const events: string[] = [];
  const frame = {};
  return Object.assign(value, {
    url: () => url,
    isClosed: () => false,
    title: async () => 'Synthetic page',
    mainFrame: () => frame,
    goto: async (next: string) => {
      events.push(next);
      url = next;
      value.emit('framenavigated', frame);
    },
    screenshot: async (): Promise<Buffer> => Buffer.from('synthetic-jpeg'),
    mouse: {
      click: async () => {
        events.push('click');
      },
      move: async () => {},
      down: async () => {
        events.push('down');
      },
      up: async () => {
        events.push('up');
      },
    },
    keyboard: {
      insertText: async () => {
        events.push('text');
      },
      press: async () => {},
    },
    close: async () => {
      value.emit('close');
    },
    events,
  });
}
async function setup(file: string) {
  const a = page(),
    b = page(),
    created: ReturnType<typeof page>[] = [];
  const context = Object.assign(new EventEmitter(), {
    newPage: async () => {
      const next = page();
      created.push(next);
      return next as unknown as Page;
    },
  }) as unknown as BrowserContext;
  const pages = new Map([
    ['a', a as unknown as Page],
    ['b', b as unknown as Page],
  ]);
  const browser = new Browser(context, pages, 700);
  const store = new TabStore(file, ['a', 'b']);
  const tabs = new Tabs(
    context,
    pages,
    browser.control,
    'http://127.0.0.1:18766',
    (bot) => browser.changed(bot),
    store,
  );
  browser.tabs = tabs;
  await tabs.restore();
  return {
    a,
    b,
    created,
    browser,
    tabs,
    store,
    close: async () => {
      tabs.dispose();
      await tabs.closeStorage();
    },
  };
}
test('human browser commands claim before effects and exact retries do not create extra tabs across restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-client-'));
  let app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const command: BrowserCommandRequest = {
      id: 'mock-new',
      instance: app.tabs.instance,
      epoch: 0,
      action: 'new',
    };
    await assert.rejects(app.tabs.human('a', command), { code: 'STALE_CONTROL' });
    assert.equal(app.created.length, 0);
    const human = await app.browser.transfer('a', 0, 'human');
    command.epoch = human.epoch;
    const [first, retry] = await Promise.all([
      app.tabs.human('a', command),
      app.tabs.human('a', command),
    ]);
    assert.equal(first.state.active, retry.state.active);
    assert.equal(app.created.length, 1);
    assert.equal((await app.tabs.receipt('a', command.id)).phase, 'settled');
    await assert.rejects(
      app.tabs.human('a', { ...command, action: 'open', url: 'https://example.test/' }),
      { code: 'BROWSER_REQUEST_ID_REUSED' },
    );
    await assert.rejects(
      app.tabs.human('a', { ...command, id: 'mock-old-instance', instance: 'old-instance' }),
      { code: 'BROWSER_INSTANCE_CHANGED' },
    );
    assert.equal((await app.tabs.receipt('a', 'mock-old-instance')).phase, 'unknown');
    await app.close();
    app = await setup(path.join(root, 'tabs.sqlite'));
    const restored = await app.tabs.human('a', command);
    assert.equal(restored.state.active, first.state.active);
    assert.equal(app.created.length, 1, 'only the saved second tab is restored, with no replay');
    assert.equal((await app.tabs.receipt('b', command.id)).phase, 'unknown');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('an effect with a lost receipt stays ambiguous after restart and is never repeated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-lost-receipt-'));
  let app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const human = await app.browser.transfer('a', 0, 'human');
    const command: BrowserCommandRequest = {
      id: 'mock-lost',
      instance: app.tabs.instance,
      epoch: human.epoch,
      action: 'navigate',
      tab: (await app.tabs.state('a')).active,
      url: 'https://example.test/synthetic-effect',
    };
    app.store.finish = async () => {
      throw new Error('SYNTHETIC-DISK-FAILURE');
    };
    await assert.rejects(app.tabs.human('a', command), { code: 'BROWSER_STATE_UNAVAILABLE' });
    assert.equal(app.a.events.length, 1);
    await app.close();
    app = await setup(path.join(root, 'tabs.sqlite'));
    const result = await app.tabs.human('a', command);
    assert.equal(result.error, 'BROWSER_OUTCOME_UNKNOWN');
    assert.equal(result.uncertain, true);
    assert.equal(app.a.events.length, 0);
    assert.equal((await app.tabs.receipt('a', command.id)).phase, 'claimed');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('queued browser input and delayed frames cannot cross a tab, document or browser-instance boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-binding-'));
  const app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const human = await app.browser.transfer('a', 0, 'human');
    const binding = app.tabs.binding('a');
    await app.browser.boundInput('a', human.epoch, binding, { type: 'text', text: 'synthetic' });
    assert.deepEqual(app.a.events, ['text']);
    let release!: () => unknown;
    const blocked = app.browser.control.execute(
      'a',
      'human',
      human.epoch,
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    await new Promise(setImmediate);
    const input = app.browser.boundInput('a', human.epoch, binding, {
      type: 'text',
      text: 'must-not-land',
    });
    const stale = assert.rejects(input, { code: 'BROWSER_VIEW_STALE' });
    await app.a.goto('https://example.test/new-document');
    release();
    await blocked;
    await stale;
    assert.deepEqual(app.a.events, ['text', 'https://example.test/new-document']);
    await assert.rejects(
      app.browser.boundInput(
        'a',
        human.epoch,
        { ...app.tabs.binding('a'), instance: 'old-instance' },
        { type: 'text', text: 'must-not-land' },
      ),
      { code: 'BROWSER_VIEW_STALE' },
    );
    let finish!: (frame: Buffer) => unknown;
    app.a.screenshot = () =>
      new Promise<Buffer>((resolve) => {
        finish = resolve;
      });
    const frame = app.browser.view('a');
    const changed = assert.rejects(frame, { code: 'BROWSER_VIEW_STALE' });
    await new Promise(setImmediate);
    await app.tabs.human('a', {
      id: 'mock-switch',
      instance: app.tabs.instance,
      epoch: human.epoch,
      action: 'new',
    });
    finish(Buffer.from('synthetic-old-page'));
    await changed;
    const next = await app.browser.view('a');
    assert.equal(next.binding.tab, (await app.tabs.state('a')).active);
    assert.equal(next.bot, 'a');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('browser pixel tools require the same document that produced the model screenshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-model-browser-binding-'));
  const app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const tools = new ComputerTools({
      control: app.browser.control,
      browser: app.browser,
      frame: async () => Buffer.from('synthetic-desktop'),
      screens: { input: async () => assert.fail('no desktop input'), openApp: async () => {} },
    });
    const run: ToolRun = {
      bot: 'a',
      abort: new AbortController(),
      toolCount: 0,
      limit: 10,
      seen: {},
      trace: [],
    };
    assert.equal(
      (await tools.invoke(run, 'screenshot', { surface: 'browser' })).isError,
      undefined,
    );
    await app.a.goto('https://example.test/next-document');
    const result = await tools.invoke(run, 'act', {
      surface: 'browser',
      actions: [{ type: 'text', text: 'must-not-land' }],
    });
    assert.equal(result.isError, true);
    assert.equal(run.trace.at(-1)?.code, 'BROWSER_VIEW_STALE');
    assert.deepEqual(app.a.events, ['https://example.test/next-document']);
    await tools.invoke(run, 'screenshot', { surface: 'browser' });
    assert.equal(
      (
        await tools.invoke(run, 'act', {
          surface: 'browser',
          actions: [{ type: 'text', text: 'synthetic' }],
        })
      ).isError,
      undefined,
    );
    assert.equal(app.a.events.at(-1), 'text');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a held browser pointer is released on its original page before changing tabs or returning control', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-pointer-'));
  const app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const human = await app.browser.transfer('a', 0, 'human');
    await app.browser.boundInput('a', human.epoch, app.tabs.binding('a'), {
      type: 'pointer',
      phase: 'down',
      x: 1,
      y: 1,
    });
    await app.tabs.human('a', {
      id: 'mock-pointer-tab',
      instance: app.tabs.instance,
      epoch: human.epoch,
      action: 'new',
    });
    await app.browser.boundInput('a', human.epoch, app.tabs.binding('a'), {
      type: 'pointer',
      phase: 'down',
      x: 2,
      y: 2,
    });
    assert.deepEqual(app.a.events, ['down', 'up']);
    assert.deepEqual(app.created[0].events, ['down']);
    await app.browser.transfer('a', human.epoch, 'agent');
    assert.deepEqual(app.created[0].events, ['down', 'up']);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed pointer release retains its original page so returning control can be retried', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-release-retry-'));
  const app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const human = await app.browser.transfer('a', 0, 'human');
    let attempts = 0;
    app.a.mouse.up = async () => {
      if (++attempts === 1) throw new Error('SYNTHETIC-RELEASE-FAILURE');
    };
    await app.browser.boundInput('a', human.epoch, app.tabs.binding('a'), {
      type: 'pointer',
      phase: 'down',
      x: 1,
      y: 1,
    });
    await assert.rejects(
      app.browser.transfer('a', human.epoch, 'agent'),
      /SYNTHETIC-RELEASE-FAILURE/,
    );
    const retained = app.browser.control.state('a');
    assert.equal(retained.owner, 'human');
    assert.equal((await app.browser.transfer('a', retained.epoch, 'agent')).owner, 'agent');
    assert.equal(attempts, 2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('pointer release forwards the active input cancellation when a native dialog interrupts mouse-up', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-release-cancel-'));
  const app = await setup(path.join(root, 'tabs.sqlite'));
  try {
    const human = await app.browser.transfer('a', 0, 'human');
    let forwarded = false;
    app.a.mouse.up = async (options?: { signal?: AbortSignal }) => {
      app.a.emit('dialog', {
        type: () => 'confirm',
        message: () => 'SYNTHETIC-MOUSE-UP',
        defaultValue: () => '',
        accept: async () => {},
        dismiss: async () => {},
      });
      forwarded = options?.signal?.aborted === true;
    };
    await app.browser.boundInput('a', human.epoch, app.tabs.binding('a'), {
      type: 'pointer',
      phase: 'down',
      x: 1,
      y: 1,
    });
    await assert.rejects(
      app.browser.boundInput('a', human.epoch, app.tabs.binding('a'), {
        type: 'pointer',
        phase: 'up',
        x: 1,
        y: 1,
      }),
      { code: 'BROWSER_HUMAN_REQUIRED' },
    );
    assert.equal(
      forwarded,
      true,
      'mouse-up must be cancelled by the prompt, rather than wait for an unrelated cleanup timeout',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
