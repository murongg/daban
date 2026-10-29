import { diagnosticIds, disconnected, type RuntimeSnapshot } from '@daban/protocol';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: [] as { webContents: { send: (...args: unknown[]) => unknown; mainFrame: unknown } }[],
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  load: vi.fn(),
  setupStatus: vi.fn(),
  setupStart: vi.fn(),
  setupCancel: vi.fn(),
  setupClose: vi.fn(),
  setupNotify: (_value: unknown) => {},
  openExternal: vi.fn(async () => undefined),
  writeClipboard: vi.fn(),
}));
vi.mock('electron', () => ({
  clipboard: { writeText: mocks.writeClipboard },
  shell: { openExternal: mocks.openExternal },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, callback),
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
}));
vi.mock('./setup', () => ({
  Setup: class {
    constructor(options: { onChange: (value: unknown) => unknown }) {
      mocks.setupNotify = options.onChange;
    }
    status() {
      return mocks.setupStatus();
    }
    start() {
      return mocks.setupStart();
    }
    cancel() {
      return mocks.setupCancel();
    }
    close() {
      return mocks.setupClose();
    }
  },
}));
vi.mock('./host', () => ({
  loadHost: async (...args: unknown[]) => ({
    recoveryStatus: async () => ({ available: true, revision: 0, busy: false, vm: 'unknown' }),
    abort: () => undefined,
    ...(await mocks.load(...args)),
  }),
}));

import { runtimeService } from './service';

