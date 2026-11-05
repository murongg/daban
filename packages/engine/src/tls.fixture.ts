import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export async function tlsFixture(
  reply: (req: IncomingMessage, res: ServerResponse) => unknown,
  hostname = 'mcp.example.test',
) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-mcp-tls-'));
  const key = path.join(root, 'key.pem'),
    cert = path.join(root, 'cert.pem'),
    config = path.join(root, 'openssl.cnf');
  try {
    // OpenSSL 1.1 appends -addext to default v3_ca settings, producing invalid duplicate extensions.
    await writeFile(config, '[req]\ndistinguished_name=subject\n[subject]\n');
    await promisify(execFile)('openssl', [
      'req',
      '-config',
      config,
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      `/CN=${hostname}`,
      '-addext',
      `subjectAltName=DNS:${hostname}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    const ca = await readFile(cert);
    const server = createServer({ key: await readFile(key), cert: ca }, reply);
    await new Promise<unknown>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic TLS listener missing');
    const port = address.port;
    return {
      server,
      endpoint: `https://${hostname}:${port}/mcp?key=synthetic-url-secret`,
      ca,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      dial: async (_address: string, _port: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        return await new Promise<ReturnType<typeof connect>>((resolve, reject) => {
          const socket = connect({ host: '127.0.0.1', port });
          socket.once('error', reject);
          socket.once('connect', () => resolve(socket));
        });
      },
      close: async () => {
        server.closeAllConnections();
        await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
