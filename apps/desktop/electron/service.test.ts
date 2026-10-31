import {
  diagnosticIds,
  disconnected,
  type RebootStatus,
  type RecoveryReview,
  type RuntimeCommand,
  type RuntimeSnapshot,
} from '@daban/protocol';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: [] as { webContents: { send: (...args: unknown[]) => unknown; mainFrame: unknown } }[],
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  load: vi.fn(),
  setupStatus: vi.fn(),
  setupConstruct: vi.fn(),
  setupStart: vi.fn(),
  setupCancel: vi.fn(),
  setupClose: vi.fn(),
  setupNotify: (_value: unknown) => {},
  openExternal: vi.fn(async () => undefined),
  writeClipboard: vi.fn(),
  daemonEnsure: vi.fn(),
  daemonClose: vi.fn(),
  daemonConfigs: [] as {
    dataRoot: string;
    socketPath: string;
    vmConfig: string;
    entry: string;
    executable: string;
  }[],
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
      mocks.setupConstruct();
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
vi.mock('./daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./daemon')>();
  return {
    ...actual,
    Daemon: class {
      readonly scope: string;
      constructor(
        readonly config: {
          dataRoot: string;
          socketPath: string;
          vmConfig: string;
          entry: string;
          executable: string;
        },
      ) {
        mocks.daemonConfigs.push(config);
        this.scope = actual.daemonScope(config.dataRoot, config.vmConfig);
      }
      ensure() {
        return mocks.daemonEnsure();
      }
      close() {
        return mocks.daemonClose();
      }
    },
  };
});

import { daemonScope } from './daemon';
import { runtimeService } from './service';

