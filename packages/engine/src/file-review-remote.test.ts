import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { disconnected, type PeerEvent, type RemotePeerPort } from '@daban/protocol';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { expect, test, vi } from 'vitest';
import { RemoteAccess } from './remote-access.js';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { remoteReceipts } from './remote-schema.js';
import { RemoteStore } from './remote-store.js';

vi.mock('./remote-signal.js', () => ({
  SignalConnection: class {
    connected = true;
    async start() {
      return [];
    }
    send() {}
    close() {}
  },
}));

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
test.each(['files.review.read', 'files.review.diff', 'files.review.current'])(
  '%s is fresh on identical IDs and never stores file evidence in receipts',
  async (method) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-observation-'));
    const keys = await RemoteKeys.open(path.join(root, 'keys'), 'Synthetic Controller');
    const file = path.join(root, 'remote.sqlite');
    const store = new RemoteStore({ file, host: 'a'.repeat(64), workspace: 'mock-workspace' });
    await store.ready;
    store.pair(keys.identity, 'controller');
    let calls = 0,
      allowed = true;
    const gateway = new RemoteGateway(store, async () => {
      calls++;
      if (!allowed) throw Error('FILE_REVIEW_NOT_FOUND');
      return { syntheticText: 'SYNTHETIC PRIVATE DIFF', calls };
    });
    const request = {
      type: 'request',
      id: 'mock-same-id',
      host: 'a'.repeat(64),
      workspace: 'mock-workspace',
      method,
      params: {
        query: method.endsWith('.read')
          ? { scope }
          : { scope, revision: 1, area: 'task', path: 'input.txt' },
      },
    };
    try {
      await gateway.invoke(keys.identity.id, 'mock-session', request);
      allowed = false;
      await expect(gateway.invoke(keys.identity.id, 'mock-session', request)).rejects.toThrow(
        'FILE_REVIEW_NOT_FOUND',
      );
      expect(calls).toBe(2);
      const db = new DatabaseSync(file);
      try {
        expect(drizzle({ client: db }).select().from(remoteReceipts).all()).toHaveLength(0);
      } finally {
        db.close();
      }
      store.revoke(keys.identity.id);
      await expect(gateway.invoke(keys.identity.id, 'mock-session', request)).rejects.toThrow(
        'REMOTE_UNAUTHORIZED',
      );
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('remote reply validation binds scope/revision and sends the existing schema hint before its first read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-controller-'));
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
  let response: unknown = { ...disconnected('ready'), fileReview: { available: true } };
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
            value: response,
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
      throw Error('UNEXPECTED_LOCAL_DISPATCH');
    },
  });
  try {
    await controller.ready;
    await controller.request({ type: 'status' }, host.identity.id);
    expect(sent[0]).toMatchObject({
      type: 'snapshot-capabilities',
      accept: { contextInspector: 1, preflight: 1, fileReview: 1 },
    });
    const query = { scope, revision: 1, area: 'task' as const, path: 'input.txt' };
    response = { ...query, scope: { ...scope, bot: 'mock-other' }, state: 'matching' };
    await expect(
      controller.request({ type: 'files.review.current', query }, host.identity.id),
    ).rejects.toThrow('INVALID_RUNTIME_STATE');
    response = { ...query, state: 'matching' };
    expect(
      await controller.request({ type: 'files.review.current', query }, host.identity.id),
    ).toEqual(response);
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
