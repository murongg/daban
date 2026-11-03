import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveVmConnection } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import { type ExecutionSnapshot, executionCapabilities } from '@daban/protocol';
import { expect, test } from 'vitest';
import { type MainDependencies, startAgentProcess } from './main.js';
import { HostPower } from './power.js';

test.for(['hyperv', 'qemu'] as const)(
  'the Windows %s VM host bypasses Lima, retains the execution cache and does not stop Linux tasks on close',
  async (provider, t) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'mock-main-hyperv-'));
    t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
    const root = await secureDirectory(path.join(temporary, 'private'));
    const options = {
      dataRoot: path.join(root, 'agent'),
      socketPath: path.join(root, 'mock.sock'),
      vmConfigFile: path.join(root, 'runtime.json'),
    };
    await saveVmConnection(options.vmConfigFile, {
      provider,
      enabled: true,
      vmId: '11111111-2222-4333-8444-555555555555',
      host: provider === 'qemu' ? '127.0.0.1' : '192.0.2.10',
      sshPort: 22,
      user: 'mock-bot',
      identityFile: path.join(root, 'mock-key'),
      hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
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
          arch: 'x64',
          kernel: 'mock',
          node: 'mock',
          browser: 'mock',
        },
        events: [],
        bots: {},
      },
      status: { available: true, limit: 2, revision: 0, items: [] },
    };
    let links = 0;
    const rejectLima = async (): Promise<never> => {
      throw new Error('SYNTHETIC LIMA MUST NOT RUN');
    };
    const createLink = () => {
      links++;
      return {
        ensure: async () => ({ origin: 'http://127.0.0.1:23456', token: 'a'.repeat(64) }),
        reconnect: async () => ({ origin: 'http://127.0.0.1:23456', token: 'a'.repeat(64) }),
        state: async () => 'running' as const,
        startVm: rejectLima,
        stopVm: rejectLima,
        close: async () => {},
      };
    };
    const factory: MainDependencies = {
      platform: 'win32',
      tools: rejectLima,
      bootstrap: rejectLima,
      link: () => {
        throw new Error('SYNTHETIC LIMA MUST NOT RUN');
      },
      hyperv: () => {
        expect(provider).toBe('hyperv');
        return createLink();
      },
      qemu: () => {
        expect(provider).toBe('qemu');
        return createLink();
      },
      connection: () => ({
        connected: true,
        ready: Promise.resolve(snapshot),
        snapshot,
        refresh: async () => snapshot,
        rebind: async () => snapshot,
        call: async <T>() => '/mock-linux/workspace' as T,
        close: async () => {},
      }),
      power: (value) => new HostPower(value),
      core: async (value) => {
        expect(value.execution?.snapshot?.computer.environment.arch).toBe('x64');
        return {
          models: { jobs: new Map(), running: () => false, stop: rejectLima },
          refreshExecution: async () => snapshot,
          close: async () => {},
        };
      },
      sdk: () => path.join(root, 'mock-sdk'),
    };
    const first = await startAgentProcess(options, factory);
    await first.close();
    const second = await startAgentProcess(options, factory);
    await second.close();
    expect(links).toBe(2);
  },
);
