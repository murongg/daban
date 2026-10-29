import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BrowserState, ComputerRequest } from '@daban/protocol';
import { type ComputerDriver, Computers } from './computers.js';
import { Connections } from './connections.js';
import { Fault } from './control.js';
import type { Screens } from './desktop.js';
import { Native } from './native.js';
import type { Browser } from './runtime.js';

async function fixture(t: { after: (action: () => unknown) => unknown }, limit = 2) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-computers-'));
  const profiles = new Set(['mock-a', 'mock-b', 'mock-c']),
    running = new Set<string>();
  const started: { bot: string; slot: number }[] = [],
    stopped: string[] = [];
  let sequence = 0,
    stopAllowed = true;
  const driver: ComputerDriver = {
    start: async (bot, slot, control) => {
      started.push({ bot, slot });
      const instance = `mock-native-${++sequence}`;
      let closed = false;
      const screens = {
        get closed() {
          return closed;
        },
        instance: () => instance,
        frame: async () => Buffer.from('SYNTHETIC-FRAME'),
        input: async () => {},
        openApp: async () => {},
        close: async () => {
          closed = true;
        },
      };
      return {
        bot,
        instance,
        native: new Native(control, screens as unknown as Screens),
        alive: () => !closed,
      };
    },
    stop: async (resource) => {
      stopped.push(resource.bot);
      if (!stopAllowed) throw new Fault('COMPUTER_STOP_UNCONFIRMED');
      await resource.native.close();
    },
    close: async () => {},
    hasBrowser: () => false,
    browserFor: () => {
      throw new Fault('BROWSER_UNAVAILABLE', 503);
    },
  };
  const options = {
    file: path.join(root, 'computers.sqlite'),
    boot: 'mock-boot',
    limit,
    registered: async (bot: string) => profiles.has(bot),
    busy: (bot: string) => running.has(bot),
    drain: async (_bot: string) => {},
    driver,
  };
  const computers = new Computers(options);
  t.after(async () => {
    stopAllowed = true;
    try {
      await computers.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await computers.ready;
  return {
    root,
    options,
    computers,
    started,
    stopped,
    profiles,
    running,
    setStopAllowed: (value: boolean) => {
      stopAllowed = value;
    },
  };
}

test('connection rechecks Bot admission after asynchronous registration, while cleanup remains available', async (t) => {
  const f = await fixture(t);
  let entered!: () => unknown;
  let release!: () => unknown;
  let admitted = true;
  const ready = new Promise<undefined>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  Object.assign(f.options, {
    admit: (bot: string) => bot !== 'mock-a' || admitted,
    registered: async (bot: string) => {
      entered();
      await gate;
      return f.profiles.has(bot);
    },
  });
  const connect = f.computers.operate({
    id: 'mock-admission-race',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  await ready;
  admitted = false;
  release();
  await assert.rejects(connect, { code: 'COMPUTER_BOT_UNAVAILABLE' });
  assert.equal(f.started.length, 0);
  const other = await f.computers.operate({
    id: 'mock-independent-connect',
    bot: 'mock-b',
    action: 'connect',
    revision: 0,
  });
  assert.equal(other.state.phase, 'connected');
  Object.assign(f.options, { admit: () => false });
  const stopped = await f.computers.operate({
    id: 'mock-independent-stop',
    bot: 'mock-b',
    action: 'stop',
    revision: other.state.revision,
    instance: other.state.instance!,
    confirmation: 'close-apps',
  });
  assert.equal(stopped.state.phase, 'disconnected');
});

test('only registered idle logical Bots can gain a computer and connection does not remap their identity', async (t) => {
  const { computers, started, profiles, running } = await fixture(t);
  await assert.rejects(
    computers.operate({
      id: 'mock-unregistered',
      bot: 'mock-not-registered',
      action: 'connect',
      revision: 0,
    }),
    { code: 'COMPUTER_BOT_NOT_FOUND' },
  );
  running.add('mock-a');
  await assert.rejects(
    computers.operate({ id: 'mock-busy', bot: 'mock-a', action: 'connect', revision: 0 }),
    { code: 'COMPUTER_BUSY' },
  );
  assert.equal(started.length, 0);
  running.delete('mock-a');
  const before = [...profiles];
  const result = await computers.operate({
    id: 'mock-connect-a',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  assert.equal(result.state.bot, 'mock-a');
  assert.equal(result.state.phase, 'connected');
  assert.deepEqual(started, [{ bot: 'mock-a', slot: 0 }]);
  assert.deepEqual([...profiles], before);
});

test('duplicate concurrent connection calls share one effect and reject a changed payload under the same ID', async (t) => {
  const { computers, started, options } = await fixture(t);
  const original = options.driver.start;
  let release!: () => unknown, entered!: () => unknown;
  const enteredStart = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  options.driver.start = async (...args) => {
    entered();
    await gate;
    return original(...args);
  };
  const request: ComputerRequest = {
    id: 'mock-same-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  };
  const first = computers.operate(request);
  await enteredStart;
  const duplicate = computers.operate({ ...request });
  await assert.rejects(computers.operate({ ...request, bot: 'mock-b' }), {
    code: 'COMPUTER_REQUEST_ID_REUSED',
  });
  assert.throws(() => computers.assertStable('mock-a'), { code: 'COMPUTER_CHANGING' });
  release();
  assert.equal((await first).state.instance, (await duplicate).state.instance);
  assert.equal(started.length, 1);
});

test('resource admission is published before draining task cleanup and before graphical effects', async (t) => {
  const { computers, options, started } = await fixture(t);
  let release!: () => unknown, entered!: () => unknown;
  const draining = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  options.drain = async () => {
    entered();
    await gate;
  };
  const operation = computers.operate({
    id: 'mock-wait-cleanup',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  await draining;
  assert.equal(computers.state('mock-a').phase, 'connecting');
  assert.throws(() => computers.assertStable('mock-a'), { code: 'COMPUTER_CHANGING' });
  assert.equal(started.length, 0);
  release();
  await operation;
});

test('separate resources keep the other Bot active while one stops, then reconnect with a new instance and higher lease', async (t) => {
  const { computers } = await fixture(t);
  const a = await computers.operate({
    id: 'mock-a-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  const b = await computers.operate({
    id: 'mock-b-connect',
    bot: 'mock-b',
    action: 'connect',
    revision: 0,
  });
  const oldLease = computers.control.state('mock-a').epoch;
  const stopped = await computers.operate({
    id: 'mock-a-stop',
    bot: 'mock-a',
    action: 'stop',
    revision: a.state.revision,
    instance: a.state.instance,
    confirmation: 'close-apps',
  });
  assert.equal(stopped.state.phase, 'disconnected');
  assert.equal(computers.state('mock-b').instance, b.state.instance);
  assert.equal(computers.resource('mock-b').bot, 'mock-b');
  const reconnected = await computers.operate({
    id: 'mock-a-reconnect',
    bot: 'mock-a',
    action: 'connect',
    revision: stopped.state.revision,
  });
  assert.notEqual(reconnected.state.instance, a.state.instance);
  assert.ok(computers.control.state('mock-a').epoch > oldLease);
});

test('failed stop reserves capacity and only a new explicit stop can retry cleanup', async (t) => {
  const state = await fixture(t, 1),
    { computers } = state;
  const connected = await computers.operate({
    id: 'mock-a-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  state.setStopAllowed(false);
  const request: ComputerRequest = {
    id: 'mock-stop-unknown',
    bot: 'mock-a',
    action: 'stop',
    revision: connected.state.revision,
    instance: connected.state.instance,
    confirmation: 'close-apps',
  };
  const failed = await computers.operate(request);
  assert.equal(failed.state.phase, 'failed');
  assert.equal(failed.state.reserved, true);
  assert.equal(failed.state.recovery, 'stop');
  const attempts = state.stopped.length;
  await computers.operate(request);
  assert.equal(state.stopped.length, attempts);
  await assert.rejects(
    computers.operate({ id: 'mock-b-blocked', bot: 'mock-b', action: 'connect', revision: 0 }),
    { code: 'COMPUTER_CAPACITY' },
  );
  state.setStopAllowed(true);
  await computers.operate({
    ...request,
    id: 'mock-stop-explicit-retry',
    revision: failed.state.revision,
  });
  assert.equal(computers.state('mock-a').reserved, false);
});

test('a missing same-boot owner cannot release an abandoned reservation by pretending cleanup succeeded', async (t) => {
  const state = await fixture(t, 1);
  await state.computers.close();
  const store = new Connections({ file: state.options.file, limit: 1, boot: 'mock-boot' });
  await store.ready;
  store.claim({ id: 'mock-crashed-claim', bot: 'mock-a', action: 'connect', revision: 0 });
  await store.close();
  const restored = new Computers(state.options);
  t.after(() => restored.close());
  await restored.ready;
  const current = restored.state('mock-a');
  assert.equal(current.recovery, 'restart');
  await assert.rejects(
    restored.operate({
      id: 'mock-no-owner-stop',
      bot: 'mock-a',
      action: 'stop',
      revision: current.revision,
      confirmation: 'close-apps',
    }),
    { code: 'COMPUTER_RECOVERY_REQUIRED' },
  );
  assert.equal(restored.state('mock-a').reserved, true);
});

test('failure before the graphical driver is called does not consume a physical reservation', async (t) => {
  const { computers, options, started } = await fixture(t, 1);
  options.drain = async () => {
    throw new Error('synthetic task cleanup failed');
  };
  const result = await computers.operate({
    id: 'mock-pre-driver-failure',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  assert.equal(result.state.phase, 'failed');
  assert.equal(result.state.reserved, false);
  assert.equal(started.length, 0);
});

test('closing during profile admission cannot start a new resource behind the shutdown owner', async (t) => {
  const { computers, options, started } = await fixture(t);
  let releaseProfile!: () => unknown,
    admitted!: () => unknown,
    releaseClose!: () => unknown,
    closingDriver!: () => unknown;
  const profileEntered = new Promise<unknown>((resolve) => {
    admitted = () => resolve(undefined);
  });
  const profileGate = new Promise<unknown>((resolve) => {
    releaseProfile = () => resolve(undefined);
  });
  const closeEntered = new Promise<unknown>((resolve) => {
    closingDriver = () => resolve(undefined);
  });
  const closeGate = new Promise<unknown>((resolve) => {
    releaseClose = () => resolve(undefined);
  });
  options.registered = async () => {
    admitted();
    await profileGate;
    return true;
  };
  options.driver.close = async () => {
    closingDriver();
    await closeGate;
  };
  const operation = computers.operate({
    id: 'mock-admission-after-close',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  await profileEntered;
  const close = computers.close();
  await closeEntered;
  try {
    releaseProfile();
    await assert.rejects(operation, { code: 'COMPUTER_SERVICE_CLOSED' });
    assert.equal(started.length, 0);
  } finally {
    releaseClose();
    await close;
  }
});

test('the stable model facade withholds detached capabilities and snapshots never need graphical IO', async (t) => {
  const { computers } = await fixture(t);
  assert.equal(computers.facade.available?.('mock-a'), false);
  assert.equal((await computers.snapshot()).mode, 'agent');
  const connected = await computers.operate({
    id: 'mock-facade-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  assert.equal(computers.facade.available?.('mock-a'), true);
  assert.equal(computers.facade.screens.instance?.('mock-a'), connected.state.instance);
  const snapshot = await computers.snapshot();
  assert.equal(snapshot.bots['mock-a'].instance, connected.state.instance);
  assert.equal(snapshot.mode, 'desktop');
  assert.equal(computers.facade.browser.available?.('mock-a'), false);
});

test('managed snapshots publish live browser metadata and requests without starting graphics or awaiting page IO', async (t) => {
  const { computers, options } = await fixture(t);
  const state: BrowserState = {
    bot: 'mock-a',
    available: true,
    instance: 'mock-browser',
    revision: 1,
    active: 'mock-tab',
    tabs: [
      {
        id: 'mock-tab',
        url: 'https://example.test/synthetic',
        title: 'Synthetic first',
        generation: 1,
      },
    ],
    pending: [],
  };
  let reads = 0;
  options.driver.hasBrowser = () => true;
  options.driver.browserFor = () =>
    ({
      tabs: {
        metadata: (bot: string) => {
          reads++;
          assert.equal(bot, state.bot);
          return structuredClone(state);
        },
        state: async () => {
          throw new Error('Synthetic metadata must not wait for page adoption');
        },
      },
    }) as unknown as Browser;
  assert.deepEqual((await computers.snapshot()).browsers ?? {}, {});
  assert.equal(reads, 0);
  await computers.operate({
    id: 'mock-metadata-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  assert.deepEqual((await computers.snapshot()).browsers?.['mock-a'], state);
  state.revision++;
  state.tabs[0].title = 'Synthetic current';
  state.pending = [
    {
      id: 'mock-prompt',
      kind: 'dialog',
      dialog: 'prompt',
      tab: state.active,
      generation: 1,
      message: 'SYNTHETIC-QUESTION',
      defaultValue: '',
      truncated: false,
    },
  ];
  assert.deepEqual((await computers.snapshot()).browsers?.['mock-a'], state);
  state.revision++;
  state.pending = [
    { id: 'mock-picker', kind: 'files', tab: state.active, generation: 1, multiple: false },
  ];
  assert.deepEqual((await computers.snapshot()).browsers?.['mock-a']?.pending, state.pending);
});

test('a failed optional browser metadata reader cannot hide connected native screens or ordinary Agent status', async (t) => {
  const { computers, options } = await fixture(t);
  await computers.operate({
    id: 'mock-broken-metadata-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  options.driver.hasBrowser = () => true;
  options.driver.browserFor = () => {
    throw new Fault('BROWSER_STATE_UNAVAILABLE', 503);
  };
  const value = await computers.snapshot();
  assert.deepEqual(value.browsers ?? {}, {});
  assert.equal(value.mode, 'desktop');
  assert.equal(value.bots['mock-a'].owner, 'agent');
});

test('malformed or cross-Bot browser metadata is isolated before publishing the ordinary runtime snapshot', async (t) => {
  const { computers, options } = await fixture(t);
  await computers.operate({
    id: 'mock-invalid-metadata-connect',
    bot: 'mock-a',
    action: 'connect',
    revision: 0,
  });
  const state: BrowserState = {
    bot: 'mock-a',
    available: true,
    instance: 'mock-browser',
    revision: 1,
    active: 'mock-tab',
    tabs: [
      { id: 'mock-tab', url: 'https://example.test/synthetic', title: 'Synthetic', generation: 1 },
    ],
    pending: [],
  };
  options.driver.hasBrowser = () => true;
  for (const invalid of [
    { ...state, bot: 'mock-other' },
    { ...state, tabs: [{ ...state.tabs[0], title: 'SYNTHETIC\0TITLE' }] },
    { ...state, tabs: [{ ...state.tabs[0], url: 'chrome-error://chromewebdata/' }] },
  ]) {
    options.driver.browserFor = () => ({ tabs: { metadata: () => invalid } }) as unknown as Browser;
    const value = await computers.snapshot();
    assert.deepEqual(value.browsers, {});
    assert.equal(value.bots['mock-a'].owner, 'agent');
  }
});
