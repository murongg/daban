import path from 'node:path';
import { expect, test } from 'vitest';
import { WindowsHost } from './windows.js';

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
