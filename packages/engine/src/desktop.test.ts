import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Control } from './control.js';
import { Desktop, nativeInput, Screens } from './desktop.js';
import { DesktopSandbox } from './desktop-sandbox.js';
import type { Browser } from './runtime.js';

function syntheticDesktop() {
  const instances = new Map([
    ['a', 'mock-screen-a'],
    ['b', 'mock-screen-b'],
  ]);
  const effects: string[] = [];
  const control = new Control(['a', 'b']);
  const screens = {
    instance: (id: string) => instances.get(id)!,
    input: async () => {
      effects.push('input');
    },
    openApp: async () => {
      effects.push('app');
    },
    release: async () => {
      effects.push('release');
    },
    frame: async (): Promise<Buffer> => Buffer.from('SYNTHETIC-FRAME'),
  };
  const browser = {
    control,
    context: {},
    page: () => ({}),
    log: () => {},
    transfer: (id: string, epoch: number, owner: string, settle: () => Promise<unknown>) =>
      control.transfer(id, epoch, owner, settle),
  };
  return {
    instances,
    effects,
    control,
    screens,
    desktop: new Desktop(browser as unknown as Browser, screens as unknown as Screens),
  };
}

test('native instance changes reject input, apps and handoffs even when the control epoch still matches', async () => {
  const { desktop, control, instances, effects } = syntheticDesktop();
  const human = await control.transfer('a', 0, 'human');
  instances.set('a', 'mock-replacement-a');
  await assert.rejects(
    Reflect.apply(desktop.input, desktop, [
      'a',
      human.epoch,
      { type: 'key', key: 'Enter' },
      'mock-screen-a',
    ]),
    { code: 'DESKTOP_VIEW_STALE' },
  );
  await assert.rejects(
    Reflect.apply(desktop.openApp, desktop, ['a', human.epoch, 'terminal', 'mock-screen-a']),
    { code: 'DESKTOP_VIEW_STALE' },
  );
  await assert.rejects(
    Reflect.apply(desktop.transfer, desktop, ['a', human.epoch, 'agent', 'mock-screen-a']),
    { code: 'DESKTOP_VIEW_STALE' },
  );
  assert.deepEqual(effects, []);
  assert.equal(control.state('a').owner, 'human');
  assert.equal(control.state('b').epoch, 0);
});

test('native instance validation runs inside the input queue, before any replacement-screen effect', async () => {
  const { desktop, control, instances, effects } = syntheticDesktop();
  const human = await control.transfer('a', 0, 'human');
  let release!: () => unknown, entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const busy = control.execute('a', 'human', human.epoch, () => {
    entered();
    return gate;
  });
  await started;
  const rejected = assert.rejects(
    Reflect.apply(desktop.input, desktop, [
      'a',
      human.epoch,
      { type: 'text', text: 'NEVER-TYPE' },
      'mock-screen-a',
    ]),
    { code: 'DESKTOP_VIEW_STALE' },
  );
  instances.set('a', 'mock-replacement-a');
  release();
  await busy;
  await rejected;
  assert.deepEqual(effects, []);
});

test('a native frame captured before screen replacement is discarded instead of returned as the new screen', async () => {
  const { desktop, instances, screens } = syntheticDesktop();
  let release!: (image: Buffer) => unknown;
  screens.frame = () =>
    new Promise<Buffer>((resolve) => {
      release = resolve;
    });
  const pending = Reflect.apply(desktop.frame, desktop, ['a', 'mock-screen-a', 0]);
  const rejected = assert.rejects(pending, { code: 'DESKTOP_VIEW_STALE' });
  instances.set('a', 'mock-replacement-a');
  release(Buffer.from('SYNTHETIC-OLD-FRAME'));
  await rejected;
});

test('native frame requests never share a pending capture with a replacement instance', async () => {
  const { desktop, instances, screens } = syntheticDesktop();
  let release!: (image: Buffer) => unknown,
    reads = 0;
  screens.frame = async () => {
    reads++;
    return reads === 1
      ? new Promise<Buffer>((resolve) => {
          release = resolve;
        })
      : Buffer.from('SYNTHETIC-NEW-FRAME');
  };
  const old = Reflect.apply(desktop.frame, desktop, ['a', 'mock-screen-a', 0]);
  old.catch(() => {});
  instances.set('a', 'mock-replacement-a');
  const fresh = Reflect.apply(desktop.frame, desktop, ['a', 'mock-replacement-a', 0]);
  try {
    assert.equal(reads, 2);
  } finally {
    release(Buffer.from('SYNTHETIC-OLD-FRAME'));
  }
  await assert.rejects(old, { code: 'DESKTOP_VIEW_STALE' });
  assert.equal((await fresh).toString(), 'SYNTHETIC-NEW-FRAME');
});

test('a post-action native observation cannot reuse a capture that began before the action', async () => {
  const { desktop, control, screens } = syntheticDesktop();
  const human = await control.transfer('a', 0, 'human');
  let release!: (image: Buffer) => unknown,
    reads = 0;
  screens.frame = async () => {
    reads++;
    return reads === 1
      ? new Promise<Buffer>((resolve) => {
          release = resolve;
        })
      : Buffer.from('SYNTHETIC-AFTER-ACTION');
  };
  const before = desktop.frame('a', 'mock-screen-a', human.epoch);
  await desktop.input('a', human.epoch, { type: 'key', key: 'Enter' }, 'mock-screen-a');
  const after = desktop.frame('a', 'mock-screen-a', human.epoch);
  try {
    assert.equal(reads, 2);
  } finally {
    release(Buffer.from('SYNTHETIC-BEFORE-ACTION'));
  }
  await before;
  assert.equal((await after).toString(), 'SYNTHETIC-AFTER-ACTION');
});

