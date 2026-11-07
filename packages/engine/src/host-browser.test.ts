import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { HostBrowser } from './host-browser.js';
import type { Browser, BrowserOptions } from './runtime.js';

test('host browser starts only on explicit open, shares one private context and fences stale control', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-host-browser-'));
  const pages = new Map<string, unknown>();
  let control: NonNullable<BrowserOptions['control']>;
  const state = (bot: string) => ({
    bot,
    available: true,
    instance: 'mock-instance',
    revision: 0,
    active: `tab-${bot}`,
    tabs: [{ id: `tab-${bot}`, url: 'about:blank', title: '', generation: 0 }],
  });
  const detach = vi.fn(async (bot: string) => {
    pages.delete(bot);
  });
  const launch = vi.fn(async (options: BrowserOptions) => {
    control = options.control!;
    return {
      pages,
      closed: false,
      control,
      context: { on: () => {} },
      tabs: {
        instance: 'mock-instance',
        has: (bot: string) => pages.has(bot),
        state: async (bot: string) => state(bot),
      },
      attach: async (bot: string) => {
        pages.set(bot, {});
        return state(bot);
      },
      detach,
      transfer: (bot: string, epoch: number, owner: string) => control.transfer(bot, epoch, owner),
      close: async () => {},
    } as unknown as Browser;
  });
  const host = new HostBrowser({ directory: root, launch });
  t.onTestFinished(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  expect((await host.status()).connections).toEqual([]);
  expect(launch).not.toHaveBeenCalled();
  await Promise.all([
    host.request({ action: 'open', bot: 'mock-a' }),
    host.request({ action: 'open', bot: 'mock-a' }),
  ]);
  await host.request({ action: 'open', bot: 'mock-b' });
  expect(launch).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0][0]).toMatchObject({
    bots: [],
    profileDir: path.join(await realpath(root), 'profile'),
    publicOnly: true,
    networkFile: path.resolve(root, '../model/network.json'),
  });
  const first = (await host.status()).connections.find((item) => item.bot === 'mock-a')!;
  expect(first.owner).toBe('human');
  await host.request({
    action: 'control',
    bot: 'mock-a',
    instance: first.state.instance,
    epoch: first.epoch,
    owner: 'agent',
  });
  await expect(
    host.request({
      action: 'close',
      bot: 'mock-a',
      instance: first.state.instance,
      epoch: first.epoch,
    }),
  ).rejects.toMatchObject({ code: 'STALE_CONTROL' });
  const current = (await host.status()).connections.find((item) => item.bot === 'mock-a')!;
  await host.request({
    action: 'close',
    bot: 'mock-a',
    instance: current.state.instance,
    epoch: current.epoch,
  });
  expect(host.selected('mock-a')).toBe(false);
  expect(host.selected('mock-b')).toBe(true);
  expect(detach).toHaveBeenCalledWith('mock-a');
});

test('a failed launch leaves ordinary startup available and reports a bounded error without private paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-host-browser-failure-'));
  const host = new HostBrowser({
    directory: root,
    launch: async () => {
      throw Error('SYNTHETIC PRIVATE /mock/user/path');
    },
  });
  t.onTestFinished(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  await expect(host.request({ action: 'open', bot: 'mock-a' })).rejects.toMatchObject({
    code: 'HOST_BROWSER_START_FAILED',
  });
  expect(await host.status()).toEqual({
    available: true,
    connections: [],
    error: 'HOST_BROWSER_START_FAILED',
  });
  expect(host.selected('mock-a')).toBe(false);
});
