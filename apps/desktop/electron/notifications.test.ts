import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disconnected } from '@daban/protocol';
import { expect, it, vi } from 'vitest';
import type { NoticeActivation } from '../shared/notifications';

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

function mockNoticeSnapshot() {
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 32;
  snapshot.notices = { available: true, items: [] };
  snapshot.profiles = ['mock-alpha', 'mock-beta'].map((id) => ({
    id,
    name: id,
    instructions: '',
    memory: '',
    color: 'mint' as const,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
  return snapshot;
}

it('retains corrupt scoped preferences and rejects duplicate, malformed or injected entries', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-corrupt-bots-'));
  const row = { scope: 'a'.repeat(64), bot: 'mock-alpha' };
  try {
    const invalid = [
      [row, row],
      [{ ...row, scope: 'bad' }],
      [{ ...row, bot: '../mock' }],
      [{ ...row, script: 'SYNTHETIC INJECTION' }],
    ];
    for (const [index, muted] of invalid.entries()) {
      const file = path.join(root, `mock-${index}.json`);
      const bytes = JSON.stringify({ version: 2, enabled: false, revision: 0, records: [], muted });
      await fs.writeFile(file, bytes);
      const owner = new Notifications(file, {
        foreground: () => false,
        open: () => {},
        changed: () => {},
      });
      try {
        expect((await owner.status()).available).toBe(false);
        expect(await fs.readFile(file, 'utf8')).toBe(bytes);
        await expect(owner.configure(0, true)).rejects.toThrow('NOTIFICATION_STORE_UNAVAILABLE');
      } finally {
        await owner.close();
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retains bounded saved choices when an additional mute would exceed capacity', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-choice-limit-'));
  const file = path.join(root, 'notifications.json');
  const bytes = JSON.stringify({
    version: 2,
    enabled: false,
    revision: 0,
    records: [],
    muted: Array.from({ length: 1024 }, (_, index) => ({
      scope: 'b'.repeat(64),
      bot: `mock-${index}`,
    })),
  });
  await fs.writeFile(file, bytes);
  const owner = new Notifications(file, {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  try {
    await owner.observe(mockNoticeSnapshot(), 'a'.repeat(64));
    await expect(
      owner.invoke({
        type: 'bot.configure',
        revision: 0,
        scope: 'a'.repeat(64),
        bot: 'mock-alpha',
        enabled: false,
      }),
    ).rejects.toThrow('NOTIFICATION_LIMIT');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    expect((await owner.status()).enabled).toBe(false);
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('keeps a known OS delivery failure visible when an unrelated Bot preference is saved', async () => {
  mock.native.length = 0;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-failure-'));
  const owner = new Notifications(path.join(root, 'notifications.json'), {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  const scope = 'a'.repeat(64);
  try {
    await owner.configure(0, true);
    await owner.observe(mockNoticeSnapshot(), scope);
    await owner.test();
    mock.native.at(-1)!.emit('failed');
    await owner.invoke({
      type: 'bot.configure',
      revision: 1,
      scope,
      bot: 'mock-alpha',
      enabled: false,
    });
    expect((await owner.status()).error).toBe('NOTIFICATION_DELIVERY_FAILED');
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('does not let an earlier queued snapshot re-enable Bot settings after disconnection', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-disconnect-'));
  const owner = new Notifications(path.join(root, 'notifications.json'), {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  try {
    await owner.ready;
    const oldObservation = owner.observe(mockNoticeSnapshot(), 'a'.repeat(64));
    await owner.observe(disconnected('offline'), undefined);
    await oldObservation;
    expect((await owner.status()).runtime).toBe('offline');
    expect((await owner.status()).scope).toBeUndefined();
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('keeps per-Bot private choices independent of global opt-in, VM scope, lifecycle and restart', async () => {
  mock.native.length = 0;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-bots-'));
  const file = path.join(root, 'notifications.json');
  const options = { foreground: () => false, open: () => {}, changed: () => {} };
  let owner = new Notifications(file, options);
  const snapshot = mockNoticeSnapshot(),
    scope = 'a'.repeat(64);
  const configure = async (enabled: boolean, bot = 'mock-alpha', targetScope = scope) =>
    owner.invoke({
      type: 'bot.configure',
      revision: (await owner.status()).revision,
      scope: targetScope,
      bot,
      enabled,
    });
  try {
    await owner.observe(snapshot, scope);
    expect((await owner.status()).bots).toEqual([
      { id: 'mock-alpha', name: 'mock-alpha', enabled: true },
      { id: 'mock-beta', name: 'mock-beta', enabled: true },
    ]);
    await configure(false);
    expect((await owner.status()).enabled).toBe(false);
    expect((await owner.status()).bots?.[0].enabled).toBe(false);
    expect(mock.native).toHaveLength(0);
    const saved = await fs.readFile(file, 'utf8');
    await configure(false);
    expect(await fs.readFile(file, 'utf8')).toBe(saved);
    await expect(
      owner.invoke({ type: 'bot.configure', revision: 0, scope, bot: 'mock-alpha', enabled: true }),
    ).rejects.toThrow('NOTIFICATION_CONFLICT');
    await expect(configure(false, 'mock-ghost')).rejects.toThrow('NOTIFICATION_BOT_UNAVAILABLE');
    await expect(configure(false, 'mock-alpha', 'b'.repeat(64))).rejects.toThrow(
      'NOTIFICATION_SCOPE_CHANGED',
    );
    await owner.observe(snapshot, 'b'.repeat(64));
    expect((await owner.status()).bots?.[0].enabled).toBe(true);
    await owner.observe(snapshot, scope);
    expect((await owner.status()).bots?.[0].enabled).toBe(false);
    snapshot.profiles[0].archived = true;
    await owner.observe(snapshot, scope);
    expect((await owner.status()).bots?.map((bot) => bot.id)).toEqual(['mock-beta']);
    await expect(configure(true)).rejects.toThrow('NOTIFICATION_BOT_UNAVAILABLE');
    snapshot.profiles[0].archived = false;
    await owner.observe(snapshot, scope);
    await owner.close();
    owner = new Notifications(file, options);
    await owner.observe(snapshot, scope);
    expect((await owner.status()).bots?.[0].enabled).toBe(false);
    await owner.observe(disconnected('offline'), undefined);
    expect((await owner.status()).scope).toBeUndefined();
    await expect(configure(true)).rejects.toThrow('NOTIFICATION_SCOPE_CHANGED');
    expect((await owner.status()).bots?.[0].enabled).toBe(false);
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('suppresses only muted private results and requests, retains group notices, and never replays on re-enable', async () => {
  mock.native.length = 0;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-private-'));
  const owner = new Notifications(path.join(root, 'notifications.json'), {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  const snapshot = mockNoticeSnapshot(),
    scope = 'a'.repeat(64);
  try {
    await owner.configure(0, true);
    await owner.observe(snapshot, scope);
    await owner.invoke({
      type: 'bot.configure',
      revision: 1,
      scope,
      bot: 'mock-alpha',
      enabled: false,
    });
    snapshot.notices!.items = [
      {
        kind: 'task',
        id: 'mock-private-a',
        bot: 'mock-alpha',
        chatRevision: 0,
        phase: 'completed',
      },
      { kind: 'task', id: 'mock-private-b', bot: 'mock-beta', chatRevision: 0, phase: 'failed' },
      { kind: 'group', id: 'mock-group-result', group: 'mock-group', phase: 'completed' },
    ];
    const question = {
      id: 'mock-private-question',
      bot: 'mock-alpha',
      runId: 'mock-run',
      kind: 'question' as const,
      status: 'pending' as const,
      sessionId: 'mock-session',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      questions: [
        { id: 'mock-q', header: 'SYNTHETIC', question: 'SYNTHETIC QUESTION', options: [] },
      ],
    };
    snapshot.interactions = [
      question,
      { ...question, id: 'mock-group-question', conversationId: 'mock-group' },
    ];
    await owner.observe(snapshot, scope);
    expect(mock.native).toHaveLength(3);
    expect(mock.native.map((item) => item.options.title)).toEqual([
      'Daban · 任务需要检查',
      'Daban · 协作已完成',
      'Daban · 需要你的回答',
    ]);
    await owner.invoke({
      type: 'bot.configure',
      revision: 2,
      scope,
      bot: 'mock-alpha',
      enabled: true,
    });
    await owner.observe(snapshot, scope);
    expect(mock.native).toHaveLength(3);
    snapshot.notices!.items.push({
      kind: 'task',
      id: 'mock-new-a',
      bot: 'mock-alpha',
      chatRevision: 0,
      phase: 'completed',
    });
    await owner.observe(snapshot, scope);
    expect(mock.native).toHaveLength(4);
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('retires shown and pending private notices on mute and ignores their late native callbacks', async () => {
  mock.native.length = 0;
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-retire-'));
  const file = path.join(root, 'notifications.json'),
    opened: NoticeActivation[] = [];
  const owner = new Notifications(file, {
    foreground: () => false,
    open: (value) => opened.push(value),
    changed: () => {},
  });
  const snapshot = mockNoticeSnapshot(),
    scope = 'a'.repeat(64);
  try {
    await owner.configure(0, true);
    await owner.observe(snapshot, scope);
    snapshot.notices!.items = [
      { kind: 'task', id: 'mock-old-one', bot: 'mock-alpha', chatRevision: 0, phase: 'completed' },
      { kind: 'task', id: 'mock-old-two', bot: 'mock-alpha', chatRevision: 0, phase: 'completed' },
      { kind: 'group', id: 'mock-group-one', group: 'mock-group', phase: 'completed' },
    ];
    await owner.observe(snapshot, scope);
    await owner.activate(mock.native[0].id);
    expect(await owner.pending()).toBeDefined();
    await owner.invoke({
      type: 'bot.configure',
      revision: 1,
      scope,
      bot: 'mock-alpha',
      enabled: false,
    });
    expect(await owner.pending()).toBeUndefined();
    expect(
      JSON.parse(await fs.readFile(file, 'utf8')).records.map(
        (row: NoticeActivation) => row.target.kind,
      ),
    ).toEqual(['group']);
    expect(mock.native[1].close).toHaveBeenCalled();
    mock.native[1].emit('click');
    await owner.status();
    expect(opened).toHaveLength(1);
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('reads legacy notification preferences without rewriting and preserves records on the first scoped mutation', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mock-notice-legacy-'));
  const file = path.join(root, 'notifications.json'),
    scope = 'a'.repeat(64);
  const record: NoticeActivation = { id: 'mock-legacy', scope, target: { kind: 'settings' } };
  const bytes = JSON.stringify({ version: 1, enabled: true, revision: 4, records: [record] });
  await fs.writeFile(file, bytes);
  const owner = new Notifications(file, {
    foreground: () => false,
    open: () => {},
    changed: () => {},
  });
  try {
    await owner.status();
    await owner.observe(mockNoticeSnapshot(), scope);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    await owner.invoke({
      type: 'bot.configure',
      revision: 4,
      scope,
      bot: 'mock-alpha',
      enabled: false,
    });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.records).toEqual([record]);
    expect(saved.muted).toEqual([{ scope, bot: 'mock-alpha' }]);
    expect(saved.enabled).toBe(true);
  } finally {
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
