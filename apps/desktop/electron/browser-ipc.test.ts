import type { RuntimeReply } from '@daban/protocol';
import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handler: undefined as ((event: unknown, value: unknown) => Promise<RuntimeReply>) | undefined,
  window: undefined as unknown,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (_channel: string, handler: typeof mock.handler) => {
      mock.handler = handler;
    },
    removeHandler: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [mock.window] },
}));

import { parseBrowserMount } from '../shared/browser';
import type { BrowserHost } from './browser-host';
import { browserIpc } from './browser-ipc';

const request = {
  action: 'show',
  id: 'mock-mount',
  revision: 1,
  bot: 'mock-bot',
  epoch: 3,
  binding: { instance: 'mock-instance', tab: 'mock-tab', generation: 0 },
  bounds: { x: 10, y: 20, width: 700, height: 467 },
};

it('admits only bounded presentation requests, never URLs, arbitrary targets or browser commands', () => {
  expect(parseBrowserMount(request)).toEqual(request);
  for (const value of [
    { ...request, target: 'mock-privileged' },
    { ...request, url: 'https://example.test' },
    { ...request, bounds: { ...request.bounds, x: -1 } },
    { ...request, bounds: { ...request.bounds, width: Infinity } },
    { ...request, epoch: -1 },
  ])
    expect(() => parseBrowserMount(value)).toThrow('INVALID_BROWSER_MOUNT');
});

it('rejects guest senders and fences a delayed mount after its component has been hidden', async () => {
  const frame = { url: 'file:///mock/index.html' };
  const sender = { mainFrame: frame };
  const window = { webContents: sender };
  mock.window = window;
  const present = vi.fn(async () => true),
    hide = vi.fn();
  const host = { present, hide } as unknown as BrowserHost;
  let complete!: (value: { target: string }) => unknown;
  const target = vi.fn(
    () =>
      new Promise<{ target: string }>((resolve) => {
        complete = resolve;
      }),
  );
  const close = browserIpc(host, frame.url, target);
  try {
    expect(
      await mock.handler!({ senderFrame: { url: 'https://example.test' }, sender }, request),
    ).toEqual({ ok: false, error: 'UNTRUSTED_SENDER' });
    const showing = mock.handler!({ senderFrame: frame, sender }, request);
    await mock.handler!(
      { senderFrame: frame, sender },
      { action: 'hide', id: request.id, revision: 2 },
    );
    complete({ target: 'mock-owned-target' });
    await showing;
    expect(present).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalledWith(request.id);
  } finally {
    close();
  }
});
