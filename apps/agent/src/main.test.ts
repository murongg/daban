import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startAgent, type startNativeAgent } from '@daban/engine/agent';
import {
  type ExecutionSnapshot,
  executionCapabilities,
  type RecoveryReceipt,
  type RecoveryReview,
} from '@daban/protocol';
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
      ]),
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
          assert.deepEqual(value, { origin: 'http://127.0.0.1:12346', token: 'mock-start-token' });
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
  assert.equal(options.dataRoot, path.resolve('./mock-data'));
  assert.equal(
    agentScope(options.dataRoot, options.vmConfigFile),
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
    assert.throws(() => parseAgentArguments(args), /AGENT_ARGUMENTS_INVALID/);
});

test('production wiring binds real VM identity, lazy recovery revisions and explicit start order', async () => {
  const f = await fixture();
  const app = await startAgentProcess(f.options, f.dependencies);
  try {
    assert.deepEqual(f.events.slice(0, 3), ['tools', 'bootstrap', 'core']);
    assert.equal(f.powerOptions.target, agentVmTarget(config));
    assert.equal(f.coreOptions.scope, agentScope(f.options.dataRoot, f.options.vmConfigFile));
    assert.equal(f.coreOptions.sdkFile, '/mock/private/sdk.js');
    assert.ok(f.coreOptions.stdioEntry?.endsWith('mcp-stdio.js'));
    await f.powerOptions.driver.claim({ id: 'mock-restart', revision: 4, review: review.digest });
    await f.powerOptions.driver.cancel({ id: 'mock-restart', revision: 4, review: review.digest });
    assert.ok(f.events.includes('claim:5'));
    assert.ok(f.events.includes('cancel:5'));
    await assert.rejects(f.powerOptions.beforeStop!(), /RECOVERY_STOP_NOT_CLAIMED/);
    f.claim();
    await f.powerOptions.beforeStop!();
    assert.ok(f.events.includes('stop-model:mock-running'));
    assert.ok(!f.events.includes('stop-model:mock-idle'));
    const before = f.events.length;
    await f.powerOptions.driver.start();
    assert.deepEqual(f.events.slice(before), ['vm-start', 'rebind', 'core-refresh']);
  } finally {
    await app.close();
    assert.ok(!f.events.includes('vm-stop'));
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
    assert.equal(f.connectionOptions.attachOnly, true);
    assert.deepEqual(f.connectionOptions.initialSnapshot, snapshot);
    assert.equal(f.coreOptions.offlineWorkspaceRoot, '/mock-guest/workspace');
    assert.ok(!f.events.includes('ensure'));
    assert.ok(!f.events.includes('vm-start'));
    await f.powerOptions.driver.start();
    assert.ok(f.events.includes('vm-start'));
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
    assert.equal(
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
      0,
    );
    assert.deepEqual(reports, []);
    await assert.rejects(readFile(path.join(f.root, 'progress.json')), { code: 'ENOENT' });
    assert.equal(
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
      1,
    );
    assert.deepEqual(reports, ['AGENT_START_FAILED']);
    assert.ok(
      !(await readFile(path.join(f.root, 'progress.json'), 'utf8')).includes(
        'synthetic-private-key',
      ),
    );
    assert.deepEqual(masks, [0o077, 0o077]);
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
    assert.equal(await run, 0);
    assert.deepEqual(
      f.events.filter((event) => event.endsWith('-close')),
      ['power-close', 'core-close', 'connection-close', 'link-close'],
    );
    assert.ok(!f.events.includes('vm-stop'));
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
    await assert.rejects(
      startAgentProcess(f.options, f.dependencies),
      /AGENT_RECOVERY_CACHE_REQUIRED/,
    );
    assert.ok(!f.events.includes('core'));
    assert.ok(!f.events.includes('ensure'));
    assert.ok(!f.events.includes('vm-start'));
    assert.ok(f.events.includes('connection-close'));
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
    await assert.rejects(result, /RECOVERY_HOST_STORE_UNAVAILABLE/);
    assert.ok(!f.events.includes('core'));
    assert.ok(!f.events.includes('vm-start'));
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
    assert.equal(running, false);
    assert.equal(stops, 1);
    await first.close();
    first = undefined;
    const originalEnsures = ensures;
    const originalStarts = starts;
    second = await startAgentProcess(options, factory);
    assert.equal(ensures, originalEnsures);
    assert.equal(starts, originalStarts);
    assert.equal(running, false);
    assert.equal(core!.recovery!.receipt('mock-cold-reboot').phase, 'claimed');
    startFails = false;
    await power!.handle({ type: 'recovery.start', id: 'mock-cold-reboot' });
    const status = power!.status();
    assert.equal(status.available && status.operation?.stage, 'complete');
    assert.equal(core!.recovery!.receipt('mock-cold-reboot').phase, 'complete');
    assert.equal(running, true);
    assert.equal(starts, originalStarts + 1);
    assert.equal(stops, 1);
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
      assert.equal(result, 1);
      const progress = await readFile(path.join(f.root, 'progress.json'), 'utf8');
      assert.deepEqual(JSON.parse(progress), { required: true, phase: 'failed', error: code });
      assert.equal(reports.at(-1), code);
      assert.ok(!progress.includes(secret));
      assert.ok(!JSON.stringify(reports).includes(secret));
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
    await assert.rejects(
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
      { name: 'AbortError' },
    );
    assert.equal(await readFile(path.join(f.root, 'progress.json'), 'utf8'), progress);
    assert.ok(!f.events.includes('core'));
  } finally {
    await f.cleanup();
  }
});

test('native-first startup defers Linux tools and bootstrap until explicit environment installation', async () => {
  const f = await fixture();
  let captured: Parameters<typeof startNativeAgent>[0] | undefined;
  const owner = await startAgentProcess(
    { ...f.options, mode: 'native' },
    {
      ...f.dependencies,
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
    assert.deepEqual(f.events, []);
    assert.equal((await captured!.environment!.status()).target, 'linux');
    await captured!.environment!.start();
    for (
      let attempt = 0;
      attempt < 100 && (await captured!.environment!.status()).required;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(f.events, ['tools', 'bootstrap']);
    assert.equal((await captured!.environment!.status()).required, false);
  } finally {
    await owner.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
