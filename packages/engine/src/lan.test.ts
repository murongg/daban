import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disconnected, parseRemoteInvitation, type RemotePeerPort } from '@daban/protocol';
import { generate } from 'selfsigned';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteAccess } from './remote-access.js';
import { RemoteKeys } from './remote-identity.js';
import { SignalConnection } from './remote-signal.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () => ({
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
  }),
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-lan-synthetic-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const peer: RemotePeerPort = {
    open: vi.fn(async () => {
      throw Error('WEBRTC_UNAVAILABLE');
    }),
    signal: async () => {
      throw Error('WEBRTC_UNAVAILABLE');
    },
    send: vi.fn(async () => {
      throw Error('WEBRTC_UNAVAILABLE');
    }),
    close: async () => {},
    subscribe: () => () => {},
  };
  const work = { submissions: 0, completed: false, releases: 0 };
  let finish = () => {};
  const job = new Promise<undefined>((resolve) => {
    finish = () => {
      work.completed = true;
      resolve(undefined);
    };
  });
  const options = {
    directory: path.join(root, 'host'),
    name: 'Synthetic Windows',
    platform: 'win32',
    peer,
    dispatch: async (command: Parameters<RemoteAccess['request']>[0]) => {
      if (command.type === 'control') return { owner: command.owner, epoch: command.epoch + 1 };
      if (command.type === 'input') {
        if (command.input.type === 'release') work.releases++;
        return { ok: true };
      }
      if (command.type === 'status') return disconnected('ready');
      if (command.type === 'files.read') return { content: '合成-LAN-'.repeat(100000) };
      if (command.type === 'task.start') {
        work.submissions++;
        return { accepted: true };
      }
      throw Error('UNEXPECTED_SYNTHETIC_COMMAND');
    },
  };
  const host = new RemoteAccess(options);
  const client = new RemoteAccess({
    directory: path.join(root, 'client'),
    name: 'Synthetic Mac',
    platform: 'darwin',
    peer,
    dispatch: async () => {
      throw Error('WRONG_LOCAL_TARGET');
    },
  });
  cleanup.push(
    () => host.close(),
    () => client.close(),
  );
  await Promise.all([host.ready, client.ready]);
  await host.command({ type: 'host', enabled: true });
  return { root, host, client, options, peer, work, job, finish };
}
async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  const invitation = (await f.host.command({ type: 'invite' })).invitation!;
  const joining = f.client.command({ type: 'pair', invitation });
  await expect.poll(() => f.host.state().pending.length).toBe(1);
  await f.host.command({ type: 'approve', id: f.host.state().pending[0].id, accepted: true });
  await joining;
  const id = f.host.state().identity.id;
  await f.client.command({ type: 'select', host: id });
  return { id, invitation };
}

