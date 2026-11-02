import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Fault } from './control.js';
import { fallbackLookup } from './dns.js';

const private4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  private4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const private6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  private6.addSubnet(address, prefix, 'ipv6');
export function publicAddress(ip: string) {
  if (isIP(ip) === 4) return !private4.check(ip, 'ipv4');
  return isIP(ip) === 6 && global6.check(ip, 'ipv6') && !private6.check(ip, 'ipv6');
}
const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
const authority = (address: string, port: number) =>
  `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;

async function direct(address: string, port: number, signal: AbortSignal): Promise<Duplex> {
  signal.throwIfAborted();
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: address, port });
    const cancel = () => socket.destroy(new Error('BROWSER_CONNECTION_CANCELLED'));
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('error', (error) => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    socket.once('connect', () => {
      signal.removeEventListener('abort', cancel);
      resolve(socket);
    });
  });
}
async function through(
  upstream: URL,
  address: string,
  port: number,
  signal: AbortSignal,
): Promise<Duplex> {
  signal.throwIfAborted();
  return await new Promise<Duplex>((resolve, reject) => {
    const credentials =
      upstream.username || upstream.password
        ? Buffer.from(
            `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`,
          ).toString('base64')
        : undefined;
    const target = authority(address, port);
    const req = (upstream.protocol === 'https:' ? secureRequest : request)({
      hostname: hostname(upstream),
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: target,
      headers: {
        host: target,
        ...(credentials ? { 'proxy-authorization': `Basic ${credentials}` } : {}),
      },
      agent: false,
    });
    const cancel = () => req.destroy(new Error('BROWSER_CONNECTION_CANCELLED'));
    signal.addEventListener('abort', cancel, { once: true });
    req.once('error', (error) => {
      signal.removeEventListener('abort', cancel);
      reject(error);
    });
    req.once('connect', (response, socket, head) => {
      signal.removeEventListener('abort', cancel);
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error('BROWSER_UPSTREAM_UNAVAILABLE'));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}

export async function resolvePublic(
  host: string,
  signal: AbortSignal,
  resolve: (
    host: string,
    options: { all: true; order: 'verbatim' },
  ) => Promise<LookupAddress[]> = lookup,
) {
  signal.throwIfAborted();
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await fallbackLookup(host, signal, resolve, fetch, publicAddress);
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address) || isIP(entry.address) !== entry.family)
  )
    throw new Fault('NETWORK_BLOCKED', 403);
  return addresses;
}
export function dialAddress(
  address: string,
  port: number,
  signal: AbortSignal,
  upstream?: URL,
): Promise<Duplex> {
  return upstream ? through(upstream, address, port, signal) : direct(address, port, signal);
}
