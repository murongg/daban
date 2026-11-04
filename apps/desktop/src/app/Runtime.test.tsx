import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeCommand, RuntimeReply, RuntimeSnapshot } from '@daban/protocol';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RuntimeClient } from '../../electron/runtime';
import { runtimeService } from '../../electron/service';
import { RuntimeProvider, useRuntime } from './Runtime';

const electron = vi.hoisted(() => ({
  windows: [] as { webContents: { mainFrame: unknown; send(...args: unknown[]): unknown } }[],
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  clipboard: { writeText() {} },
  shell: { async openExternal() {} },
  BrowserWindow: { getAllWindows: () => electron.windows },
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      electron.handlers.set(key, handler),
    removeHandler: (key: string) => electron.handlers.delete(key),
  },
}));
vi.mock('../../electron/host', () => ({
  loadHost: async () => {
    throw Error('SYNTHETIC LOCAL HOST DISABLED');
  },
}));

function Observer() {
  const { snapshot, command } = useRuntime();
  return (
    <>
      <output>
        {snapshot.phase}:{snapshot.contextInspector ?? 'unsupported'}
      </output>
      <button type="button" onClick={() => command({ type: 'status' }).catch(() => undefined)}>
        Synthetic refresh
      </button>
    </>
  );
}

it('normalizes real Host HTTP state through service status/connect and push validation, and fences late results after switching Hosts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-runtime-'));
  let capability: unknown = 1;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/api/model/settings'
          ? { configured: true }
          : {
              clientProtocol: 1,
              mode: 'desktop',
              viewport: { width: 1280, height: 800 },
              sharedLogin: false,
              bots: { a: { owner: 'agent', epoch: 0 }, b: { owner: 'agent', epoch: 0 } },
              model: { available: true, provider: 'mock-provider', model: 'mock-model', bots: {} },
              ...(capability === undefined ? {} : { contextInspector: capability }),
            },
      ),
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  expect.assert(address && typeof address !== 'string');
  const client = new RuntimeClient({
    origin: `http://127.0.0.1:${address.port}`,
    tokenProvider: async () => 'a'.repeat(64),
  });
  const hostA = 'a'.repeat(64),
    hostB = 'b'.repeat(64);
  const subscribers = new Map<string, Set<(value: RuntimeSnapshot) => unknown>>();
  const frame = { url: 'file:///synthetic/index.html' };
  const sender = {
    mainFrame: frame,
    send: vi.fn((_channel: unknown, value: unknown, host: unknown) => {
      for (const listener of subscribers.get(String(host)) ?? [])
        listener(value as RuntimeSnapshot);
    }),
  };
  electron.windows.push({ webContents: sender });
  let late = false;
  let finish: (value: unknown) => unknown = () => {};
  const remote = {
    request: vi.fn(async (_command: RuntimeCommand, host: string) =>
      host === hostA && late
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : client.status(),
    ),
  };
  const service = runtimeService(
    root,
    frame.url,
    undefined,
    undefined,
    undefined,
    undefined,
    'darwin',
    remote,
  );
  const handler = electron.handlers.get('daban:runtime')!;
  Object.defineProperty(window, 'daban', {
    configurable: true,
    value: {
      runtime: {
        invoke: async (command: RuntimeCommand, host: string) =>
          (await handler({ sender, senderFrame: frame }, command, host)) as RuntimeReply,
        subscribe: (listener: (value: RuntimeSnapshot) => unknown, host: string) => {
          const set = subscribers.get(host) ?? new Set();
          set.add(listener);
          subscribers.set(host, set);
          return () => set.delete(listener);
        },
      },
    },
  });
  const mounted = render(
    <RuntimeProvider host={hostA}>
      <Observer />
    </RuntimeProvider>,
  );
  try {
    expect(await screen.findByText('ready:1')).toBeVisible();
    const connected = await handler({ sender, senderFrame: frame }, { type: 'connect' }, hostA);
    expect(connected).toMatchObject({ ok: true, value: { phase: 'ready', contextInspector: 1 } });
    const snapshot = await client.status();
    await act(async () => service.publishRemote(snapshot, hostA));
    expect(screen.getByText('ready:1')).toBeVisible();
    const count = sender.send.mock.calls.length;
    service.publishRemote({ ...snapshot, contextInspector: 2 }, hostA);
    service.publishRemote({ ...snapshot, apiKey: 'SYNTHETIC PRIVATE' }, hostA);
    expect(sender.send).toHaveBeenCalledTimes(count);
    capability = undefined;
    await userEvent.click(screen.getByRole('button', { name: 'Synthetic refresh' }));
    expect(await screen.findByText('ready:unsupported')).toBeVisible();
    late = true;
    await userEvent.click(screen.getByRole('button', { name: 'Synthetic refresh' }));
    mounted.rerender(
      <RuntimeProvider host={hostB}>
        <Observer />
      </RuntimeProvider>,
    );
    expect(await screen.findByText('ready:unsupported')).toBeVisible();
    await act(async () => finish(snapshot));
    expect(screen.getByText('ready:unsupported')).toBeVisible();
    await act(async () => service.publishRemote(snapshot, hostA));
    expect(screen.getByText('ready:unsupported')).toBeVisible();
    capability = 2;
    expect((await client.status()).phase).toBe('offline');
    remote.request.mockResolvedValueOnce({ ...snapshot, contextInspector: 2 });
    expect(await handler({ sender, senderFrame: frame }, { type: 'status' }, hostB)).toEqual({
      ok: false,
      error: 'INVALID_RUNTIME_STATE',
    });
  } finally {
    mounted.unmount();
    Reflect.deleteProperty(window, 'daban');
    await service.close();
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    electron.windows.length = 0;
    electron.handlers.clear();
    await rm(root, { recursive: true, force: true });
  }
});