const roots = new Set<string>();
afterEach(async () => {
  vi.useRealTimers();
  mocks.handlers.clear();
  mocks.windows.length = 0;
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
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
it('keeps transcript reads local to their initiating connection and does not poll task state for each text chunk', async () => {
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const snapshot = disconnected('ready');
  snapshot.protocolVersion = 33;
  let release: (value: unknown) => unknown = () => undefined;
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const client = {
    status: vi.fn(async () => snapshot),
    invoke: vi.fn(async () => pending),
    releaseInputs: vi.fn(),
  };
  mocks.load.mockResolvedValue({
    connect: vi.fn(async () => client),
    close: vi.fn(),
    recoveryStatus: vi.fn(async () => ({
      available: true,
      revision: 0,
      busy: false,
      vm: 'unknown',
    })),
  });
  const service = runtimeService('/mock/transcript-owner', frame.url);
  const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
  try {
    await service.connect();
    const handler = mocks.handlers.get('daban:runtime')!;
    const reading = handler(
      { sender, senderFrame: frame },
      { type: 'transcript.list', query: { scope } },
    );
    await Promise.resolve();
    expect(client.invoke).toHaveBeenCalledTimes(1);
    await service.connect();
    release({ ...scope, state: 'complete', items: [] });
    expect(await reading).toEqual({ ok: false, error: 'RUNTIME_OFFLINE' });
    const polls = client.status.mock.calls.length;
    const content = { ...scope, seq: 1, offset: 0, total: 0, text: '' };
    client.invoke.mockResolvedValue(content);
    expect(
      await handler(
        { sender, senderFrame: frame },
        { type: 'transcript.content', query: { scope, seq: 1 } },
      ),
    ).toEqual({ ok: true, value: content });
    expect(client.status).toHaveBeenCalledTimes(polls);
  } finally {
    release(undefined);
    await service.close();
  }
});
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

import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function agentFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'mock-service-agent-'));
  roots.add(root);
  const dataRoot = join(root, 'data');
  const socketPath = join(root, 's');
  const vmConfig = join(root, 'runtime.json');
  await fs.mkdir(join(dataRoot, 'model'), { recursive: true, mode: 0o700 });
  await fs.chmod(dataRoot, 0o700);
  await fs.writeFile(join(dataRoot, 'model/control-token'), 'a'.repeat(64), { mode: 0o600 });
  await fs.writeFile(join(dataRoot, 'execution-token'), 'b'.repeat(64), { mode: 0o600 });
  await fs.writeFile(vmConfig, '{}', { mode: 0o600 });
  const entry = join(root, 'agent.js'),
    executable = join(root, 'node');
  await fs.writeFile(entry, 'SYNTHETIC AGENT ENTRY', { mode: 0o600 });
  await fs.writeFile(executable, 'SYNTHETIC HOST NODE', { mode: 0o700 });
  const requests: { route: string; auth?: string; body: string }[] = [];
  const identity = { role: 'agent', scope: daemonScope(dataRoot, vmConfig), dataRoot, socketPath };
  const review: RecoveryReview = {
    boot: 'mock-power-boot',
    instance: 'mock-power-instance',
    revision: 0,
    computersRevision: 0,
    digest: 'c'.repeat(64),
    screens: [],
    running: [],
    changing: false,
  };
  const power = {
    status: { available: true, revision: 0, busy: false, vm: 'running' } as RebootStatus,
    review,
    commands: [] as RuntimeCommand[],
    holdStatus: undefined as (() => Promise<RebootStatus>) | undefined,
  };
  let settings = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    configured: true,
    revision: 0,
  };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({
      route: request.url || '',
      auth: String(request.headers['x-prototype-token'] || ''),
      body,
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/host/recovery') {
      const command = JSON.parse(body) as RuntimeCommand;
      power.commands.push(command);
      if (command.type === 'recovery.status' && power.holdStatus) {
        const hold = power.holdStatus;
        power.holdStatus = undefined;
        response.end(JSON.stringify(await hold()));
        return;
      }
      if (command.type === 'recovery.review') response.end(JSON.stringify(power.review));
      else {
        if (command.type === 'recovery.restart')
          power.status = {
            available: true,
            revision: 1,
            busy: false,
            vm: 'running',
            operation: { id: command.request.id, stage: 'preparing', review },
          };
        response.end(JSON.stringify(power.status));
      }
    } else if (request.url === '/agent/identity') response.end(JSON.stringify(identity));
    else if (request.url === '/api/model/configure') {
      const input = JSON.parse(body);
      settings = { ...settings, model: input.model, revision: input.revision + 1 };
      response.end(JSON.stringify({ ...settings, requestId: input.requestId }));
    } else if (request.url === '/api/model/settings') response.end(JSON.stringify(settings));
    else if (request.url === '/api/state')
      response.end(
        JSON.stringify({
          clientProtocol: 17,
          mode: 'agent',
          computerError: 'COMPUTER_START_FAILED',
          sharedLogin: false,
          reboot: power.status,
          bots: {},
          model: {
            available: true,
            provider: 'deepseek-official',
            model: settings.model,
            bots: {},
          },
        }),
      );
    else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  server.listen(socketPath);
  await once(server, 'listening');
  await fs.chmod(socketPath, 0o600);
  mocks.daemonEnsure.mockReset().mockResolvedValue(undefined);
  mocks.daemonClose.mockReset().mockResolvedValue(undefined);
  mocks.daemonConfigs.length = 0;
  mocks.load.mockClear();
  mocks.setupConstruct.mockClear();
  mocks.setupStart.mockClear();
  return {
    root,
    dataRoot,
    requests,
    server,
    identity,
    power,
    config: {
      entry,
      executable,
      dataRoot,
      socketPath,
      vmConfig,
    },
    async close() {
      server.closeAllConnections();
      await new Promise<unknown>((done, reject) =>
        server.close((error) => (error ? reject(error) : done(undefined))),
      );
    },
  };
}

it('routes model settings through the host Unix agent and leaves the daemon running when the UI closes', async () => {
  const fixture = await agentFixture();
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const observed: { phase: string; scope?: string }[] = [];
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    async (snapshot, scope) => {
      observed.push({ phase: snapshot.phase, scope });
    },
    fixture.config,
  );
  try {
    expect((await service.connect()).phase).toBe('ready');
    const input = {
      model: 'deepseek-flash',
      apiKey: 'synthetic-host-settings-key',
      requestId: 'mock-host-settings',
      revision: 0,
    };
    expect(
      await mocks.handlers.get('daban:runtime')!(
        { sender, senderFrame: frame },
        { type: 'model.configure', input },
      ),
    ).toMatchObject({ ok: true, value: { revision: 1, requestId: input.requestId } });
    expect(
      fixture.requests.some(
        (request) =>
          request.route === '/api/model/configure' &&
          JSON.parse(request.body).apiKey === input.apiKey,
      ),
    ).toBe(true);
    expect(fixture.requests.every((request) => request.auth === 'a'.repeat(64))).toBe(true);
    expect(
      fixture.requests.some(
        (request) => request.route === '/' || request.route.startsWith('/exec'),
      ),
    ).toBe(false);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(observed.find((value) => value.phase === 'ready')?.scope).toMatch(/^[a-f0-9]{64}$/);
    await service.close();
    expect(mocks.daemonClose).toHaveBeenCalledTimes(1);
    expect(fixture.server.listening).toBe(true);
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await fixture.close();
  }
});

