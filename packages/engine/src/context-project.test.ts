import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRuntimeCommand, type RemotePeerPort } from '@daban/protocol';
import { expect, test } from 'vitest';
import { RemoteAccess } from './remote-access.js';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { RemoteStore } from './remote-store.js';

const project = { projectId: 'mock-retired', revision: 1 };
const scoped = [
  { type: 'goal.target', owner: { bot: 'mock-bot', chatRevision: 0, project } },
  {
    type: 'task.start',
    bot: 'mock-bot',
    task: { requestId: 'mock-start', prompt: 'SYNTHETIC REQUEST', project },
  },
  { type: 'files.read', path: 'same-name.txt', project },
  {
    type: 'task.start',
    bot: 'mock-bot',
    task: {
      requestId: 'mock-resume',
      prompt: 'SYNTHETIC REQUEST',
      goalResume: {
        owner: { bot: 'mock-bot', chatRevision: 0, project },
        sessionId: 'mock-session',
        goalId: 'mock-goal',
        goalRevision: 1,
        humanEpoch: 0,
      },
    },
  },
];

test.each(scoped)(
  'retired $type scope is refused before the Host receipt/dispatch boundary',
  async (input) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-gateway-'));
    const keys = await RemoteKeys.open(path.join(root, 'controller'), 'Synthetic controller');
    const store = new RemoteStore({
      file: path.join(root, 'remote.sqlite'),
      host: 'a'.repeat(64),
      workspace: 'mock-workspace',
    });
    await store.ready;
    store.pair(keys.identity, 'controller');
    let writes = 0;
    const gateway = new RemoteGateway(store, async () => {
      writes++;
      return { accepted: true };
    });
    const { type, ...params } = parseRuntimeCommand(input);
    const request = {
      type: 'request' as const,
      id: 'mock-wire',
      host: 'a'.repeat(64),
      workspace: 'mock-workspace',
      method: type,
      params,
    };
    try {
      if (type === 'task.start') {
        // Simulate an accepted receipt left by an older Host; retirement must win before cache lookup.
        await store.run(keys.identity.id, request, async () => ({ accepted: true }));
      }
      await expect(gateway.invoke(keys.identity.id, 'mock-session', request)).rejects.toThrow(
        'PROJECT_RETIRED',
      );
      expect(writes).toBe(0);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a controller refuses retired scope before selecting or connecting to an older Host', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-retired-controller-'));
  const peer: RemotePeerPort = {
    open: async () => {},
    signal: async () => {},
    send: async () => {
      throw Error('UNEXPECTED_TRANSPORT');
    },
    close: async () => {},
    subscribe: () => () => {},
  };
  const access = new RemoteAccess({
    directory: root,
    name: 'Synthetic controller',
    platform: 'synthetic',
    peer,
    dispatch: async () => {
      throw Error('UNEXPECTED_WORK');
    },
  });
  try {
    await expect(access.request(parseRuntimeCommand(scoped[0]))).rejects.toThrow('PROJECT_RETIRED');
    await expect(access.request({ type: 'status' })).rejects.toThrow('REMOTE_NO_HOST_SELECTED');
  } finally {
    await access.close();
    await rm(root, { recursive: true, force: true });
  }
});
