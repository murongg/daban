import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RemoteAccess } from '@daban/engine/remote';
import type { PeerDescription, PeerEvent, RemoteIceServer, RemotePeerPort } from '@daban/protocol';
import { afterEach, expect, it } from 'vitest';
import { startConnect } from './server.js';

type Event = Exclude<PeerEvent, { type: 'result' }>;
class SyntheticPeer implements RemotePeerPort {
  static sessions = new Map<string, SyntheticPeer[]>();
  private readonly listeners = new Set<(event: Event) => unknown>();
  async open(session: string, initiator: boolean, _ice: RemoteIceServer[]) {
    const owners = SyntheticPeer.sessions.get(session) ?? [];
    owners.push(this);
    SyntheticPeer.sessions.set(session, owners);
    if (initiator)
      this.emit({ type: 'signal', session, payload: { type: 'offer', sdp: 'synthetic-offer' } });
  }
  async signal(session: string, payload: PeerDescription) {
    if (payload.type === 'offer')
      this.emit({ type: 'signal', session, payload: { type: 'answer', sdp: 'synthetic-answer' } });
    if (payload.type === 'answer')
      for (const owner of SyntheticPeer.sessions.get(session) ?? [])
        owner.emit({ type: 'state', session, state: 'connected', transport: 'direct' });
  }
  async send(session: string, data: string) {
    const target = SyntheticPeer.sessions.get(session)?.find((owner) => owner !== this);
    if (!target) throw Error('REMOTE_SESSION_CLOSED');
    target.emit({ type: 'message', session, data });
  }
  async capture(session: string) {
    const target = SyntheticPeer.sessions.get(session)?.find((owner) => owner !== this);
    target?.emit({ type: 'track', session });
  }
  async close(session: string) {
    const owners = SyntheticPeer.sessions.get(session) ?? [];
    SyntheticPeer.sessions.set(
      session,
      owners.filter((owner) => owner !== this),
    );
  }
  subscribe(callback: (event: Event) => unknown) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  private emit(event: Event) {
    for (const listener of this.listeners) listener(event);
  }
}
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  SyntheticPeer.sessions.clear();
});

it('pairs through host approval, executes on the bound host and survives controller disconnect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-access-synthetic-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await startConnect({ port: 0 });
  cleanup.push(() => service.close());
  let executed = 0;
  const hostPeer = new SyntheticPeer();
  const host = new RemoteAccess({
    directory: path.join(root, 'host'),
    name: 'Synthetic host',
    platform: 'linux',
    peer: hostPeer,
    media: async (_device, request) => {
      expect(request.surface).toBe('native');
      return hostPeer;
    },
    dispatch: async (command) => {
      if (command.type === 'task.start') executed++;
      return { phase: 'synthetic-ready', executed };
    },
  });
  const client = new RemoteAccess({
    directory: path.join(root, 'client'),
    name: 'Synthetic client',
    platform: 'darwin',
    peer: new SyntheticPeer(),
    dispatch: async () => {
      throw Error('WRONG_EXECUTION_TARGET');
    },
  });
  cleanup.push(() => host.close());
  cleanup.push(() => client.close());
  await Promise.all([host.ready, client.ready]);
  await host.command({ type: 'host', enabled: true, server: service.origin });
  const state = await host.command({ type: 'invite' });
  const pairing = client.command({ type: 'pair', invitation: state.invitation! });
  await expect.poll(() => host.state().pending.length).toBe(1);
  await host.command({ type: 'approve', id: host.state().pending[0].id, accepted: true });
  await pairing;
  const hostId = host.state().identity.id;
  await Promise.all([
    client.request({ type: 'status' }, hostId),
    client.request({ type: 'status' }, hostId),
  ]);
  expect(SyntheticPeer.sessions.size).toBe(1);
  await client.command({ type: 'select', host: hostId });
  await client.command({
    type: 'view',
    host: hostId,
    request: { surface: 'native', bot: 'synthetic-bot', session: 'synthetic-desktop', revision: 1 },
  });
  await expect.poll(() => client.state().viewer?.phase).toBe('ready');
  const viewer = client.state().viewer!;
  await client.command({ type: 'view.close', id: viewer.id });
  expect(client.state().viewer).toBeUndefined();
  expect(client.state().hosts[0].state).toBe('connected');
  expect(
    await client.request({
      type: 'task.start',
      bot: 'synthetic-bot',
      task: { prompt: 'Synthetic task', requestId: 'synthetic-task' },
    }),
  ).toEqual({ phase: 'synthetic-ready', executed: 1 });
  await client.command({ type: 'select', host: null });
  expect(executed).toBe(1);
  expect(host.state().hosting).toBe(true);
  const controller = client.state().identity.id;
  await host.command({ type: 'revoke', device: controller });
  expect(host.controllers()).toEqual([]);
});