it('never falls back to guest APIs when an agent is configured but unavailable or its host token is missing', async () => {
  const fixture = await agentFixture();
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  mocks.daemonEnsure.mockRejectedValueOnce(new Error('AGENT_DAEMON_UNAVAILABLE'));
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  try {
    expect((await service.connect()).phase).toBe('offline');
    expect(mocks.load).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(0);
    expect(
      await mocks.handlers.get('daban:runtime')!(
        { sender, senderFrame: frame },
        { type: 'recovery.review' },
      ),
    ).toEqual({ ok: false, error: 'RUNTIME_OFFLINE' });
    await fs.unlink(join(fixture.dataRoot, 'model/control-token'));
    expect((await service.connect()).phase).toBe('offline');
    expect(fixture.requests).toHaveLength(0);
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await fixture.close();
  }
});

it('does not attach a late agent client after closing during daemon startup', async () => {
  const fixture = await agentFixture();
  let release: () => unknown = () => {};
  mocks.daemonEnsure.mockImplementationOnce(
    () =>
      new Promise<unknown>((done) => {
        release = () => done(undefined);
      }),
  );
  const service = runtimeService(
    fixture.root,
    'file:///mock/index.html',
    '/mock/resources',
    undefined,
    fixture.config,
  );
  try {
    const connecting = service.connect();
    await vi.waitFor(() => expect(mocks.daemonEnsure).toHaveBeenCalledTimes(1));
    await service.close();
    release();
    await connecting;
    expect(fixture.requests).toHaveLength(0);
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    release();
    await service.close();
    await fixture.close();
  }
});

it('creates first-run executor configuration through agent bootstrap without invoking legacy VM setup', async () => {
  const fixture = await agentFixture();
  await fs.unlink(fixture.config.vmConfig);
  const available = { required: true, phase: 'available' };
  mocks.setupStatus.mockResolvedValue(available);
  mocks.setupStart.mockResolvedValue({ required: true, phase: 'verifying' });
  mocks.daemonEnsure.mockImplementationOnce(async () => {
    await fs.writeFile(
      join(fixture.dataRoot, 'progress.json'),
      JSON.stringify({ required: true, phase: 'creating' }),
      { mode: 0o600 },
    );
    await fs.writeFile(fixture.config.vmConfig, '{}', { mode: 0o600 });
  });
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  try {
    expect(await service.connect()).toMatchObject({ phase: 'offline', setup: available });
    expect(mocks.daemonEnsure).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.setupConstruct).not.toHaveBeenCalled();
    expect(
      await mocks.handlers.get('daban:runtime')!(
        { sender, senderFrame: frame },
        { type: 'setup.start' },
      ),
    ).toMatchObject({ ok: true, value: { phase: 'verifying' } });
    await vi.waitFor(() => expect(mocks.daemonEnsure).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(sender.send.mock.calls.at(-1)?.[1]).toMatchObject({ phase: 'ready' }),
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.setupStart).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await fixture.close();
  }
});

it('does not automatically restart paused agent bootstrap after a partial configuration is written', async () => {
  const fixture = await agentFixture();
  await fs.unlink(fixture.config.vmConfig);
  let release: () => unknown = () => {};
  mocks.daemonEnsure.mockImplementationOnce(async () => {
    await fs.writeFile(fixture.config.vmConfig, '{"synthetic":"partial"}', { mode: 0o600 });
    await new Promise<unknown>((done) => {
      release = () => done(undefined);
    });
  });
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  const invoke = (type: 'setup.start' | 'setup.cancel') =>
    mocks.handlers.get('daban:runtime')!({ sender, senderFrame: frame }, { type });
  try {
    await service.connect();
    await invoke('setup.start');
    await vi.waitFor(() =>
      expect(fs.readFile(fixture.config.vmConfig, 'utf8')).resolves.toBe('{"synthetic":"partial"}'),
    );
    expect(await invoke('setup.cancel')).toMatchObject({
      ok: true,
      value: { required: true, phase: 'cancelled' },
    });
    expect(await service.connect()).toMatchObject({
      phase: 'offline',
      setup: { phase: 'cancelled' },
    });
    expect(mocks.daemonEnsure).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(join(fixture.dataRoot, 'cancel.json'), 'utf8'))).toEqual({
      cancelled: true,
    });
    expect(mocks.setupConstruct).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    release();
    await service.close();
    await fixture.close();
  }
});