test('retired native screens no longer resolve a display or instance that a successor could reuse', async () => {
  const screens = new Screens({
    dir: '/synthetic/retired',
    origin: 'http://127.0.0.1:12345',
    displayBase: 41,
  });
  screens.bots.set('a', {
    id: 'a',
    instance: 'mock-retired-instance',
    directory: '/synthetic/retired/a',
    workspace: '/synthetic/shared',
    env: { DISPLAY: ':41', XAUTHORITY: '/synthetic/authority' },
    display: ':41',
    steps: 0,
    lastAction: '',
    note: 'mock-note',
    file: 'mock-file',
  });
  await screens.close();
  assert.throws(() => screens.instance('a'), { code: 'COMPUTER_NOT_CONNECTED' });
  assert.throws(() => screens.screen('a'), { code: 'COMPUTER_NOT_CONNECTED' });
});

test('starting a retired native driver fails before rewriting any successor configuration', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-boot-'));
  const screens = new Screens({
    dir: root,
    origin: 'http://127.0.0.1:12345',
    displayBase: 41,
  });
  t.mock.method(screens, 'run', async () => {
    throw new Error('synthetic unexpected GUI boot');
  });
  try {
    await screens.close();
    await assert.rejects(screens.start(), { code: 'COMPUTER_NOT_CONNECTED' });
  } finally {
    await screens.log?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a scoped native stack uses its logical Bot ID rather than allocating the legacy pair', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-single-screen-'));
  t.mock.method(DesktopSandbox.prototype, 'start', async () => {});
  t.mock.method(DesktopSandbox.prototype, 'io', async () => '');
  const screens = new Screens({
    dir: root,
    origin: 'http://127.0.0.1:12345',
    displayBase: 61,
  });
  t.mock.method(screens, 'run', async () => {
    throw Object.assign(new Error('synthetic boundary'), { code: 'SYNTHETIC_BOUNDARY' });
  });
  try {
    await assert.rejects(Reflect.apply(screens.start, screens, [['mock-custom-bot']]), {
      code: 'SYNTHETIC_BOUNDARY',
    });
    assert.deepEqual([...screens.bots.keys()], ['mock-custom-bot']);
    assert.equal(screens.screen('mock-custom-bot').display, ':61');
  } finally {
    await screens.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unconfirmed native teardown fails closed and may retry cleanup without re-enabling the driver', {
  timeout: 10000,
}, async (t) => {
  const screens = new Screens({
    dir: '/synthetic/teardown',
    origin: 'http://127.0.0.1:12345',
    displayBase: 61,
  });
  const processState = Object.assign(new EventEmitter(), {
    pid: 987654321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  const child = processState as unknown as ChildProcess;
  screens.children.push(child);
  let allowExit = false;
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  t.mock.method(process, 'kill', (_pid: number, signal?: number | NodeJS.Signals) => {
    signals.push(signal);
    if (allowExit) {
      processState.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    }
    return true;
  });
  await assert.rejects(screens.close(), { code: 'COMPUTER_STOP_UNCONFIRMED' });
  assert.equal(screens.closed, true);
  assert.ok(signals.includes('SIGKILL'));
  allowExit = true;
  await screens.close();
  assert.ok(child.signalCode);
  assert.throws(() => screens.screen('mock-custom-bot'), { code: 'COMPUTER_NOT_CONNECTED' });
});

test('native input preserves target display routing and validates coordinates and keys', () => {
  assert.deepEqual(nativeInput({ type: 'release' }), [
    'mouseup',
    '1',
    'mouseup',
    '2',
    'mouseup',
    '3',
    'keyup',
    'ctrl',
    'keyup',
    'alt',
    'keyup',
    'shift',
    'keyup',
    'Super_L',
  ]);
  assert.deepEqual(nativeInput({ type: 'click', x: 123, y: 45, button: 3 }), [
    'mousemove',
    '123',
    '45',
    'click',
    '3',
  ]);
  assert.deepEqual(nativeInput({ type: 'pointer', phase: 'down', x: 2, y: 4, button: 1 }), [
    'mousemove',
    '2',
    '4',
    'mousedown',
    '1',
  ]);
  assert.deepEqual(nativeInput({ type: 'pointer', phase: 'up', x: 2, y: 4, button: 1 }), [
    'mousemove',
    '2',
    '4',
    'mouseup',
    '1',
  ]);
  assert.deepEqual(nativeInput({ type: 'key', key: 'ControlOrMeta+A' }), [
    'key',
    '--clearmodifiers',
    'ctrl+a',
  ]);
  assert.throws(() => nativeInput({ type: 'click', x: 1280, y: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => nativeInput({ type: 'key', key: 'Return; touch /tmp/unsafe' }), {
    code: 'INVALID_INPUT',
  });
  assert.throws(() => nativeInput({ type: 'text', text: '\0' }), { code: 'INVALID_INPUT' });
});
