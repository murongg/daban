import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgent, type startNativeAgent } from '@daban/engine/agent';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  type ExecutionSnapshot,
  executionCapabilities,
  type RecoveryReceipt,
  type RecoveryReview,
} from '@daban/protocol';
import { expect, test } from 'vitest';
import { writeSetupRecord } from './bootstrap.js';
import { ExecutionConnection } from './connection.js';
import {
  agentScope,
  agentVmTarget,
  type MainDependencies,
  parseAgentArguments,
  runAgentCli,
  startAgentProcess,
} from './main.js';
import type { PowerOptions } from './power.js';
import { HostPower } from './power.js';
import { saveExecutionSnapshot } from './startup.js';

const snapshot: ExecutionSnapshot = {
  role: 'executor',
  version: 1,
  boot: 'mock-boot',
  nonce: 'mock-nonce',
  capabilities: [...executionCapabilities],
  computer: {
    mode: 'agent',
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
    environment: {
      platform: 'linux',
      arch: 'arm64',
      kernel: 'mock',
      node: 'mock-node',
      browser: 'mock-browser',
    },
    events: [],
    bots: {},
  },
  status: { available: true, limit: 2, revision: 0, items: [] },
};
const config = {
  limactl: '/mock/bin/limactl',
  limaHome: '/mock/private/lima',
  vm: 'mock-execution',
  port: 18766,
};

