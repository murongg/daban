import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  disconnected,
  type PeerEvent,
  type RemoteIdentity,
  type RemotePeerPort,
  type RemoteSignal,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RemoteAccess } from './remote-access.js';
import { remoteProof } from './remote-crypto.js';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { RemoteStore } from './remote-store.js';

type Signal = Extract<RemoteSignal, { type: 'signal' }>;
const signals = vi.hoisted(() => new Map<string, (message: Signal) => unknown>());
vi.mock('./remote-signal.js', () => ({
  SignalConnection: class {
    connected = true;
    constructor(options: {
      keys: { identity: RemoteIdentity };
      signal: (message: Signal) => unknown;
    }) {
      signals.set(options.keys.identity.id, options.signal);
    }
    async start() {
      return [];
    }
    send() {}
    close() {}
  },
}));

test('real remote sessions project status/connect and pushes for each accepted schema without granting authority', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-remote-'));
  const directory = path.join(root, 'host');
  const keys = await RemoteKeys.open(directory, 'Synthetic Host');
  const a = await RemoteKeys.open(path.join(root, 'a'), 'Synthetic A');
  const b = await RemoteKeys.open(path.join(root, 'b'), 'Synthetic B');
  const store = new RemoteStore({
    file: path.join(directory, 'remote.sqlite'),
    host: keys.identity.id,
    workspace: keys.identity.id,
  });
  await store.ready;
  store.pair(a.identity, 'controller');
  store.pair(b.identity, 'controller');
  store.close();
  let receive: (event: Exclude<PeerEvent, { type: 'result' }>) => unknown = () => {};
  const opened: string[] = [];
  const sent: { session: string; message: Record<string, unknown>; channel?: string }[] = [];
  const peer: RemotePeerPort = {
    async open(session) {
      opened.push(session);
    },
    async signal() {},
    async close() {},
    async send(session, data, channel) {
      sent.push({ session, message: JSON.parse(data) as Record<string, unknown>, channel });
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
  };
  const snapshot = { ...disconnected('ready'), contextInspector: 1, preflight: 1, fileReview: 1 };
  const host = new RemoteAccess({
    directory,
    name: 'Synthetic Host',
    platform: 'mock-platform',
    peer,
    dispatch: async () => snapshot,
  });
  try {
    await host.ready;
    await host.command({ type: 'host', enabled: true, server: 'https://relay.example.test' });
    const open = async (session: string, controller: RemoteKeys) => {
      const sdp = 'SYNTHETIC SDP';
      signals.get(keys.identity.id)!({
        type: 'signal',
        session,
        from: controller.identity,
        payload: {
          type: 'offer',
          sdp,
          signature: controller.sign(
            remoteProof('sdp', [session, controller.identity.id, keys.identity.id, 'offer', sdp]),
          ),
        },
      });
      await vi.waitFor(() => expect(opened).toContain(session));
      receive({ type: 'state', session, state: 'connected' });
    };
    await open('mock-session-a', a);
    await open('mock-session-b', b);
    const message = (session: string, value: unknown) =>
      receive({ type: 'message', session, data: JSON.stringify(value) });
    const read = async (session: string, id: string, method = 'status') => {
      message(session, {
        type: 'request',
        id,
        host: keys.identity.id,
        workspace: keys.identity.id,
        method,
        params: {},
      });
      await vi.waitFor(() => expect(sent.some((item) => item.message.id === id)).toBe(true));
      return sent.find((item) => item.message.id === id)!.message.value;
    };
    expect(await read('mock-session-a', 'mock-baseline')).toEqual(disconnected('ready'));
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: 'f'.repeat(64),
      workspace: keys.identity.id,
      accept: { contextInspector: 1, preflight: 1 },
    });
    expect(await read('mock-session-a', 'mock-wrong-target')).toEqual(disconnected('ready'));
    message('mock-session-a', {
      type: 'snapshot-capabilities',
      host: keys.identity.id,
      workspace: keys.identity.id,
      accept: { contextInspector: 1, preflight: 1 },
    });
    expect(await read('mock-session-a', 'mock-accepted', 'connect')).toEqual({
      ...disconnected('ready'),
      contextInspector: 1,
      preflight: 1,
    });
    expect(await read('mock-session-b', 'mock-legacy-peer')).toEqual(disconnected('ready'));
    // The Host's local state and a different peer must retain their own independent schema decisions.
    expect(snapshot).toMatchObject({ contextInspector: 1, preflight: 1, fileReview: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await vi.waitFor(() => expect(sent.some((item) => item.channel === 'events')).toBe(true));
    for (const event of sent.filter((item) => item.channel === 'events'))
      expect(event.message.value).toEqual({
        ...disconnected('ready'),
        ...(event.session === 'mock-session-a' ? { contextInspector: 1, preflight: 1 } : {}),
      });
    receive({ type: 'state', session: 'mock-session-a', state: 'closed' });
    await open('mock-session-reconnected', a);
    expect(await read('mock-session-reconnected', 'mock-empty-after-reconnect')).toEqual(
      disconnected('ready'),
    );
    await host.command({ type: 'revoke', device: a.identity.id });
    expect(host.controllers().some((device) => device.id === a.identity.id)).toBe(false);
  } finally {
    await host.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('context observations are fresh on repeated IDs and reauthorize after revocation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-observation-'));
  const keys = await RemoteKeys.open(path.join(root, 'keys'), 'Synthetic Controller');
  const store = new RemoteStore({
    file: path.join(root, 'remote.sqlite'),
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
  });
  await store.ready;
  store.pair(keys.identity, 'controller');
  let revision = 0;
  const gateway = new RemoteGateway(store, async () => ({ revision: ++revision }));
  const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
  try {
    for (const method of ['context.inspect', 'context.source']) {
      const request = {
        type: 'request',
        id: `mock-${method.replace('.', '-')}`,
        host: 'a'.repeat(64),
        workspace: 'mock-workspace',
        method,
        params: {
          query:
            method === 'context.inspect'
              ? { scope }
              : { scope, revision: 1, ref: { scope, seq: 1 } },
        },
      };
      const first = await gateway.invoke(keys.identity.id, 'mock-session', request);
      const next = await gateway.invoke(keys.identity.id, 'mock-session', request);
      expect(next).not.toEqual(first);
    }
    store.revoke(keys.identity.id);
    await expect(
      gateway.invoke(keys.identity.id, 'mock-session', {
        type: 'request',
        id: 'mock-revoked',
        host: 'a'.repeat(64),
        workspace: 'mock-workspace',
        method: 'context.inspect',
        params: { query: { scope } },
      }),
    ).rejects.toThrow('REMOTE_UNAUTHORIZED');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a controller sends one schema hint before RPC without waiting for an old Host to acknowledge it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-controller-'));
  const directory = path.join(root, 'controller');
  const keys = await RemoteKeys.open(directory, 'Synthetic Controller');
  const host = await RemoteKeys.open(path.join(root, 'host'), 'Synthetic Host');
  const store = new RemoteStore({
    file: path.join(directory, 'remote.sqlite'),
    host: keys.identity.id,
    workspace: keys.identity.id,
  });
  await store.ready;
  store.pair(host.identity, 'host', {
    server: 'https://relay.example.test',
    workspace: host.identity.id,
    platform: 'synthetic',
  });
  store.close();
  let receive: (event: Exclude<PeerEvent, { type: 'result' }>) => unknown = () => {};
  const sent: Record<string, unknown>[] = [];
  const peer: RemotePeerPort = {
    async open(session) {
      receive({ type: 'state', session, state: 'connected' });
    },
    async signal() {},
    async close() {},
    async send(session, data) {
      const message = JSON.parse(data) as Record<string, unknown>;
      sent.push(message);
      if (message.type === 'request')
        receive({
          type: 'message',
          session,
          data: JSON.stringify({
            type: 'reply',
            id: message.id,
            host: host.identity.id,
            workspace: host.identity.id,
            ok: true,
            value: disconnected('ready'),
          }),
        });
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
  };
  const controller = new RemoteAccess({
    directory,
    name: 'Synthetic Controller',
    platform: 'synthetic',
    peer,
    dispatch: async () => {
      throw Error('UNEXPECTED LOCAL DISPATCH');
    },
  });
  try {
    await controller.ready;
    expect(await controller.request({ type: 'status' }, host.identity.id)).toEqual(
      disconnected('ready'),
    );
    expect(sent[0]).toEqual({
      type: 'snapshot-capabilities',
      host: host.identity.id,
      workspace: host.identity.id,
      accept: { contextInspector: 1, preflight: 1 },
    });
    expect(await controller.request({ type: 'status' }, host.identity.id)).toEqual(
      disconnected('ready'),
    );
    expect(sent.filter((message) => message.type === 'snapshot-capabilities')).toHaveLength(1);
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
