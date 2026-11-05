import { createPrivateKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { type RemoteIdentity, remoteLanServer } from '@daban/protocol';
import { generate } from 'selfsigned';
import { startLanSignal } from './lan-server.js';
import { PairingHost } from './pairing.js';
import { privateMetadata, secureDirectory } from './private-files.js';

interface Identity {
  certificate: string;
  privateKey: string;
}
async function identity(directory: string, owner: string): Promise<Identity> {
  await secureDirectory(directory);
  const file = path.join(directory, 'lan-identity.json');
  try {
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const pems = await generate([{ name: 'commonName', value: owner }], {
        algorithm: 'sha256',
        keyType: 'ec',
        curve: 'P-256',
        extensions: [{ name: 'extKeyUsage', serverAuth: true }],
      });
      await handle.writeFile(JSON.stringify({ certificate: pems.cert, privateKey: pems.private }));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
      throw error;
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 32768 ||
      !(await privateMetadata(file, info, 0o600))
    )
      throw Error('REMOTE_LAN_IDENTITY_UNSAFE');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('certificate' in value) ||
      !('privateKey' in value) ||
      typeof value.certificate !== 'string' ||
      typeof value.privateKey !== 'string'
    )
      throw Error('REMOTE_LAN_IDENTITY_UNSAFE');
    const certificate = new X509Certificate(value.certificate);
    if (
      certificate.subject !== `CN=${owner}` ||
      !certificate.checkPrivateKey(createPrivateKey(value.privateKey)) ||
      Date.parse(certificate.validTo) <= Date.now()
    )
      throw Error('REMOTE_LAN_IDENTITY_UNSAFE');
    return { certificate: value.certificate, privateKey: value.privateKey };
  } finally {
    await handle.close();
  }
}

export async function startLan(directory: string, owner: RemoteIdentity, preferredPort = 0) {
  const addresses = [
    ...new Set(
      Object.values(networkInterfaces())
        .flatMap((items) => items ?? [])
        .filter(
          (item) =>
            !item.internal && item.family === 'IPv4' && remoteLanServer(`https://${item.address}`),
        )
        .map((item) => item.address),
    ),
  ].slice(0, 8);
  if (!addresses.length) throw Error('REMOTE_LAN_NETWORK_UNAVAILABLE');
  const keys = await identity(directory, owner.id);
  const pairing = new PairingHost({ host: owner, certificate: keys.certificate });
  const service = await startLanSignal({
    port: preferredPort,
    tls: { key: keys.privateKey, cert: keys.certificate },
    owner: owner.id,
    pairing,
  });
  return {
    certificate: keys.certificate,
    origins: addresses.map((address) => `https://${address}:${service.port}`),
    port: service.port,
    pairing,
    async close() {
      pairing.stop();
      await service.close();
    },
  };
}