test('Windows setup receives its bundled image through a host-only absolute argument', () => {
  const options = parseAgentArguments([
    '--data',
    'mock-data',
    '--socket',
    'mock.sock',
    '--vm-config',
    'mock-vm.json',
    '--mode',
    'native',
    '--qemu-bundle',
    'mock-resources/qemu',
  ]);
  expect(options).toMatchObject({
    mode: 'native',
    qemuBundle: path.resolve('mock-resources/qemu'),
  });
});
const review: RecoveryReview = {
  boot: 'mock-boot',
  instance: 'mock-instance',
  revision: 4,
  computersRevision: 0,
  digest: 'a'.repeat(64),
  screens: [],
  running: [],
  changing: false,
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-agent-main-'));
  const options = {
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    vmConfigFile: path.join(root, 'runtime.json'),
  };
  const events: string[] = [];
  let powerOptions: PowerOptions | undefined;
  let coreOptions: Parameters<MainDependencies['core']>[0] | undefined;
  let connectionOptions: Parameters<MainDependencies['connection']>[1] | undefined;
  let claimed = false;
  let connected = true;
  const receipt: RecoveryReceipt = { id: 'mock-restart', phase: 'claimed', revision: 6, review };
  const link = {
    async ensure() {
      events.push('ensure');
      return { origin: 'http://127.0.0.1:12345', token: 'mock-guest-token' };
    },
    async reconnect() {
      events.push('reconnect');
      return { origin: 'http://127.0.0.1:12345', token: 'mock-guest-token' };
    },
    async state() {
      return 'stopped' as const;
    },
    async startVm() {
      events.push('vm-start');
      return { origin: 'http://127.0.0.1:12346', token: 'mock-start-token' };
    },
    async stopVm() {
      events.push('vm-stop');
    },
    async close() {
      events.push('link-close');
    },
  };
  const core = {
    recovery: {
      review: () => review,
      prepare: async () => receipt,
      claim: async (_id: string, revision: number) => {
        events.push(`claim:${revision}`);
        return receipt;
      },
      cancel: async (_id: string, revision: number) => {
        events.push(`cancel:${revision}`);
        return receipt;
      },
      receipt: () => receipt,
    },
    models: {
      jobs: new Map([
        ['mock-running', { bot: 'mock-running', running: true }],
        ['mock-idle', { bot: 'mock-idle', running: false }],
        ['mock-finalizing', { bot: 'mock-finalizing', running: false }],
      ]),
      running(bot: string) {
        return bot === 'mock-running' || bot === 'mock-finalizing';
      },
      async stop(bot: string) {
        events.push(`stop-model:${bot}`);
      },
    },
    async refreshExecution() {
      events.push('core-refresh');
      return snapshot;
    },
    async close() {
      events.push('core-close');
    },
  };
  const dependencies: MainDependencies = {
    tools: async () => {
      events.push('tools');
      return config.limactl;
    },
    bootstrap: async () => {
      events.push('bootstrap');
      return config;
    },
    link: () => link,
    connection: (_link, value) => {
      connectionOptions = value;
      connected = !value.attachOnly;
      return {
        ready: Promise.resolve(value.initialSnapshot || snapshot),
        get connected() {
          return connected;
        },
        snapshot,
        async refresh() {
          return snapshot;
        },
        async call<T>(method: string) {
          if (method === 'workspace.base') return '/mock-guest/workspace' as T;
          throw new Error('Mock remote call refused');
        },
        async rebind(value) {
          expect(value).toStrictEqual({
            origin: 'http://127.0.0.1:12346',
            token: 'mock-start-token',
          });
          events.push('rebind');
          connected = true;
          return snapshot;
        },
        async close() {
          events.push('connection-close');
          await link.close();
        },
      };
    },
    power: (value) => {
      powerOptions = value;
      return {
        ready: Promise.resolve(),
        status: () => ({
          available: true,
          revision: 1,
          busy: false,
          vm: 'stopped',
          ...(claimed
            ? { operation: { id: receipt.id, stage: 'stop-issued', review, backend: receipt } }
            : {}),
        }),
        handle: async () => review,
        async close() {
          events.push('power-close');
        },
      };
    },
    core: async (value) => {
      coreOptions = value;
      events.push('core');
      return core;
    },
    sdk: () => '/mock/private/sdk.js',
  };
  return {
    root,
    options,
    events,
    dependencies,
    get powerOptions() {
      return powerOptions!;
    },
    get coreOptions() {
      return coreOptions!;
    },
    get connectionOptions() {
      return connectionOptions!;
    },
    claim() {
      claimed = true;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('CLI parsing is closed and daemon scope uses the requested normalized paths', () => {
  const options = parseAgentArguments([
    '--data',
    './mock-data',
    '--socket',
    './mock.sock',
    '--vm-config',
    './runtime.json',
  ]);
  expect(options.dataRoot).toBe(path.resolve('./mock-data'));
  expect(agentScope(options.dataRoot, options.vmConfigFile)).toBe(
    createHash('sha256')
      .update(JSON.stringify([options.dataRoot, options.vmConfigFile]))
      .digest('hex'),
  );
  for (const args of [
    [],
    ['--data', '/mock'],
    ['--unknown', 'x'],
    ['--data', '/a', '--data', '/b', '--socket', '/s', '--vm-config', '/v'],
  ])
    expect(() => parseAgentArguments(args)).toThrowError(/AGENT_ARGUMENTS_INVALID/);
});

test('Mac VM startup passes the separately downloaded and pinned Lima archive to tool preparation', async () => {
  const f = await fixture();
  const assets = {
    packDirectory: path.join(f.root, 'mock-environment'),
    executorArchive: path.join(f.root, 'mock-executor.tar.gz'),
    sourceHelper: path.join(f.root, 'mock-source.mjs'),
    restoreHelper: path.join(f.root, 'mock-restore.mjs'),
    limaArchive: path.join(f.root, 'mock-lima.tar.gz'),
    limaDigest: 'b'.repeat(64),
  };
  let prepared: Parameters<MainDependencies['tools']>[0] | undefined;
  let app: Awaited<ReturnType<typeof startAgentProcess>> | undefined;
  try {
    app = await startAgentProcess(
      {
        ...f.options,
        dataRoot: await secureDirectory(path.join(f.root, 'private')),
      },
      {
        ...f.dependencies,
        platform: 'darwin',
        assets,
        tools: async (options) => {
          prepared = options;
          return config.limactl;
        },
      },
    );
    expect(prepared).toMatchObject({
      packDirectory: assets.packDirectory,
      archive: assets.limaArchive,
      digest: assets.limaDigest,
    });
  } finally {
    await app?.close();
    await f.cleanup();
  }
});

test('production wiring binds real VM identity, lazy recovery revisions and explicit start order', async () => {
  const f = await fixture();
  const app = await startAgentProcess(f.options, f.dependencies);
  try {
    expect(f.events.slice(0, 3)).toStrictEqual(['tools', 'bootstrap', 'core']);
    expect(f.powerOptions.target).toBe(agentVmTarget(config));
    expect(f.coreOptions.scope).toBe(agentScope(f.options.dataRoot, f.options.vmConfigFile));
    expect(f.coreOptions.sdkFile).toBe('/mock/private/sdk.js');
    expect.assert(f.coreOptions.stdioEntry?.endsWith('mcp-stdio.js'));
    await f.powerOptions.driver.claim({ id: 'mock-restart', revision: 4, review: review.digest });
    await f.powerOptions.driver.cancel({ id: 'mock-restart', revision: 4, review: review.digest });
    expect.assert(f.events.includes('claim:5'));
    expect.assert(f.events.includes('cancel:5'));
    await expect(f.powerOptions.beforeStop!()).rejects.toThrowError(/RECOVERY_STOP_NOT_CLAIMED/);
    f.claim();
    await f.powerOptions.beforeStop!();
    expect.assert(f.events.includes('stop-model:mock-running'));
    expect.assert(f.events.includes('stop-model:mock-finalizing'));
    expect.assert(!f.events.includes('stop-model:mock-idle'));
    const before = f.events.length;
    await f.powerOptions.driver.start();
    expect(f.events.slice(before)).toStrictEqual(['vm-start', 'rebind', 'core-refresh']);
  } finally {
    await app.close();
    expect.assert(!f.events.includes('vm-stop'));
    await f.cleanup();
  }
});

test('a cold daemon with pending power and a cached snapshot never ensures or starts a stopped VM', async () => {
  const f = await fixture();
  const target = agentVmTarget(config);
  await saveExecutionSnapshot({
    file: path.join(f.root, 'execution-snapshot.json'),
    target,
    snapshot,
    workspaceRoot: '/mock-guest/workspace',
  });
  await writeFile(
    path.join(f.root, 'host-recovery.json'),
    JSON.stringify({
      version: 1,
      revision: 1,
      target,
      operation: { id: 'mock-restart', stage: 'preparing', review },
    }),
    { mode: 0o600 },
  );
  const app = await startAgentProcess(f.options, f.dependencies);
  try {
    expect(f.connectionOptions.attachOnly).toBe(true);
    expect(f.connectionOptions.initialSnapshot).toStrictEqual(snapshot);
    expect(f.coreOptions.offlineWorkspaceRoot).toBe('/mock-guest/workspace');
    expect.assert(!f.events.includes('ensure'));
    expect.assert(!f.events.includes('vm-start'));
    await f.powerOptions.driver.start();
    expect.assert(f.events.includes('vm-start'));
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('CLI pause exits cleanly and failures expose only a sanitized uppercase code', async () => {
  const f = await fixture();
  const reports: string[] = [];
  const signals = new EventEmitter();
  const masks: number[] = [];
  const runtime = {
    signals,
    umask: (mask: number) => {
      masks.push(mask);
    },
    report: (code: string) => {
      reports.push(code);
    },
  };
  const args = [
    '--data',
    f.root,
    '--socket',
    f.options.socketPath,
    '--vm-config',
    f.options.vmConfigFile,
  ];
  try {
    expect(
      await runAgentCli(
        args,
        {
          ...f.dependencies,
          bootstrap: async () => {
            throw new Error('AGENT_SETUP_PAUSED');
          },
        },
        runtime,
      ),
    ).toBe(0);
    expect(reports).toStrictEqual([]);
    await expect(readFile(path.join(f.root, 'progress.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await runAgentCli(
        args,
        {
          ...f.dependencies,
          bootstrap: async () => {
            throw new Error('synthetic-private-key must never be logged');
          },
        },
        runtime,
      ),
    ).toBe(1);
    expect(reports).toStrictEqual(['AGENT_START_FAILED']);
    expect.assert(
      !(await readFile(path.join(f.root, 'progress.json'), 'utf8')).includes(
        'synthetic-private-key',
      ),
    );
    expect(masks).toStrictEqual([0o077, 0o077]);
  } finally {
    await f.cleanup();
  }
});

test('SIGTERM closes power, core and connection without issuing a VM stop', async () => {
  const f = await fixture();
  const signals = new EventEmitter();
  const run = runAgentCli(
    ['--data', f.root, '--socket', f.options.socketPath, '--vm-config', f.options.vmConfigFile],
    f.dependencies,
    {
      signals,
      umask: () => {},
      report: () => {
        throw new Error('No error expected');
      },
    },
  );
  try {
    for (let count = 0; count < 100 && !f.events.includes('core'); count++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    signals.emit('SIGTERM');
    expect(await run).toBe(0);
    expect(f.events.filter((event) => event.endsWith('-close'))).toStrictEqual([
      'power-close',
      'core-close',
      'connection-close',
      'link-close',
    ]);
    expect.assert(!f.events.includes('vm-stop'));
  } finally {
    await f.cleanup();
  }
});

test('pending recovery without a usable cache never creates the HostCore or starts a VM', async () => {
  const f = await fixture();
  const target = agentVmTarget(config);
  await writeFile(
    path.join(f.root, 'host-recovery.json'),
    JSON.stringify({
      version: 1,
      revision: 1,
      target,
      operation: { id: 'mock-restart', stage: 'preparing', review },
    }),
    { mode: 0o600 },
  );
  try {
    await expect(startAgentProcess(f.options, f.dependencies)).rejects.toThrowError(
      /AGENT_RECOVERY_CACHE_REQUIRED/,
    );
    expect.assert(!f.events.includes('core'));
    expect.assert(!f.events.includes('ensure'));
    expect.assert(!f.events.includes('vm-start'));
    expect.assert(f.events.includes('connection-close'));
  } finally {
    await f.cleanup();
  }
});

test('a failed durable power owner cannot start HostCore even if execution is reachable', async () => {
  const f = await fixture();
  try {
    const result = startAgentProcess(f.options, {
      ...f.dependencies,
      power: () => ({
        ready: Promise.resolve(),
        status: () => ({ available: false, error: 'RECOVERY_HOST_STORE_UNAVAILABLE' }),
        handle: async () => review,
        close: async () => {},
      }),
    }).then(async (app) => {
      await app.close();
      return app;
    });
    await expect(result).rejects.toThrowError(/RECOVERY_HOST_STORE_UNAVAILABLE/);
    expect.assert(!f.events.includes('core'));
    expect.assert(!f.events.includes('vm-start'));
  } finally {
    await f.cleanup();
  }
});

test('real cold HostCore recovery stays offline until an explicit user start completes the claimed reboot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-main-cold-'));
  const options = {
    dataRoot: root,
    socketPath: path.join(root, 'agent.sock'),
    vmConfigFile: path.join(root, 'runtime.json'),
  };
  const sdkFile = path.join(root, 'mock-sdk.js');
  await writeFile(sdkFile, 'export class DeepSeekHarness {}', { mode: 0o600 });
  let running = true;
  let startFails = true;
  let ensures = 0;
  let starts = 0;
  let stops = 0;
  let current = structuredClone(snapshot);
  let core: Awaited<ReturnType<typeof startAgent>> | undefined;
  let power: HostPower | undefined;
  const factory: MainDependencies = {
    tools: async () => config.limactl,
    bootstrap: async () => config,
    sdk: () => sdkFile,
    link: () => ({
      ensure: async () => {
        ensures++;
        running = true;
        return { origin: 'http://127.0.0.1:12345', token: 'mock-first-token' };
      },
      reconnect: async () => {
        if (!running) throw new Error('EXECUTOR_OFFLINE');
        return { origin: 'http://127.0.0.1:12345', token: 'mock-attached-token' };
      },
      state: async () => (running ? 'running' : 'stopped'),
      stopVm: async () => {
        stops++;
        running = false;
      },
      startVm: async () => {
        starts++;
        if (startFails) throw new Error('MOCK_START_FAILED');
        running = true;
        current = { ...current, boot: 'mock-restarted-boot', nonce: 'mock-restarted-service' };
        return { origin: 'http://127.0.0.1:12345', token: 'mock-new-token' };
      },
      close: async () => {},
    }),
    connection: (link, settings) =>
      new ExecutionConnection(link, {
        ...settings,
        create: () => ({
          ready: Promise.resolve(current),
          snapshot: current,
          refresh: async () => current,
          async call<T>(method: string) {
            if (method === 'workspace.base') return '/mock-guest/workspace' as T;
            throw new Error(`Unexpected synthetic ${method}`);
          },
        }),
      }),
    power: (settings) => {
      power = new HostPower(settings);
      return power;
    },
    core: async (settings) => {
      core = await startAgent(settings);
      return core;
    },
  };
  let first: Awaited<ReturnType<typeof startAgentProcess>> | undefined;
  let second: Awaited<ReturnType<typeof startAgentProcess>> | undefined;
  try {
    first = await startAgentProcess(options, factory);
    const review = (await power!.handle({ type: 'recovery.review' })) as RecoveryReview;
    await power!.handle({
      type: 'recovery.restart',
      request: {
        id: 'mock-cold-reboot',
        revision: review.revision,
        review: review.digest,
        confirmation: 'restart-all-apps',
      },
    });
    expect(running).toBe(false);
    expect(stops).toBe(1);
    await first.close();
    first = undefined;
    const originalEnsures = ensures;
    const originalStarts = starts;
    second = await startAgentProcess(options, factory);
    expect(ensures).toBe(originalEnsures);
    expect(starts).toBe(originalStarts);
    expect(running).toBe(false);
    expect(core!.recovery!.receipt('mock-cold-reboot').phase).toBe('claimed');
    startFails = false;
    await power!.handle({ type: 'recovery.start', id: 'mock-cold-reboot' });
    const status = power!.status();
    expect(status.available && status.operation?.stage).toBe('complete');
    expect(core!.recovery!.receipt('mock-cold-reboot').phase).toBe('complete');
    expect(running).toBe(true);
    expect(starts).toBe(originalStarts + 1);
    expect(stops).toBe(1);
  } finally {
    await first?.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migration startup failures replace creating progress with the same safe code shown by CLI', async () => {
  const f = await fixture();
  const reports: string[] = [];
  const args = [
    '--data',
    f.root,
    '--socket',
    f.options.socketPath,
    '--vm-config',
    f.options.vmConfigFile,
  ];
  try {
    for (const code of ['MIGRATION_CREDENTIAL_UNAVAILABLE', 'MIGRATION_SECRET_IN_PUBLIC']) {
      const secret = 'synthetic-provider-key-in-private-error';
      const result = await runAgentCli(
        args,
        {
          ...f.dependencies,
          bootstrap: async () => {
            await writeFile(
              path.join(f.root, 'progress.json'),
              JSON.stringify({ required: true, phase: 'creating' }),
              { mode: 0o600 },
            );
            throw Object.assign(new Error(secret), { code });
          },
        },
        {
          signals: new EventEmitter(),
          umask: () => {},
          report: (value) => {
            reports.push(value);
          },
        },
      );
      expect(result).toBe(1);
      const progress = await readFile(path.join(f.root, 'progress.json'), 'utf8');
      expect(JSON.parse(progress)).toStrictEqual({ required: true, phase: 'failed', error: code });
      expect(reports.at(-1)).toBe(code);
      expect.assert(!progress.includes(secret));
      expect.assert(!JSON.stringify(reports).includes(secret));
    }
  } finally {
    await f.cleanup();
  }
});

test('an aborted bootstrap leaves its last progress intact instead of presenting a startup failure', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const progress = JSON.stringify({ required: true, phase: 'creating' });
  await writeFile(path.join(f.root, 'progress.json'), progress, { mode: 0o600 });
  try {
    await expect(
      startAgentProcess(
        f.options,
        {
          ...f.dependencies,
          bootstrap: async () => {
            controller.abort();
            return config;
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(path.join(f.root, 'progress.json'), 'utf8')).toBe(progress);
    expect.assert(!f.events.includes('core'));
  } finally {
    await f.cleanup();
  }
});

test('native-first startup defers Linux tools and bootstrap until explicit environment installation', async () => {
  const f = await fixture();
  let assetReads = 0;
  let captured: Parameters<typeof startNativeAgent>[0] | undefined;
  const owner = await startAgentProcess(
    { ...f.options, mode: 'native' },
    {
      ...f.dependencies,
      get assets() {
        assetReads++;
        return f.dependencies.assets;
      },
      platform: 'darwin',
      native: async (options) => {
        captured = options;
        return { close: async () => {} };
      },
      bootstrap: async (options) => {
        f.events.push('bootstrap');
        await writeSetupRecord(options.vmConfigFile, config);
        return config;
      },
    },
  );
  try {
    expect(f.events).toStrictEqual([]);
    expect(assetReads).toBe(0);
    expect((await captured!.environment!.status()).target).toBe('linux');
    await captured!.environment!.start();
    for (
      let attempt = 0;
      attempt < 100 && (await captured!.environment!.status()).required;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.events).toStrictEqual(['tools', 'bootstrap']);
    expect(assetReads).toBe(1);
    expect((await captured!.environment!.status()).required).toBe(false);
  } finally {
    await owner.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Windows native startup offers QEMU setup without resolving the Mac Linux payload', async () => {
  const f = await fixture();
  const root = await secureDirectory(path.join(f.root, 'private'));
  let offered = false;
  const owner = await startAgentProcess(
    {
      dataRoot: path.join(root, 'agent'),
      socketPath: path.join(root, 'mock.sock'),
      vmConfigFile: path.join(root, 'runtime.json'),
      mode: 'native',
    },
    {
      ...f.dependencies,
      platform: 'win32',
      native: async (options) => {
        offered = !!options.environment;
        return { close: async () => {} };
      },
    },
  );
  try {
    expect(offered).toBe(true);
    expect(f.events).toEqual([]);
  } finally {
    await owner.close();
    await f.cleanup();
  }
});
