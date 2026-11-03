import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
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
  await expect(
    Reflect.apply(desktop.input, desktop, [
      'a',
      human.epoch,
      { type: 'key', key: 'Enter' },
      'mock-screen-a',
    ]),
  ).rejects.toMatchObject({ code: 'DESKTOP_VIEW_STALE' });
  await expect(
    Reflect.apply(desktop.openApp, desktop, ['a', human.epoch, 'terminal', 'mock-screen-a']),
  ).rejects.toMatchObject({ code: 'DESKTOP_VIEW_STALE' });
  await expect(
    Reflect.apply(desktop.transfer, desktop, ['a', human.epoch, 'agent', 'mock-screen-a']),
  ).rejects.toMatchObject({ code: 'DESKTOP_VIEW_STALE' });
  expect(effects).toStrictEqual([]);
  expect(control.state('a').owner).toBe('human');
  expect(control.state('b').epoch).toBe(0);
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
  const rejected = expect(
    Reflect.apply(desktop.input, desktop, [
      'a',
      human.epoch,
      { type: 'text', text: 'NEVER-TYPE' },
      'mock-screen-a',
    ]),
  ).rejects.toMatchObject({ code: 'DESKTOP_VIEW_STALE' });
  instances.set('a', 'mock-replacement-a');
  release();
  await busy;
  await rejected;
  expect(effects).toStrictEqual([]);
});

test('a native frame captured before screen replacement is discarded instead of returned as the new screen', async () => {
  const { desktop, instances, screens } = syntheticDesktop();
  let release!: (image: Buffer) => unknown;
  screens.frame = () =>
    new Promise<Buffer>((resolve) => {
      release = resolve;
    });
  const pending = Reflect.apply(desktop.frame, desktop, ['a', 'mock-screen-a', 0]);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DESKTOP_VIEW_STALE' });
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
    expect(reads).toBe(2);
  } finally {
    release(Buffer.from('SYNTHETIC-OLD-FRAME'));
  }
  await expect(old).rejects.toMatchObject({ code: 'DESKTOP_VIEW_STALE' });
  expect((await fresh).toString()).toBe('SYNTHETIC-NEW-FRAME');
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
    expect(reads).toBe(2);
  } finally {
    release(Buffer.from('SYNTHETIC-BEFORE-ACTION'));
  }
  await before;
  expect((await after).toString()).toBe('SYNTHETIC-AFTER-ACTION');
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
  expect(() => screens.instance('a')).toThrowError(
    expect.objectContaining({ code: 'COMPUTER_NOT_CONNECTED' }),
  );
  expect(() => screens.screen('a')).toThrowError(
    expect.objectContaining({ code: 'COMPUTER_NOT_CONNECTED' }),
  );
});

test('starting a retired native driver fails before rewriting any successor configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-boot-'));
  const screens = new Screens({
    dir: root,
    origin: 'http://127.0.0.1:12345',
    displayBase: 41,
  });
  vi.spyOn(screens, 'run').mockImplementation(async () => {
    throw new Error('synthetic unexpected GUI boot');
  });
  try {
    await screens.close();
    await expect(screens.start()).rejects.toMatchObject({ code: 'COMPUTER_NOT_CONNECTED' });
  } finally {
    await screens.log?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a scoped native stack uses its logical Bot ID rather than allocating the legacy pair', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-single-screen-'));
  vi.spyOn(DesktopSandbox.prototype, 'start').mockImplementation(async () => {});
  vi.spyOn(DesktopSandbox.prototype, 'io').mockImplementation(async () => '');
  const screens = new Screens({
    dir: root,
    origin: 'http://127.0.0.1:12345',
    displayBase: 61,
  });
  vi.spyOn(screens, 'run').mockImplementation(async () => {
    throw Object.assign(new Error('synthetic boundary'), { code: 'SYNTHETIC_BOUNDARY' });
  });
  try {
    await expect(
      Reflect.apply(screens.start, screens, [['mock-custom-bot']]),
    ).rejects.toMatchObject({
      code: 'SYNTHETIC_BOUNDARY',
    });
    expect([...screens.bots.keys()]).toStrictEqual(['mock-custom-bot']);
    expect(screens.screen('mock-custom-bot').display).toBe(':61');
  } finally {
    await screens.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unconfirmed native teardown fails closed and may retry cleanup without re-enabling the driver', {
  timeout: 10000,
}, async () => {
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
  const signals: (number | string | undefined)[] = [];
  vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: number | string) => {
    signals.push(signal);
    if (allowExit) {
      processState.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    }
    return true;
  });
  await expect(screens.close()).rejects.toMatchObject({ code: 'COMPUTER_STOP_UNCONFIRMED' });
  expect(screens.closed).toBe(true);
  expect.assert(signals.includes('SIGKILL'));
  allowExit = true;
  await screens.close();
  expect.assert(child.signalCode);
  expect(() => screens.screen('mock-custom-bot')).toThrowError(
    expect.objectContaining({ code: 'COMPUTER_NOT_CONNECTED' }),
  );
});

test('native input preserves target display routing and validates coordinates and keys', () => {
  expect(nativeInput({ type: 'release' })).toStrictEqual([
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
  expect(nativeInput({ type: 'click', x: 123, y: 45, button: 3 })).toStrictEqual([
    'mousemove',
    '123',
    '45',
    'click',
    '3',
  ]);
  expect(nativeInput({ type: 'pointer', phase: 'down', x: 2, y: 4, button: 1 })).toStrictEqual([
    'mousemove',
    '2',
    '4',
    'mousedown',
    '1',
  ]);
  expect(nativeInput({ type: 'pointer', phase: 'up', x: 2, y: 4, button: 1 })).toStrictEqual([
    'mousemove',
    '2',
    '4',
    'mouseup',
    '1',
  ]);
  expect(nativeInput({ type: 'key', key: 'ControlOrMeta+A' })).toStrictEqual([
    'key',
    '--clearmodifiers',
    'ctrl+a',
  ]);
  expect(() => nativeInput({ type: 'click', x: 1280, y: 0 })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
  expect(() => nativeInput({ type: 'key', key: 'Return; touch /tmp/unsafe' })).toThrowError(
    expect.objectContaining({
      code: 'INVALID_INPUT',
    }),
  );
  expect(() => nativeInput({ type: 'text', text: '\0' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
});
