import { mkdtemp, rm } from 'node:fs/promises';
import type { RequestListener, Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Discovery, RemoteAccess } from '@daban/engine/remote';
import { disconnected, type RemoteEndpoint, type RemotePeerPort } from '@daban/protocol';
import { build } from 'vite';
import { expect, test, vi } from 'vitest';

test('the desktop bundle starts its LAN TLS server and registers a Node WebSocket client', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-lan-bundle-'));
  const require = createRequire(import.meta.url);
  const os = require('node:os') as typeof import('node:os');
  const network = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    synthetic: [
      {
        address: '127.0.0.1',
        family: 'IPv4',
        internal: false,
        netmask: '255.0.0.0',
        mac: '00:00:00:00:00:00',
        cidr: '127.0.0.1/8',
      },
    ],
  });
  let host: RemoteAccess | undefined;
  let controller: RemoteAccess | undefined;
  try {
    await build({
      configFile: 'apps/desktop/electron/vite.config.ts',
      logLevel: 'silent',
      build: {
        outDir: path.join(directory, 'bundle'),
        lib: {
          entry: fileURLToPath(new URL('../packages/engine/src/remote.ts', import.meta.url)),
          formats: ['cjs'],
          fileName: () => 'remote.cjs',
        },
      },
    });
    const bundled = require(
      path.join(directory, 'bundle/remote.cjs'),
    ) as typeof import('@daban/engine/remote');
    const unavailable = async () => {
      throw Error('SYNTHETIC_WEBRTC_UNAVAILABLE');
    };
    const offers = new Map<string, RemoteEndpoint>();
    const discovery = (): Discovery => {
      let published: string | undefined;
      const unpublish = async () => {
        if (published) offers.delete(published);
        published = undefined;
      };
      return {
        publish: async (value) => {
          published = value.host.id;
          offers.set(published, value);
        },
        find: async () => [...offers.values()],
        unpublish,
        close: unpublish,
      };
    };
    const peer: RemotePeerPort = {
      open: unavailable,
      signal: unavailable,
      send: unavailable,
      close: async () => {},
      subscribe: () => () => {},
    };
    const snapshot = disconnected('ready');
    host = new bundled.RemoteAccess({
      directory: path.join(directory, 'host'),
      name: 'Synthetic bundled computer',
      platform: process.platform,
      peer,
      dispatch: async () => snapshot,
      discovery: discovery(),
    });
    await host.ready;
    expect((await host.command({ type: 'host', enabled: true })).hosting).toBe(true);
    const state = await host.command({ type: 'invite' });
    expect(state.pairingCode?.code).toMatch(/^\d{6}$/);
    expect(new URL(state.server).hostname).toBe('127.0.0.1');
    controller = new bundled.RemoteAccess({
      directory: path.join(directory, 'controller'),
      name: 'Synthetic bundled controller',
      platform: process.platform,
      peer,
      dispatch: unavailable,
      discovery: discovery(),
    });
    await controller.ready;
    const pairing = controller.command({ type: 'pair', code: state.pairingCode!.code });
    await expect.poll(() => host!.state().pending.length).toBe(1);
    await host.command({ type: 'approve', id: host.state().pending[0].id, accepted: true });
    expect((await pairing).pairedHost).toBe(host.state().identity.id);
    await controller.command({ type: 'select', host: host.state().identity.id });
    expect(await controller.request({ type: 'status' }, host.state().identity.id)).toEqual(
      snapshot,
    );
    expect((await host.command({ type: 'host', enabled: false })).hosting).toBe(false);
  } finally {
    await controller?.close();
    await host?.close();
    network.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the bundled native channel uses Node cryptography when generating a Windows TLS certificate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-native-bundle-'));
  try {
    await build({
      configFile: 'apps/desktop/electron/vite.config.ts',
      logLevel: 'silent',
      build: {
        outDir: directory,
        lib: {
          entry: fileURLToPath(
            new URL('../packages/engine/src/private-channel.ts', import.meta.url),
          ),
          formats: ['cjs'],
          fileName: () => 'channel.cjs',
        },
      },
    });
    const generated = createRequire(import.meta.url)(path.join(directory, 'channel.cjs')) as {
      privateServer(
        listener: RequestListener,
        certificateFile: string,
        platform: NodeJS.Platform,
      ): Promise<{ server: Server }>;
    };
    const channel = await generated.privateServer(
      (_req, res) => res.end(),
      path.join(directory, 'mock.pem'),
      'win32',
    );
    expect(channel.server.listening).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
