import { X509Certificate } from 'node:crypto';
import { isRemoteCertificate, remoteLanServer, remoteServer } from '@daban/protocol';
import Bonjour from 'bonjour-service';
import type { PairingEndpoint } from './pairing.js';
import { validRemoteIdentity } from './remote-crypto.js';

export interface Discovery {
  publish(endpoint: PairingEndpoint): Promise<unknown>;
  find(): Promise<PairingEndpoint[]>;
  unpublish(): Promise<unknown>;
  close(): Promise<unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function endpoint(value: unknown): PairingEndpoint | undefined {
  if (
    !record(value) ||
    !validRemoteIdentity(value.host) ||
    typeof value.server !== 'string' ||
    !isRemoteCertificate(value.certificate)
  )
    return undefined;
  try {
    if (remoteServer(value.server) !== value.server) return undefined;
    const cert = new X509Certificate(value.certificate);
    if (cert.subject !== `CN=${value.host.id}` || Date.parse(cert.validTo) <= Date.now())
      return undefined;
    const alternatives = value.alternatives;
    if (
      alternatives !== undefined &&
      (!Array.isArray(alternatives) ||
        alternatives.length > 8 ||
        !alternatives.every((item) => typeof item === 'string' && remoteLanServer(item)))
    )
      return undefined;
    return {
      host: value.host,
      server: value.server,
      certificate: value.certificate,
      ...(alternatives === undefined ? {} : { alternatives: alternatives as string[] }),
    };
  } catch {
    return undefined;
  }
}
export function encodeEndpoint(value: unknown) {
  const publicData = endpoint(value);
  if (!publicData) throw Error('REMOTE_DISCOVERY_INVALID');
  // Serialize a whitelist: callers may hold an invitation containing the private pairing secret.
  const text = Buffer.from(JSON.stringify(publicData)).toString('base64url');
  const chunks = text.match(/.{1,180}/g) ?? [];
  if (chunks.length > 16) throw Error('REMOTE_DISCOVERY_INVALID');
  const txt: Record<string, string> = { version: '1', count: String(chunks.length) };
  chunks.forEach((chunk, index) => {
    txt[`d${index}`] = chunk;
  });
  return txt;
}
export function decodeEndpoint(value: unknown) {
  if (
    !record(value) ||
    value.version !== '1' ||
    typeof value.count !== 'string' ||
    !/^(?:[1-9]|1[0-6])$/.test(value.count)
  )
    return undefined;
  const count = Number(value.count);
  if (Object.keys(value).length !== count + 2) return undefined;
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = value[`d${i}`];
    if (typeof chunk !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(chunk)) return undefined;
    chunks.push(chunk);
  }
  try {
    return endpoint(JSON.parse(Buffer.from(chunks.join(''), 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
}
export class LanDiscovery implements Discovery {
  private publisher?: Bonjour;
  private readonly searches = new Map<() => unknown, Promise<PairingEndpoint[]>>();
  async publish(value: PairingEndpoint) {
    await this.unpublish();
    const txt = encodeEndpoint(value);
    let bonjour: Bonjour | undefined;
    try {
      await new Promise<undefined>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('REMOTE_DISCOVERY_UNAVAILABLE')), 4000);
        const failed = () => {
          clearTimeout(timer);
          reject(Error('REMOTE_DISCOVERY_UNAVAILABLE'));
        };
        bonjour = new Bonjour({}, failed);
        const service = bonjour.publish({
          name: `Daban-${value.host.id.slice(0, 24)}`,
          type: 'daban',
          host: `daban-${value.host.id.slice(0, 24)}.local`,
          port: Number(new URL(value.server).port),
          txt,
          disableIPv6: true,
        });
        service.once('up', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        service.on('error', failed);
      });
      this.publisher = bonjour;
    } catch (error) {
      if (bonjour)
        await new Promise<undefined>((resolve) => bonjour!.destroy(() => resolve(undefined)));
      throw error;
    }
  }
  async unpublish() {
    // This computer can host and connect at once; withdrawing its code must leave controller searches running.
    const previous = this.publisher;
    this.publisher = undefined;
    if (previous)
      await new Promise<undefined>((resolve) =>
        previous.unpublishAll(() => previous.destroy(() => resolve(undefined))),
      );
  }
  find() {
    let cancel = () => {};
    const result = new Promise<PairingEndpoint[]>((resolve, reject) => {
      const found = new Map<string, PairingEndpoint>();
      let bonjour: Bonjour | undefined;
      let browser: Bonjour.Browser | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        browser?.stop();
        const done = () => (error ? reject(error) : resolve([...found.values()]));
        if (bonjour) bonjour.destroy(done);
        else done();
      };
      const timer = setTimeout(() => finish(), 2500);
      cancel = () => finish(Error('REMOTE_CONNECTION_CLOSED'));
      try {
        bonjour = new Bonjour({}, () => finish(Error('REMOTE_DISCOVERY_UNAVAILABLE')));
        browser = bonjour.find({ type: 'daban' }, (service) => {
          if (
            settled ||
            found.size >= 8 ||
            (service.referer && !remoteLanServer(`https://${service.referer.address}`))
          )
            return;
          const value = decodeEndpoint(service.txt);
          if (!value || Number(new URL(value.server).port) !== service.port) return;
          const origins = [value.server, ...(value.alternatives ?? [])];
          const reachable = origins.find(
            (origin) => new URL(origin).hostname === service.referer?.address,
          );
          found.set(
            value.host.id,
            reachable && reachable !== value.server
              ? {
                  ...value,
                  server: reachable,
                  alternatives: origins.filter((origin) => origin !== reachable),
                }
              : value,
          );
        });
      } catch {
        finish(Error('REMOTE_DISCOVERY_UNAVAILABLE'));
      }
    }).finally(() => this.searches.delete(cancel));
    this.searches.set(cancel, result);
    return result;
  }
  async close() {
    const pending = [...this.searches.values()];
    for (const cancel of this.searches.keys()) cancel();
    await Promise.allSettled(pending);
    await this.unpublish();
  }
}