afterEach(() => {
  vi.useRealTimers();
  mocks.handlers.clear();
  mocks.windows.length = 0;
});
const task = {
  phase: 'running' as const,
  running: true,
  runId: 'mock-new',
  requestId: 'mock-request',
  prompt: '合成任务',
  result: '',
  error: '',
  files: [],
  toolCount: 0,
  executedCount: 0,
  trace: [],
  history: [],
};
it('publishes a stable VM-scoped observation to desktop-local services without exposing config paths', async () => {
  const observations: { phase: string; scope?: string }[] = [];
  const client = {
    status: vi.fn(async () => disconnected('ready')),
    invoke: vi.fn(),
    releaseInputs: vi.fn(),
  };
  mocks.load.mockResolvedValue({
    config: {
      limactl: '/mock/limactl',
      limaHome: '/mock/private-home',
      vm: 'mock-vm',
      port: 18766,
    },
    connect: vi.fn(async () => client),
    close: vi.fn(),
  });
  const owner = runtimeService(
    '/mock/user',
    'file:///mock/index.html',
    '/mock/resources',
    async (snapshot: RuntimeSnapshot, scope?: string) => {
      observations.push({ phase: snapshot.phase, scope });
    },
  );
  try {
    await owner.connect();
    const ready = observations.find((value) => value.phase === 'ready');
    expect(ready?.scope).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(observations)).not.toContain('/mock/private-home');
  } finally {
    await owner.close();
  }
});
it('blocks effectful IPC while host recovery is uncertain but keeps owned file reads available', async () => {
  const frame = { url: 'file:///mock/index.html' },
    sender = { mainFrame: {}, send: vi.fn() };
  sender.mainFrame = frame;
  mocks.windows.push({ webContents: sender });
  const client = {
    status: vi.fn(async () => disconnected('ready')),
    invoke: vi.fn(async () => []),
    releaseInputs: vi.fn(),
  };
  const host = {
    connect: vi.fn(async () => client),
    recoveryStatus: vi.fn(async () => ({
      available: false,
      error: 'RECOVERY_HOST_STORE_UNAVAILABLE',
    })),
    close: vi.fn(),
  };
  mocks.load.mockResolvedValue(host);
  const service = runtimeService('/mock/fenced', frame.url);
  try {
    await service.connect();
    const handler = mocks.handlers.get('daban:runtime')!;
    expect(
      await handler(
        { sender, senderFrame: frame },
        {
          type: 'task.start',
          bot: 'mock-a',
          task: { requestId: 'mock-blocked', prompt: '合成不得执行' },
        },
      ),
    ).toEqual({ ok: false, error: 'RUNTIME_RECOVERY_PENDING' });
    expect(await handler({ sender, senderFrame: frame }, { type: 'files.list' })).toEqual({
      ok: true,
      value: [],
    });
    expect(client.invoke).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
  }
});
it('routes recovery through its owned Host, publishes host receipts and aborts advancement before input cleanup on quit', async () => {
  const frame = { url: 'file:///mock/index.html' },
    sender = { mainFrame: {}, send: vi.fn() };
  sender.mainFrame = frame;
  mocks.windows.push({ webContents: sender });
  const snapshot = disconnected('ready');
  const order: string[] = [];
  const client = {
    status: vi.fn(async () => snapshot),
    invoke: vi.fn(),
    releaseInputs: vi.fn(async () => {
      order.push('inputs');
    }),
  };
  const host = {
    connection: client,
    connect: vi.fn(async () => client),
    recoveryStatus: vi.fn(async () => ({
      available: true,
      revision: 0,
      busy: false,
      vm: 'unknown',
    })),
    abort: vi.fn(() => order.push('abort')),
    close: vi.fn(async () => {
      order.push('close');
    }),
  };
  mocks.load.mockResolvedValue(host);
  const service = runtimeService('/mock/recovery-data', frame.url);
  try {
    await service.connect();
    const result = await mocks.handlers.get('daban:runtime')!(
      { sender, senderFrame: frame },
      { type: 'recovery.status' },
    );
    expect(result).toMatchObject({ ok: true, value: { available: true, revision: 0 } });
    expect(client.invoke).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
  expect(order).toEqual(['abort', 'inputs', 'close']);
});
it('allows a read-only host inspection before connection without starting the VM or refreshing tasks', async () => {
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const report = {
    scope: 'host',
    checkedAt: '2026-01-01T00:00:00.000Z',
    checks: [...diagnosticIds.host, ...diagnosticIds.runtime].map((id) => ({
      id,
      state: 'unchecked',
    })),
  };
  const host = { inspect: vi.fn(async () => report), connect: vi.fn(), close: vi.fn() };
  mocks.load.mockResolvedValue(host);
  const service = runtimeService('/mock/data', frame.url);
  try {
    const value = await mocks.handlers.get('daban:runtime')!(
      { sender, senderFrame: frame },
      { type: 'runtime.inspect' },
    );
    expect(value).toEqual({ ok: true, value: report });
    expect(host.inspect).toHaveBeenCalledTimes(1);
    expect(host.connect).not.toHaveBeenCalled();
  } finally {
    await service.close();
  }
});
it('shares a loading host with inspection and closes a late owner before it can start anything', async () => {
  mocks.load.mockClear();
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  let release: (value: unknown) => unknown = () => undefined;
  mocks.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const host = { inspect: vi.fn(), connect: vi.fn(), close: vi.fn(async () => undefined) };
  const service = runtimeService('/mock/data', frame.url);
  const handler = mocks.handlers.get('daban:runtime')!;
  const inspection = handler({ sender, senderFrame: frame }, { type: 'runtime.inspect' });
  const connection = service.connect();
  expect(mocks.load).toHaveBeenCalledTimes(1);
  const closing = service.close();
  release(host);
  await Promise.all([inspection, connection, closing]);
  expect(host.connect).not.toHaveBeenCalled();
  expect(host.inspect).not.toHaveBeenCalled();
  expect(host.close).toHaveBeenCalledTimes(1);
});
it('writes bounded clipboard text only from the owned renderer and exposes no clipboard read', async () => {
  const frame = { url: 'file:///mock/index.html' },
    sender = { mainFrame: { url: 'file:///mock/index.html' }, send: vi.fn() };
  sender.mainFrame = frame;
  mocks.windows.push({ webContents: sender });
  mocks.writeClipboard.mockClear();
  const service = runtimeService('/mock/data', frame.url);
  const handler = mocks.handlers.get('daban:runtime')!;
  try {
    expect(
      await handler({ sender, senderFrame: frame }, { type: 'clipboard.write', text: '  mock\n' }),
    ).toEqual({ ok: true, value: { copied: true } });
    expect(mocks.writeClipboard).toHaveBeenCalledWith('  mock\n');
    for (const command of [
      { type: 'clipboard.read' },
      { type: 'clipboard.write', text: 'x'.repeat(65537) },
      { type: 'clipboard.write', text: 'x\0y' },
    ])
      expect(await handler({ sender, senderFrame: frame }, command)).toEqual({
        ok: false,
        error: 'INVALID_COMMAND',
      });
    expect(mocks.writeClipboard).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
  }
});
it('opens only a validated user-clicked web link from an owned renderer without requiring a VM', async () => {
  const frame = { url: 'file:///mock/index.html' },
    sender = { mainFrame: { url: 'file:///mock/index.html' }, send: vi.fn() };
  sender.mainFrame = frame;
  mocks.windows.push({ webContents: sender });
  mocks.openExternal.mockClear();
  const service = runtimeService('/mock/data', frame.url);
  const handler = mocks.handlers.get('daban:runtime')!;
  try {
    expect(
      await handler(
        { sender, senderFrame: frame },
        { type: 'link.open', url: 'https://example.test/page' },
      ),
    ).toEqual({ ok: true, value: { opened: true } });
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.test/page');
    for (const url of [
      'file:///private/key',
      'javascript:alert(1)',
      'data:text/html,x',
      'https://user:secret@example.test/',
      '../relative',
    ])
      expect(await handler({ sender, senderFrame: frame }, { type: 'link.open', url })).toEqual({
        ok: false,
        error: 'INVALID_COMMAND',
      });
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(
      await handler(
        { sender, senderFrame: { url: 'https://untrusted.test/' } },
        { type: 'link.open', url: 'https://example.test/' },
      ),
    ).toEqual({ ok: false, error: 'UNTRUSTED_SENDER' });
  } finally {
    await service.close();
  }
});
it('refreshes active replies promptly while backing off when no model task is running', async () => {
  vi.useFakeTimers();
  const snapshot = disconnected('ready');
  const status = vi.fn(async () => snapshot);
  mocks.load.mockResolvedValue({
    connect: async () => ({ status, invoke: vi.fn(), releaseInputs: vi.fn() }),
    close: vi.fn(),
  });
  const service = runtimeService('/mock/data', 'file:///mock/index.html');
  try {
    await service.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenCalledTimes(2);
    snapshot.agents.a = task;
    await vi.advanceTimersByTimeAsync(250);
    expect(status).toHaveBeenCalledTimes(3);
    snapshot.agents.a = { ...task, phase: 'waiting' };
    await vi.advanceTimersByTimeAsync(250);
    expect(status).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(750);
    expect(status).toHaveBeenCalledTimes(4);
  } finally {
    await service.close();
  }
});
it('a late poll cannot overwrite the snapshot fetched after accepting a new task', async () => {
  vi.useFakeTimers();
  const frame = { url: 'file:///mock/index.html' };
  const sent: RuntimeSnapshot[] = [];
  const sender = {
    mainFrame: frame,
    send: (_event: unknown, snapshot: unknown) => sent.push(snapshot as RuntimeSnapshot),
  };
  mocks.windows.push({ webContents: sender });
  const initial = disconnected('ready');
  initial.agents.a = { ...task, runId: 'mock-old', running: false, phase: 'completed' };
  let release: (snapshot: RuntimeSnapshot) => unknown = () => undefined;
  const waiting = new Promise<RuntimeSnapshot>((resolve) => {
    release = resolve;
  });
  const newer = { ...initial, agents: { a: task } };
  const status = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockReturnValueOnce(waiting)
    .mockResolvedValue(newer);
  mocks.load.mockResolvedValue({
    connect: async () => ({ status, invoke: vi.fn(async () => ({})), releaseInputs: vi.fn() }),
    close: vi.fn(),
  });
  const service = runtimeService('/mock/data', frame.url);
  try {
    await service.connect();
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await mocks.handlers.get('daban:runtime')!(
      { senderFrame: frame, sender },
      { type: 'task.start', bot: 'a', task: { requestId: 'mock-request', prompt: '合成任务' } },
    );
    release(initial);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)?.agents.a.runId).toBe('mock-new');
  } finally {
    await service.close();
  }
});

