import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disconnected } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import type { NoticeActivation } from '../notifications';

const mock = vi.hoisted(() => ({
  native: [] as {
    id: string;
    options: Record<string, unknown>;
    show: () => unknown;
    close: () => unknown;
    emit: (event: string) => unknown;
  }[],
  supported: true,
  historyGate: undefined as Promise<unknown> | undefined,
  historyCalled: () => {},
}));
vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    static isSupported() {
      return mock.supported;
    }
    static async getHistory() {
      mock.historyCalled();
      await mock.historyGate;
      return [];
    }
    id: string;
    constructor(readonly options: Record<string, unknown>) {
      super();
      this.id = String(options.id);
      mock.native.push(this);
    }
    show = vi.fn(() => this.emit('show'));
    close = vi.fn(() => this.emit('close'));
  },
}));

import { Notifications } from './notifications';

it('persists opt-in, seeds old results, suppresses foreground events, deduplicates background changes and opens only checked targets', async () => {
  mock.native.length = 0;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notifications-'));
  let focused = false;
  const opened: NoticeActivation[] = [];
  const options = {
    foreground: () => focused,
    open: (value: NoticeActivation) => opened.push(value),
    changed: () => {},
  };
  let notices = new Notifications(path.join(root, 'notifications.json'), options);
  const scope = 'a'.repeat(64);
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 30;
  const item = {
    kind: 'task' as const,
    id: 'mock-before',
    bot: 'mock-alpha',
    chatRevision: 0,
    phase: 'completed' as const,
  };
  snapshot.notices = { available: true, items: [item] };
  try {
    expect((await notices.status()).enabled).toBe(false);
    await notices.configure(0, true);
    await notices.observe(snapshot, scope);
    expect(mock.native).toHaveLength(0);
    focused = true;
    snapshot.notices.items.push({ ...item, id: 'mock-foreground' });
    await notices.observe(snapshot, scope);
    expect(mock.native).toHaveLength(0);
    focused = false;
    snapshot.notices.items.push({ ...item, id: 'mock-background' });
    await notices.observe(snapshot, scope);
    expect(mock.native).toHaveLength(1);
    await notices.observe(snapshot, scope);
    expect(mock.native).toHaveLength(1);
    expect(mock.native[0].options.body).not.toContain('mock-alpha');
    mock.native[0].emit('click');
    await notices.status();
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toEqual({ ...item, id: 'mock-background' });
    expect(await notices.pending()).toEqual(opened[0]);
    await notices.ack('mock-wrong');
    expect(await notices.pending()).toEqual(opened[0]);
    await notices.ack(opened[0].id);
    expect(await notices.pending()).toBeUndefined();
    await notices.close();
    notices = new Notifications(path.join(root, 'notifications.json'), options);
    expect((await notices.status()).enabled).toBe(true);
    await notices.observe(snapshot, scope);
    expect(mock.native).toHaveLength(1);
    await expect(notices.configure(0, false)).rejects.toThrow('NOTIFICATION_CONFLICT');
    await notices.configure(1, false);
    expect((await notices.status()).enabled).toBe(false);
  } finally {
    await notices.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('fails closed on corrupt or externally changed preferences and never treats OS submission as proven delivery', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notification-io-'));
  const file = path.join(root, 'notifications.json');
  const owner = new Notifications(file, {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  try {
    await owner.status();
    await fs.writeFile(file, 'SYNTHETIC EXTERNAL CHANGE');
    await expect(owner.configure(0, true)).rejects.toThrow('NOTIFICATION_CONFIG_CHANGED');
    expect(await fs.readFile(file, 'utf8')).toBe('SYNTHETIC EXTERNAL CHANGE');
    await owner.close();
    const damaged = new Notifications(file, {
      foreground: () => false,
      open: () => {},
      changed: () => {},
    });
    expect((await damaged.status()).available).toBe(false);
    await damaged.close();
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('holds a cold activation until its exact VM is ready and emits it on the first ready snapshot', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notification-cold-'));
  const scope = 'a'.repeat(64),
    id = 'mock-cold-notice';
  const activation: NoticeActivation = {
    id,
    scope,
    target: {
      kind: 'task',
      id: 'mock-old-run',
      bot: 'mock-alpha',
      chatRevision: 0,
      phase: 'completed',
    },
  };
  const file = path.join(root, 'notifications.json');
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, enabled: true, revision: 1, records: [activation] }),
  );
  const messages: unknown[] = [];
  const owner = new Notifications(file, {
    foreground: () => false,
    open: () => {},
    changed: (value) => messages.push(value),
  });
  try {
    await owner.activate(id);
    expect(await owner.pending()).toBeUndefined();
    const snapshot = disconnected('ready');
    snapshot.notices = { available: true, items: [] };
    await owner.observe(snapshot, scope);
    expect(messages).toContainEqual({ type: 'navigate', activation });
    expect(await owner.pending()).toEqual(activation);
    await owner.observe(snapshot, 'b'.repeat(64));
    expect(await owner.pending()).toBeUndefined();
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('waits for an in-flight native history read before disposing its owner', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notification-close-'));
  const file = path.join(root, 'notifications.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, enabled: true, revision: 1, records: [] }));
  let release = () => {};
  mock.historyGate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const entered = new Promise((resolve) => {
    mock.historyCalled = () => resolve(undefined);
  });
  const owner = new Notifications(file, {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  try {
    await entered;
    let done = false;
    const closing = owner.close().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(() => resolve(undefined), 0));
    expect(done).toBe(false);
    release();
    await closing;
    expect((await owner.status()).available).toBe(false);
  } finally {
    release();
    mock.historyGate = undefined;
    mock.historyCalled = () => {};
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('reports a native test as submitted and surfaces a later OS failure without inventing permission or delivery', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notification-delivery-'));
  const owner = new Notifications(path.join(root, 'notifications.json'), {
    foreground: () => true,
    open: () => {},
    changed: () => {},
  });
  try {
    await owner.configure(0, true);
    expect((await owner.test()).delivery).toBe('submitted');
    mock.native.at(-1)!.emit('failed');
    const status = await owner.status();
    expect(status.delivery).toBe('failed');
    expect(status.error).toBe('NOTIFICATION_DELIVERY_FAILED');
    expect(status.available).toBe(true);
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
