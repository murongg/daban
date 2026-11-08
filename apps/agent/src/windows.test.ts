import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { WindowsHost } from './windows.js';

test('concurrent acceleration observations share one Windows process and later observations stay fresh', async () => {
  let finish!: (value: { stdout: string }) => unknown;
  const run = vi.fn(
    () =>
      new Promise<{ stdout: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const host = new WindowsHost({ run });
  const observations = [host.probe(), host.probe(), host.probe()];
  expect(run).toHaveBeenCalledTimes(1);
  finish({
    stdout: JSON.stringify({ architecture: 9, firmware: true, feature: true, hypervisor: true }),
  });
  expect(await Promise.all(observations)).toEqual(['ready', 'ready', 'ready']);
  const next = host.probe();
  expect(run).toHaveBeenCalledTimes(2);
  finish({
    stdout: JSON.stringify({ architecture: 9, firmware: true, feature: false, hypervisor: false }),
  });
  expect(await next).toBe('disabled');
});

test('a failed shared Windows probe is retried instead of retaining a rejected observation', async () => {
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ architecture: 9, firmware: true, feature: true, hypervisor: true }),
  }));
  run.mockRejectedValueOnce(new Error('SYNTHETIC_CIM_FAILURE'));
  const host = new WindowsHost({ run });
  const failed = await Promise.allSettled([host.probe(), host.probe()]);
  expect(run).toHaveBeenCalledTimes(1);
  expect(failed.map((value) => value.status)).toEqual(['rejected', 'rejected']);
  expect(await host.probe()).toBe('ready');
  expect(run).toHaveBeenCalledTimes(2);
});

test('cold Windows capability initialization can finish after twenty seconds', async () => {
  vi.useFakeTimers();
  try {
    const host = new WindowsHost({
      run: async (_program, _args, options) =>
        new Promise<{ stdout: string }>((resolve, reject) => {
          const deadline = setTimeout(() => {
            clearTimeout(completed);
            reject(new Error('SYNTHETIC_PROBE_TIMEOUT'));
          }, options.timeout);
          const completed = setTimeout(() => {
            clearTimeout(deadline);
            resolve({
              stdout: JSON.stringify({
                architecture: 9,
                firmware: true,
                feature: true,
                hypervisor: true,
              }),
            });
          }, 20000);
        }),
    });
    const result = host.probe().catch(() => 'failed');
    await vi.advanceTimersByTimeAsync(20000);
    expect(await result).toBe('ready');
  } finally {
    vi.useRealTimers();
  }
});

test('a recycled Windows PID is not mistaken for the managed QEMU process, while unobservable processes stay uncertain', async () => {
  const expected = path.resolve('mock-private/tools/qemu-system-x86_64.exe');
  let observation: { exists: boolean; image: string | null } = {
    exists: true,
    image: path.resolve('mock-other.exe'),
  };
  const host = new WindowsHost({ run: async () => ({ stdout: JSON.stringify(observation) }) });
  expect(await host.owns(12345, expected)).toBe(false);
  observation = { exists: true, image: expected };
  expect(await host.owns(12345, expected)).toBe(true);
  observation = { exists: true, image: null };
  expect(await host.owns(12345, expected)).toBeUndefined();
  observation = { exists: false, image: null };
  expect(await host.owns(12345, expected)).toBe(false);
});

test('Windows acceleration detection distinguishes disabled, pending restart and a usable hypervisor without modifying features', async () => {
  let status = { architecture: 9, firmware: true, feature: false, hypervisor: false };
  const commands: string[] = [];
  const host = new WindowsHost({
    run: async (_program, args, options) => {
      expect(options.env.DEEPSEEK_API_KEY).toBeUndefined();
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      commands.push(script);
      return { stdout: JSON.stringify(status) };
    },
  });
  expect(await host.probe()).toBe('disabled');
  status = { ...status, feature: true };
  expect(await host.probe()).toBe('restart');
  status = { ...status, hypervisor: true };
  expect(await host.probe()).toBe('ready');
  status = { ...status, firmware: false, hypervisor: false };
  expect(await host.probe()).toBe('firmware');
  expect(commands.join('\n')).not.toContain('Enable-WindowsOptionalFeature');
});

test('Windows host probes reject malformed observations instead of claiming hardware acceleration is ready', async () => {
  const host = new WindowsHost({ run: async () => ({ stdout: '{"hypervisor":"true"}' }) });
  await expect(host.probe()).rejects.toThrow('QEMU_HOST_UNAVAILABLE');
});

test('failed hardware probes expose only the last fixed diagnostic stage', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure = Object.assign(new Error('SYNTHETIC_PRIVATE_CONTEXT'), {
    stderr:
      'SYNTHETIC_PRIVATE_CONTEXT\nDABAN_WINDOWS_PROBE:cpu\nDABAN_WINDOWS_PROBE:feature\nDABAN_WINDOWS_CIM:3\n',
  });
  const host = new WindowsHost({
    run: async () => {
      throw failure;
    },
  });
  await expect(host.probe()).rejects.toThrow('QEMU_HOST_UNAVAILABLE');
  expect(diagnostic.mock.calls).toContainEqual(['[windows-probe-stage]', 'feature']);
  expect(diagnostic.mock.calls).toContainEqual(['[windows-probe-cim]', '3']);
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_CONTEXT');
});

test('PowerShell retains its system cache location while excluding model credentials', async () => {
  vi.stubEnv('LOCALAPPDATA', path.resolve('mock-system-cache'));
  vi.stubEnv('COMPUTERNAME', 'MOCK-COMPUTER');
  vi.stubEnv('ProgramFiles', path.resolve('mock-programs'));
  vi.stubEnv('Path', path.resolve('mock-untrusted-bin'));
  vi.stubEnv('PSModulePath', path.resolve('mock-registered-modules'));
  vi.stubEnv('SYNTHETIC_API_KEY', 'mock-private-key');
  try {
    const host = new WindowsHost({
      run: async (_program, _args, options) => {
        expect(options.env.LOCALAPPDATA).toBe(path.resolve('mock-system-cache'));
        expect(options.env.COMPUTERNAME).toBe('MOCK-COMPUTER');
        expect(options.env.ProgramFiles).toBe(path.resolve('mock-programs'));
        expect(options.env.Path).not.toContain('mock-untrusted-bin');
        expect(options.env.PSModulePath).toBe(path.resolve('mock-registered-modules'));
        expect(options.env.SYNTHETIC_API_KEY).toBeUndefined();
        return {
          stdout: JSON.stringify({
            architecture: 9,
            firmware: true,
            feature: true,
            hypervisor: true,
          }),
        };
      },
    });
    expect(await host.probe()).toBe('ready');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('explicit Windows feature enabling uses one fixed UAC command, never a reboot or a guest command', async () => {
  const scripts: string[] = [];
  const host = new WindowsHost({
    run: async (_program, args) => {
      const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      scripts.push(script);
      return { stdout: '{"result":"enabled"}' };
    },
  });
  await host.enable();
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain('RunAs');
  expect(scripts[0]).toContain('Hidden');
  expect(scripts[0]).not.toMatch(/Restart-Computer|shutdown|Invoke-Expression/);
});