it('inspects only an existing host agent and never starts a daemon or falls back to guest inspection', async () => {
  const fixture = await agentFixture();
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  try {
    const result = await mocks.handlers.get('daban:runtime')!(
      { sender, senderFrame: frame },
      { type: 'runtime.inspect' },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        scope: 'host',
        checks: expect.arrayContaining([
          { id: 'configuration', state: 'ready' },
          { id: 'agent', state: 'unavailable' },
        ]),
      },
    });
    expect(mocks.daemonEnsure).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(fixture.requests.map((request) => request.route)).toEqual([
      '/agent/identity',
      '/api/diagnostics',
    ]);
    expect(fixture.requests[0].auth).toBe('');
    expect(fixture.requests[1].auth).toBe('a'.repeat(64));
  } finally {
    await service.close();
    await fixture.close();
  }
});

it('withholds host authentication when read-only inspection finds another daemon scope', async () => {
  const fixture = await agentFixture();
  fixture.identity.scope = 'foreign-scope';
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  try {
    await mocks.handlers.get('daban:runtime')!(
      { sender, senderFrame: frame },
      { type: 'runtime.inspect' },
    );
    expect(fixture.requests.map((request) => request.route)).toEqual(['/agent/identity']);
    expect(fixture.requests[0].auth).toBe('');
    expect(mocks.daemonEnsure).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await fixture.close();
  }
});

it('forwards agent recovery to host authority and keeps pending power operations fenced across UI closure', async () => {
  const fixture = await agentFixture();
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  const invoke = (command: RuntimeCommand) =>
    mocks.handlers.get('daban:runtime')!({ sender, senderFrame: frame }, command);
  try {
    expect((await service.connect()).phase).toBe('ready');
    expect(await invoke({ type: 'recovery.review' })).toEqual({
      ok: true,
      value: fixture.power.review,
    });
    expect(await invoke({ type: 'recovery.status' })).toEqual({
      ok: true,
      value: fixture.power.status,
    });
    const request = {
      id: 'mock-agent-power',
      revision: 0,
      review: fixture.power.review.digest,
      confirmation: 'restart-all-apps' as const,
    };
    expect(await invoke({ type: 'recovery.restart', request })).toMatchObject({
      ok: true,
      value: { operation: { id: request.id, stage: 'preparing' } },
    });
    expect(
      await invoke({
        type: 'task.start',
        bot: 'mock-bot',
        task: { requestId: 'mock-blocked-power', prompt: 'Synthetic blocked task' },
      }),
    ).toEqual({ ok: false, error: 'RUNTIME_RECOVERY_PENDING' });
    expect(await invoke({ type: 'recovery.inspect', id: request.id })).toMatchObject({
      ok: true,
      value: { operation: { id: request.id } },
    });
    await service.close();
    expect(fixture.server.listening).toBe(true);
    expect(fixture.power.commands.filter((command) => command.type === 'recovery.restart')).toEqual(
      [{ type: 'recovery.restart', request }],
    );
    expect(
      fixture.power.commands.some((command) =>
        ['recovery.cancel', 'recovery.start'].includes(command.type),
      ),
    ).toBe(false);
    expect(mocks.load).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await fixture.close();
  }
});

it('a late host recovery poll cannot erase the newer accepted power intent', async () => {
  const fixture = await agentFixture();
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame, send: vi.fn() };
  mocks.windows.push({ webContents: sender });
  const service = runtimeService(
    fixture.root,
    frame.url,
    '/mock/resources',
    undefined,
    fixture.config,
  );
  const invoke = (command: RuntimeCommand) =>
    mocks.handlers.get('daban:runtime')!({ sender, senderFrame: frame }, command);
  let entered: () => unknown = () => {};
  let release: () => unknown = () => {};
  const waiting = new Promise<unknown>((done) => {
    entered = () => done(undefined);
  });
  try {
    await service.connect();
    const old = structuredClone(fixture.power.status);
    fixture.power.holdStatus = () => {
      entered();
      return new Promise((done) => {
        release = () => done(old);
      });
    };
    const polling = invoke({ type: 'recovery.status' });
    await waiting;
    const request = {
      id: 'mock-new-power',
      revision: 0,
      review: fixture.power.review.digest,
      confirmation: 'restart-all-apps' as const,
    };
    await invoke({ type: 'recovery.restart', request });
    release();
    await polling;
    expect(await invoke({ type: 'status' })).toMatchObject({
      ok: true,
      value: { reboot: { operation: { id: request.id, stage: 'preparing' } } },
    });
  } finally {
    release();
    await service.close();
    await fixture.close();
  }
});
