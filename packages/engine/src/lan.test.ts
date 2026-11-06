import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { disconnected, type RemotePeerPort } from '@daban/protocol';
import { generate } from 'selfsigned';
import { afterEach, expect, it, vi } from 'vitest';
import type { Discovery } from './lan-discovery.js';
import type { PairingEndpoint } from './pairing.js';
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
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomInt: () => 123456,
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'daban-lan-synthetic-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const offers = new Map<string, PairingEndpoint>();
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
    discovery: discovery(),
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
    discovery: discovery(),
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
  return { root, host, client, options, peer, work, job, finish, offers, discovery };
}
async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  const code = (await f.host.command({ type: 'invite' })).pairingCode!.code;
  const endpoint = f.offers.get(f.host.state().identity.id)!;
  const joining = f.client.command({ type: 'pair', code });
  await expect.poll(() => f.host.state().pending.length).toBe(1);
  await f.host.command({ type: 'approve', id: f.host.state().pending[0].id, accepted: true });
  await joining;
  const id = f.host.state().identity.id;
  await f.client.command({ type: 'select', host: id });
  return { id, endpoint, code };
}

it('issues an expiring six-digit code for pairing without exposing a link', async () => {
  const f = await fixture();
  const state = await f.host.command({ type: 'invite' });
  expect(state).toMatchObject({ pairingCode: { code: expect.stringMatching(/^\d{6}$/) } });
});
it('withdraws discovery when hosting is stopped during code generation', async () => {
  const f = await fixture();
  let release = () => {};
  const paused = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const publish = f.options.discovery.publish.bind(f.options.discovery);
  const publishing = vi.spyOn(f.options.discovery, 'publish').mockImplementation(async (value) => {
    await paused;
    await publish(value);
  });
  const generating = f.host.command({ type: 'invite' });
  await expect.poll(() => publishing.mock.calls.length).toBe(1);
  const stopping = f.host.command({ type: 'host', enabled: false });
  await new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)));
  release();
  await Promise.all([generating, stopping]);
  expect(f.host.state().hosting).toBe(false);
  expect(f.offers.size).toBe(0);
});
it('rejects a wrong code before asking for approval or recording a device', async () => {
  const f = await fixture();
  await f.host.command({ type: 'invite' });
  await expect(f.client.command({ type: 'pair', code: '000000' })).rejects.toThrow(
    'REMOTE_CODE_NOT_FOUND',
  );
  expect(f.host.state().pending).toHaveLength(0);
  expect(f.client.state().hosts).toHaveLength(0);
});
it('distinguishes no discovered hosts from a rejected pairing code', async () => {
  const f = await fixture();
  await expect(f.client.command({ type: 'pair', code: '123456' })).rejects.toThrow(
    'REMOTE_DISCOVERY_EMPTY',
  );
});
it('distinguishes an unreachable advertised service from a rejected pairing code', async () => {
  const f = await fixture();
  await f.host.command({ type: 'invite' });
  const id = f.host.state().identity.id;
  const stale = f.offers.get(id)!;
  await f.host.close();
  f.offers.set(id, stale);
  await expect(f.client.command({ type: 'pair', code: '123456' })).rejects.toThrow(
    'REMOTE_CODE_UNREACHABLE',
  );
});
it('rejects ambiguous code matches rather than choosing another computer silently', async () => {
  const f = await fixture();
  const other = new RemoteAccess({
    ...f.options,
    directory: path.join(f.root, 'other'),
    discovery: f.discovery(),
  });
  cleanup.push(() => other.close());
  await other.ready;
  await other.command({ type: 'host', enabled: true });
  await other.command({ type: 'invite' });
  await f.host.command({ type: 'invite' });
  await expect(f.client.command({ type: 'pair', code: '123456' })).rejects.toThrow(
    'REMOTE_CODE_AMBIGUOUS',
  );
  expect(f.host.state().pending).toHaveLength(0);
  expect(other.state().pending).toHaveLength(0);
});

it('pairs through its own pinned TLS service and executes without SSH, TURN or a browser peer', async () => {
  const f = await fixture();
  const { id, endpoint } = await pair(f);
  expect(endpoint).toMatchObject({
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
  const { id, endpoint } = await pair(f);
  await f.host.close();
  const next = new RemoteAccess(f.options);
  cleanup.push(() => next.close());
  await next.ready;
  await next.command({ type: 'invite' });
  const after = f.offers.get(next.state().identity.id)!;
  expect(after.certificate).toBe(endpoint.certificate);
  expect(after.server).toBe(endpoint.server);
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
  const { id, endpoint } = await pair(f);
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
  const replacement = new SignalConnection({
    server: endpoint.server,
    certificate: endpoint.certificate,
    keys,
    signal: () => {},
  });
  cleanup.push(async () => replacement.close());
  await replacement.start();
  await expect.poll(() => f.work.releases, { timeout: 1500 }).toBe(1);
});
it('accepts a fresh code after TLS certificate replacement', async () => {
  const f = await fixture();
  const { endpoint } = await pair(f);
  await f.client.command({ type: 'select', host: null });
  await f.host.close();
  await import('node:fs/promises').then((fs) =>
    fs.unlink(path.join(f.root, 'host/lan-identity.json')),
  );
  const next = new RemoteAccess(f.options);
  cleanup.push(() => next.close());
  await next.ready;
  const fresh = (await next.command({ type: 'invite' })).pairingCode!.code;
  expect(f.offers.get(next.state().identity.id)!.certificate).not.toBe(endpoint.certificate);
  const joining = f.client.command({ type: 'pair', code: fresh });
  const checked = joining.then(
    () => 'paired',
    () => 'failed',
  );
  await expect.poll(() => next.state().pending.length, { timeout: 1500 }).toBe(1);
  await next.command({ type: 'approve', id: next.state().pending[0].id, accepted: true });
  expect(await checked).toBe('paired');
});
