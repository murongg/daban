import { createServer as httpServer, type RequestListener } from 'node:http';
import { createServer as httpsServer, type RequestOptions } from 'node:https';
import type { ConnectionOptions } from 'node:tls';

const cipher = 'PSK-AES256-GCM-SHA384';
export function privateServer(
  listener: RequestListener,
  resolve: (identity: string) => string | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'win32') return httpServer(listener);
  return httpsServer(
    {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      ciphers: cipher,
      pskCallback(_socket, identity) {
        const key = resolve(identity);
        return key && /^[a-f0-9]{64}$/.test(key) ? Buffer.from(key, 'hex') : null;
      },
    },
    listener,
  );
}
export function privateClientOptions(
  key: string,
  identity: string,
  platform: NodeJS.Platform = process.platform,
): RequestOptions & Pick<ConnectionOptions, 'pskCallback'> {
  if (platform !== 'win32') return { agent: false };
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('PRIVATE_CHANNEL_KEY_INVALID');
  return {
    agent: false,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    ciphers: cipher,
    // TLS-PSK authenticates with the private key instead of an X.509 certificate. No non-PSK suite is enabled.
    rejectUnauthorized: false,
    pskCallback: () => ({ identity, psk: Buffer.from(key, 'hex') }),
  };
}

export function windowsPrivatePipe(value: string) {
  const prefix = '\\\\.\\pipe\\';
  return (
    value.startsWith(prefix) &&
    /^daban-(?:local|agent)-[a-f0-9-]{8,80}$/.test(value.slice(prefix.length))
  );
}
