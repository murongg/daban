import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostBrowserRequest } from '@daban/protocol';
import type { BrowserContext } from 'playwright';
import { expect, test, vi } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { Control, Fault } from './control.js';
import { HostBrowser } from './host-browser.js';
import { Browser, type BrowserOptions } from './runtime.js';
import { WorkspaceFiles } from './workspace.js';

test('blocks native input before AI handback and publishes the new lease only after transfer', async () => {
  const control = new Control(['mock-a']);
  await control.transfer('mock-a', 0, 'human');
  const calls: unknown[] = [];
  const desktop = {
    context: {} as BrowserContext,
    control: vi.fn(async (...args: unknown[]) => {
      calls.push([args, control.state('mock-a')]);
    }),
    close: vi.fn(async () => {}),
  };
  const browser = new Browser(desktop.context, new Map(), 700, undefined, { control, desktop });
  browser.tabs = {
    instance: 'mock-instance',
    invalidate: vi.fn(),
    prompts: { blocked: () => false },
  } as unknown as NonNullable<Browser['tabs']>;
  await browser.transfer('mock-a', 1, 'agent');
  expect(calls).toEqual([
    [['mock-a', 'mock-instance', 2, 'handoff'], { owner: 'human', epoch: 1 }],
    [['mock-a', 'mock-instance', 2, 'agent'], { owner: 'agent', epoch: 2 }],
  ]);
  await expect(browser.transfer('mock-a', 1, 'human')).rejects.toMatchObject({
    code: 'STALE_CONTROL',
  });
  expect(desktop.control).toHaveBeenCalledTimes(2);
});

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
        snapshot: async (bot: string) => ({ title: `Synthetic page for ${bot}` }),
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

  const permission = (bot: string, enabled?: boolean) =>
    ({ action: 'autoStart', bot, enabled }) as unknown as HostBrowserRequest;
  expect(await host.request(permission('mock-a'))).toEqual({ bot: 'mock-a', enabled: false });
  expect(await host.request(permission('mock-a', true))).toEqual({ bot: 'mock-a', enabled: true });
  expect(await host.request(permission('mock-b'))).toEqual({ bot: 'mock-b', enabled: false });
  expect(host.selected('mock-a')).toBe(false);
  await host.close();
  const reopened = new HostBrowser({ directory: root, launch });
  t.onTestFinished(() => reopened.close());
  const tools = new AgentTools(undefined, new WorkspaceFiles(root), {
    nativeOnly: true,
    hostBrowser: reopened.facade,
  });
  const task = (bot: string): AgentToolRun => ({
    id: `run-${bot}`,
    bot,
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: root,
    canonicalRoot: root,
    task: { requestId: `request-${bot}`, prompt: 'Read the synthetic page.' },
  });
  const allowed = task('mock-a');
  const other = task('mock-b');
  const local = task('mock-a');
  tools.localComputer = {
    list: [],
    selected: () => true,
    prepare: async () => true,
    invoke: async () => ({ content: [] }),
    cancel: async () => {},
  };
  await tools.open(local);
  expect(tools.hostSelected(local.bot, local)).toBe(false);
  tools.localComputer = undefined;
  await tools.open(allowed);
  await tools.open(other);
  expect(tools.list(allowed.bot, undefined, undefined, allowed).map((item) => item.name)).toContain(
    'browser_snapshot',
  );
  expect(tools.list(other.bot, undefined, undefined, other).map((item) => item.name)).not.toContain(
    'browser_snapshot',
  );
  expect((await tools.invoke(other, 'browser_snapshot', {})).isError).toBe(true);
  tools.authorizeComputer = async () => {
    throw new Fault('WEB_APPROVAL_REJECTED');
  };
  expect(JSON.stringify(await tools.invoke(allowed, 'browser_snapshot', {}))).toContain(
    'WEB_APPROVAL_REJECTED',
  );
  expect(launch).toHaveBeenCalledTimes(1);
  tools.authorizeComputer = undefined;
  expect(JSON.stringify(await tools.invoke(allowed, 'browser_snapshot', {}))).toContain(
    'Synthetic page for mock-a',
  );
  expect(launch).toHaveBeenCalledTimes(2);
  const auto = (await reopened.status()).connections[0];
  expect(auto).toMatchObject({ bot: 'mock-a', owner: 'agent' });
  const held = await reopened.request({
    action: 'control',
    bot: auto.bot,
    instance: auto.state.instance,
    epoch: auto.epoch,
    owner: 'human',
  });
  const reading = tools.invoke(allowed, 'browser_snapshot', {});
  try {
    await vi.waitFor(() => expect(allowed.waitingForComputer).toBe(true));
    expect(reopened.control.state(auto.bot)).toEqual(held);
  } finally {
    allowed.abort.abort();
    await reading;
  }
  expect(await reopened.request(permission('mock-a', false))).toEqual({
    bot: 'mock-a',
    enabled: false,
  });
  expect(reopened.selected('mock-a')).toBe(false);
  const later = task('mock-a');
  await tools.open(later);
  expect((await tools.invoke(later, 'browser_snapshot', {})).isError).toBe(true);
  expect(launch).toHaveBeenCalledTimes(2);

  const full = task('mock-a');
  full.task = { ...full.task!, approvalMode: 'full', browserAutoStart: true };
  await tools.open(full);
  expect(tools.list(full.bot, undefined, undefined, full).map((item) => item.name)).toContain(
    'browser_snapshot',
  );
  expect(reopened.selected(full.bot)).toBe(false);
  expect(JSON.stringify(await tools.invoke(full, 'browser_snapshot', {}))).toContain(
    'Synthetic page for mock-a',
  );
  expect(await reopened.request(permission(full.bot))).toEqual({ bot: full.bot, enabled: false });
  await tools.drain(full);
  expect(reopened.selected(full.bot)).toBe(true);
  await tools.finish(full);
  expect(reopened.selected(full.bot)).toBe(false);

  const legacy = task('mock-a');
  legacy.task = { ...legacy.task!, approvalMode: 'full' };
  await tools.open(legacy);
  expect((await tools.invoke(legacy, 'browser_snapshot', {})).isError).toBe(true);
  expect(reopened.selected(legacy.bot)).toBe(false);
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