it('offers first-run setup only for absent configuration, admits narrow commands and connects after its committed completion', async () => {
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const available = { required: true, phase: 'available' };
  mocks.setupStatus.mockResolvedValue(available);
  mocks.setupStart.mockResolvedValue({ required: true, phase: 'verifying' });
  mocks.load.mockRejectedValueOnce(
    Object.assign(new Error('SYNTHETIC MISSING'), { code: 'ENOENT' }),
  );
  const client = { status: vi.fn(async () => disconnected('ready')), releaseInputs: vi.fn() };
  const host = { connect: vi.fn(async () => client), close: vi.fn() };
  const service = runtimeService('/mock/setup', frame.url, '/mock/resources');
  try {
    expect(await service.connect()).toMatchObject({ setup: available });
    expect(mocks.setupStart).not.toHaveBeenCalled();
    const invoke = mocks.handlers.get('daban:runtime')!;
    expect(
      await invoke(
        { sender, senderFrame: { url: 'https://untrusted.test/' } },
        { type: 'setup.start' },
      ),
    ).toMatchObject({ ok: false, error: 'UNTRUSTED_SENDER' });
    expect(
      await invoke(
        { sender, senderFrame: frame },
        { type: 'setup.start', path: '/mock/untrusted' },
      ),
    ).toMatchObject({ ok: false, error: 'INVALID_COMMAND' });
    expect(mocks.setupStart).not.toHaveBeenCalled();
    expect(await invoke({ sender, senderFrame: frame }, { type: 'setup.start' })).toMatchObject({
      ok: true,
      value: { phase: 'verifying' },
    });
    expect(mocks.setupStart).toHaveBeenCalledTimes(1);
    mocks.load.mockResolvedValue(host);
    mocks.setupNotify({ required: false, phase: 'complete' });
    await vi.waitFor(() => expect(host.connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(sender.send.mock.calls.at(-1)?.[1]).toMatchObject({
        phase: 'ready',
        setup: { phase: 'complete' },
      }),
    );
  } finally {
    await service.close();
  }
  expect(mocks.setupClose).toHaveBeenCalled();
});
