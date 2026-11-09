import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { LocalCommandRunner, type LocalSandboxAdapter } from './local-command.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mock-command-root-')));
  const cwd = path.join(root, 'nested');
  await mkdir(cwd);
  return { root, cwd };
}

function sandbox(script: string, observed: { command?: string; cwd?: string; config?: unknown }) {
  const manager: LocalSandboxAdapter = {
    async initialize(config) {
      observed.config = config;
    },
    async wrapWithSandboxArgv(command, _shell, _customConfig, _signal, cwd) {
      observed.command = command;
      observed.cwd = cwd;
      return {
        argv: [process.execPath, '-e', script],
        env: { PATH: '/ignored', MOCK_PRIVATE_TOKEN: 'must-not-inherit' },
      };
    },
    async reset() {},
  };
  return manager;
}

test('runs only after creating a folder-scoped, network-denied sandbox and strips inherited secrets', async (t) => {
  const { root, cwd } = await fixture();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const observed: { command?: string; cwd?: string; config?: unknown } = {};
  const manager = sandbox(
    "process.stdout.write(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, secret: process.env.MOCK_PRIVATE_TOKEN || '', path: process.env.PATH }))",
    observed,
  );
  const runner = new LocalCommandRunner({ manager, platform: 'linux' });

  const result = await runner.run(
    { root, cwd, command: 'python3 convert.py' },
    new AbortController().signal,
  );
  const execution = JSON.parse(result.content[0].text) as {
    exitCode: number | null;
    stdout: string;
  };
  const output = JSON.parse(execution.stdout) as Record<string, string>;
  const config = observed.config as {
    filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[] };
    network: {
      allowedDomains: string[];
      allowLocalBinding: boolean;
      allowUnixSockets: string[];
      strictAllowlist: boolean;
    };
  };

  expect(observed).toMatchObject({ command: 'python3 convert.py', cwd });
  expect(config.network).toMatchObject({
    allowedDomains: [],
    allowLocalBinding: false,
    allowUnixSockets: [],
    strictAllowlist: true,
  });
  expect(config.filesystem.allowRead).toContain(root);
  expect(config.filesystem.allowWrite).toContain(root);
  expect(config.filesystem.denyRead).toContain('/');
  expect(output).toMatchObject({ cwd, secret: '' });
  expect(output.home).not.toBe('/Users/mock-user');
  expect(execution.exitCode).toBe(0);
});

test('terminates commands on timeout and cancellation and caps combined output', async (t) => {
  const { root, cwd } = await fixture();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const timeout = new LocalCommandRunner({
    manager: sandbox('setTimeout(() => {}, 10000)', {}),
    platform: 'linux',
    timeoutMs: 25,
    outputLimit: 16,
  });
  expect(
    (await timeout.run({ root, cwd, command: 'sleep 10' }, new AbortController().signal)).content[0]
      .text,
  ).toBe('LOCAL_COMMAND_TIMEOUT');

  const cancelled = new LocalCommandRunner({
    manager: sandbox('setTimeout(() => {}, 10000)', {}),
    platform: 'linux',
    timeoutMs: 2000,
    outputLimit: 16,
  });
  const pending = cancelled.run({ root, cwd, command: 'sleep 10' }, controller.signal);
  setTimeout(() => controller.abort(), 25);
  await expect(pending).rejects.toThrow('LOCAL_COMMAND_CANCELLED');

  const output = new LocalCommandRunner({
    manager: sandbox("process.stdout.write('x'.repeat(100))", {}),
    platform: 'linux',
    timeoutMs: 2000,
    outputLimit: 16,
  });
  expect(
    (await output.run({ root, cwd, command: 'printf synthetic' }, new AbortController().signal))
      .content[0].text,
  ).toBe('LOCAL_COMMAND_OUTPUT_LIMIT');
});

test('refuses unsupported platforms and unapproved working directories before sandbox startup', async (t) => {
  const { root, cwd } = await fixture();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let initialized = false;
  const manager = sandbox('', {});
  manager.initialize = async () => {
    initialized = true;
  };
  const unsupported = new LocalCommandRunner({ manager, platform: 'win32' });
  expect(
    (await unsupported.run({ root, cwd, command: 'echo synthetic' }, new AbortController().signal))
      .content[0].text,
  ).toBe('LOCAL_COMMAND_SANDBOX_UNAVAILABLE');
  const outside = new LocalCommandRunner({ manager, platform: 'linux' });
  expect(
    (
      await outside.run(
        { root, cwd: path.dirname(root), command: 'echo synthetic' },
        new AbortController().signal,
      )
    ).content[0].text,
  ).toBe('LOCAL_PATH_DENIED');
  expect(initialized).toBe(false);
});

test('resets sandbox state when initialization fails partway through', async (t) => {
  const { root, cwd } = await fixture();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  let resetCount = 0;
  const manager = sandbox('', {});
  manager.initialize = async () => {
    throw new Error('synthetic initialization failure');
  };
  manager.reset = async () => {
    resetCount += 1;
  };
  const runner = new LocalCommandRunner({ manager, platform: 'linux' });

  const result = await runner.run(
    { root, cwd, command: 'echo synthetic' },
    new AbortController().signal,
  );

  expect(result.content[0].text).toBe('LOCAL_COMMAND_SANDBOX_UNAVAILABLE');
  expect(resetCount).toBe(1);
});
