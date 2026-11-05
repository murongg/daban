import { createHash, generateKeyPairSync } from 'node:crypto';
import { generate } from 'selfsigned';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { decodeEndpoint, encodeEndpoint, LanDiscovery } from './lan-discovery.js';
import type { PairingEndpoint } from './pairing.js';

interface FakeSocket {
  config?: unknown;
  up?: (value: unknown) => unknown;
  closed: boolean;
  stopped: boolean;
}
const mocks = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));
vi.mock('bonjour-service', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class {
      private socket: FakeSocket = { closed: false, stopped: false };
      constructor() {
        mocks.sockets.push(this.socket);
      }
      publish(config: unknown) {
        this.socket.config = config;
        const service = new EventEmitter();
        queueMicrotask(() => service.emit('up'));
        return service;
      }
      find(_options: unknown, up: (value: unknown) => unknown) {
        this.socket.up = up;
        return {
          stop: () => {
            this.socket.stopped = true;
          },
        };
      }
      unpublishAll(done: () => unknown) {
        done();
      }
      destroy(done: () => unknown) {
        this.socket.closed = true;
        done();
      }
    },
  };
});
let endpoint: PairingEndpoint;
beforeAll(async () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const id = createHash('sha256').update(key).digest('hex');
  const pems = await generate([{ name: 'commonName', value: id }], {
    algorithm: 'sha256',
    keyType: 'ec',
    curve: 'P-256',
  });
  endpoint = {
    host: { id, publicKey: key.toString('base64url'), name: 'Synthetic LAN computer' },
    server: 'https://192.168.40.2:45678',
    certificate: pems.cert,
  };
});
afterEach(() => {
  vi.useRealTimers();
  mocks.sockets.splice(0);
});
it('advertises only bounded public metadata, even when passed an internal invitation', () => {
  const txt = encodeEndpoint({ ...endpoint, code: 'SYNTHETIC-PRIVATE-INVITATION' });
  expect(Object.values(txt).every((value) => Buffer.byteLength(value) < 255)).toBe(true);
  const decoded = decodeEndpoint(txt);
  expect(decoded).toEqual(endpoint);
  expect(decoded).not.toHaveProperty('code');
  expect(decodeEndpoint({ ...txt, d0: '%%%invalid' })).toBeUndefined();
  expect(decodeEndpoint({ ...txt, count: '999' })).toBeUndefined();
});
it('rejects public addresses, mismatched identities, and invalid TLS metadata', () => {
  for (const invalid of [
    { ...endpoint, server: 'https://example.test:443' },
    { ...endpoint, certificate: 'SYNTHETIC INVALID CERTIFICATE' },
    { ...endpoint, host: { ...endpoint.host, id: 'a'.repeat(64) } },
  ])
    expect(() => encodeEndpoint(invalid)).toThrow('REMOTE_DISCOVERY_INVALID');
});
it('deduplicates candidates and closes its browsing socket after the discovery deadline', async () => {
  vi.useFakeTimers();
  const discovery = new LanDiscovery();
  const result = discovery.find();
  const socket = mocks.sockets[0];
  const service = {
    txt: encodeEndpoint(endpoint),
    port: 45678,
    referer: { address: '192.168.40.2' },
  };
  socket.up?.(service);
  socket.up?.(service);
  socket.up?.({ ...service, referer: { address: '8.8.8.8' } });
  await vi.advanceTimersByTimeAsync(2500);
  expect(await result).toEqual([endpoint]);
  expect(socket.closed && socket.stopped).toBe(true);
  await discovery.close();
});
it('withdraws the previous publication when publishing a refreshed code or closing', async () => {
  const discovery = new LanDiscovery();
  await discovery.publish(endpoint);
  await discovery.publish(endpoint);
  expect(mocks.sockets[0].closed).toBe(true);
  expect(mocks.sockets[1].closed).toBe(false);
  await discovery.close();
  expect(mocks.sockets.every((socket) => socket.closed)).toBe(true);
});