it('pairs through its own pinned TLS service and executes without SSH, TURN or a browser peer', async () => {
  const f = await fixture();
  const { id, invitation } = await pair(f);
  expect(parseRemoteInvitation(invitation)).toMatchObject({
    certificate: expect.stringContaining('BEGIN CERTIFICATE'),
  });
  expect(await f.client.request({ type: 'status' }, id)).toEqual(disconnected('ready'));
  expect(await f.client.request({ type: 'files.read', path: 'synthetic.txt' }, id)).toEqual({
    content: '合成-LAN-'.repeat(100000),
  });
  expect(
    await f.client.request(
      {
        type: 'task.start',
        bot: 'synthetic-bot',
        task: { requestId: 'synthetic-task', prompt: 'Synthetic task' },
      },
      id,
    ),
  ).toEqual({ accepted: true });
  expect(f.peer.open).not.toHaveBeenCalled();
  expect(f.peer.send).not.toHaveBeenCalled();
  await f.client.close();
  f.finish();
  await f.job;
  expect({ ...f.work, hosting: f.host.state().hosting }).toEqual({
    submissions: 1,
    completed: true,
    releases: 0,
    hosting: true,
  });
});
it('keeps the certificate and endpoint after Host restart and reconnects the selected workspace', async () => {
  const f = await fixture();
  const { id, invitation } = await pair(f);
  await f.host.close();
  const next = new RemoteAccess(f.options);
  cleanup.push(() => next.close());
  await next.ready;
  const newLink = (await next.command({ type: 'invite' })).invitation!;
  const before = parseRemoteInvitation(invitation),
    after = parseRemoteInvitation(newLink);
  expect(after.certificate).toBe(before.certificate);
  expect(after.server).toBe(before.server);
  await expect.poll(() => f.client.state().hosts[0].state, { timeout: 10000 }).toBe('connected');
  expect(await f.client.request({ type: 'status' }, id)).toEqual(disconnected('ready'));
});
it('refuses a different TLS certificate before sending device authentication', async () => {
  const f = await fixture();
  const wrong = await generate([{ name: 'commonName', value: 'synthetic-other-host' }], {
    algorithm: 'sha256',
    keyType: 'ec',
    curve: 'P-256',
  });
  const keys = await RemoteKeys.open(path.join(f.root, 'other'), 'Synthetic other');
  const signal = new SignalConnection({
    server: f.host.state().server,
    certificate: wrong.cert,
    keys,
    signal: vi.fn(),
  });
  cleanup.push(async () => signal.close());
  await expect(signal.start()).rejects.toThrow('REMOTE_SIGNAL_UNAVAILABLE');
  expect(signal.connected).toBe(false);
});
it('denies a revoked device without replaying a task or waiting for a connection timeout', async () => {
  const f = await fixture();
  const { id } = await pair(f);
  await f.host.command({ type: 'revoke', device: f.client.state().identity.id });
  await f.client.command({ type: 'select', host: null });
  const outcome = f.client.request({ type: 'status' }, id).then(
    () => 'UNEXPECTED_SUCCESS',
    (error) => error.message as string,
  );
  expect(
    await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve('NO_REJECTION'), 1000)),
    ]),
  ).toBe('REMOTE_UNAUTHORIZED');
  expect(f.work.submissions).toBe(0);
  await f.client.command({ type: 'select', host: null });
});

it('releases held input when the controller socket disappears without a session close', async () => {
  const f = await fixture();
  const { id, invitation } = await pair(f);
  await f.client.request(
    {
      type: 'control',
      bot: 'synthetic-bot',
      epoch: 0,
      instance: 'synthetic-instance',
      owner: 'human',
    },
    id,
  );
  const keys = await RemoteKeys.open(path.join(f.root, 'client'), 'Synthetic replacement');
  const link = parseRemoteInvitation(invitation);
  const replacement = new SignalConnection({
    server: link.server,
    certificate: link.certificate,
    keys,
    signal: () => {},
  });
  cleanup.push(async () => replacement.close());
  await replacement.start();
  await expect.poll(() => f.work.releases, { timeout: 1500 }).toBe(1);
});
it('accepts an explicitly re-copied link after TLS certificate replacement', async () => {
  const f = await fixture();
  const { invitation } = await pair(f);
  await f.client.command({ type: 'select', host: null });
  await f.host.close();
  await import('node:fs/promises').then((fs) =>
    fs.unlink(path.join(f.root, 'host/lan-identity.json')),
  );
  const next = new RemoteAccess(f.options);
  cleanup.push(() => next.close());
  await next.ready;
  const fresh = (await next.command({ type: 'invite' })).invitation!;
  expect(parseRemoteInvitation(fresh).certificate).not.toBe(
    parseRemoteInvitation(invitation).certificate,
  );
  const joining = f.client.command({ type: 'pair', invitation: fresh });
  const checked = joining.then(
    () => 'paired',
    () => 'failed',
  );
  await expect.poll(() => next.state().pending.length, { timeout: 1500 }).toBe(1);
  await next.command({ type: 'approve', id: next.state().pending[0].id, accepted: true });
  expect(await checked).toBe('paired');
});
