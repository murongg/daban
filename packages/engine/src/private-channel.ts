import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createServer as httpServer, type RequestListener } from 'node:http';
import { createServer as httpsServer, type RequestOptions } from 'node:https';
import path from 'node:path';
import { privateMetadata, secureDirectory } from './private-files.js';

export async function privateServer(
  listener: RequestListener,
  certificateFile?: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== 'win32') return { server: httpServer(listener), publish: async () => {} };
  if (!certificateFile || !path.isAbsolute(certificateFile))
    throw new Error('PRIVATE_CHANNEL_CONFIG');
  const { generate } = await import('selfsigned');
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    keyType: 'ec',
    curve: 'P-256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  const server = httpsServer(
    { minVersion: 'TLSv1.2', key: pems.private, cert: pems.cert },
    listener,
  );
  return {
    server,
    async publish() {
      // Publish the public certificate only after binding; a duplicate process must not replace a live server's pin.
      if (!server.listening) throw new Error('PRIVATE_CHANNEL_NOT_LISTENING');
      const directory = path.dirname(certificateFile);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !(await privateMetadata(directory, info, 0o700))
      )
        throw new Error('PRIVATE_CHANNEL_UNSAFE');
      const temporary = path.join(directory, `.certificate-${randomUUID()}`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(pems.cert);
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, certificateFile);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
  };
}
export async function privateClientOptions(
  certificateFile?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<RequestOptions> {
  if (platform !== 'win32') return { agent: false };
  if (!certificateFile || !path.isAbsolute(certificateFile))
    throw new Error('PRIVATE_CHANNEL_CONFIG');
  const parent = path.dirname(certificateFile);
  if (!(await privateMetadata(parent, await lstat(parent), 0o700))) await secureDirectory(parent);
  const file = await open(certificateFile, 'r');
  try {
    const info = await file.stat(),
      named = await lstat(certificateFile);
    if (
      !info.isFile() ||
      info.size > 16384 ||
      named.isSymbolicLink() ||
      named.ino !== info.ino ||
      named.dev !== info.dev ||
      !(await privateMetadata(certificateFile, info, 0o600))
    )
      throw new Error('PRIVATE_CHANNEL_UNSAFE');
    const ca = await file.readFile('utf8');
    // An isolated trust store pins this service's ephemeral certificate. Authenticate before sending tokens or task content.
    return {
      agent: false,
      minVersion: 'TLSv1.2',
      ca,
      servername: 'localhost',
      rejectUnauthorized: true,
    };
  } finally {
    await file.close();
  }
}
export function windowsPrivatePipe(value: string) {
  const prefix = '\\\\.\\pipe\\';
  return (
    value.startsWith(prefix) &&
    /^daban-(?:local|agent)-[a-f0-9-]{8,80}$/.test(value.slice(prefix.length))
  );
}
